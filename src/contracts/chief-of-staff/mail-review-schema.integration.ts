import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { connectFixtureDatabase, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import { mailReviewSchedulePolicy } from '../../modules/chief-of-staff/automation/mail-review-policy.js';
import type { MailReviewBinding } from '../../modules/chief-of-staff/automation/mail-review-binding.js';

test('G06 migration preserves the generic schedule and admits only two owner-bound mail-review slots', async (t) => {
  assert.equal(process.env.COS_FIXTURE_DATABASE_PROFILE, 'test');
  const admin = await connectFixtureDatabase(process.env, 'migration');
  const runtime = await connectFixtureDatabase(process.env, 'runtime');
  const scope = 'g06-schema-' + randomUUID();
  try {
    assert.equal(await migrate(admin, fixtureRuntimeUser()), 21);
    await admin.query('BEGIN');
    await admin.query(
      "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'owner',$1,$1,$1,'active')",
      [scope],
    );
    assert.equal(
      (await admin.query('SELECT count(*)::int AS count FROM cos.mail_review_policies WHERE scope_id=$1', [scope]))
        .rows[0].count,
      0,
    );
    const reader = randomUUID(),
      writer = randomUUID(),
      policy = randomUUID();
    await admin.query(
      `INSERT INTO cos.mail_bindings(scope_id,id,provider,mailbox_email,permission_scopes,processing_providers,auth,provenance)
       VALUES($1,$2,'fixture','owner@example.test',ARRAY['https://www.googleapis.com/auth/gmail.readonly'],ARRAY['codex'],'ready','{}')`,
      [scope, reader],
    );
    await admin.query(
      "INSERT INTO cos.mail_draft_writer_bindings(scope_id,id,reader_binding_id,owner_id,session_id,version,state) VALUES($1,$2,$3,'owner','session',1,'enabled')",
      [scope, writer, reader],
    );
    const writerBody = {
      format: 'cos-mail-draft-binding/v1',
      provider: 'fixture',
      readerBindingId: reader,
      mailboxDigest: digest('owner@example.test'),
      writerClientDigest: digest('writer'),
      readerClientDigest: digest('reader'),
      credentialReference: randomUUID(),
      nativeBindingDigest: digest('native'),
      journalGeneration: randomUUID(),
      maxPerDay: 5,
      timeZone: 'Australia/Sydney',
      replyMode: 'plain_text_reply',
      permissionScopes: ['https://www.googleapis.com/auth/gmail.compose'],
      recoveryProofDigest: digest('fixture recovery'),
    };
    const consent = digest('fixture consent');
    await admin.query(
      'INSERT INTO cos.mail_draft_writer_revisions(scope_id,binding_id,version,body,digest,consent_ref) VALUES($1,$2,1,$3,$4,$5)',
      [scope, writer, JSON.stringify(writerBody), digest(writerBody), consent],
    );
    const binding: MailReviewBinding = {
      format: 'cos-mail-review-binding/v1',
      provider: 'fixture',
      readerBindingId: reader,
      writerBindingId: writer,
      writerVersion: 1,
      writerDigest: digest(writerBody),
      writerConsentRef: consent,
      nativeBindingDigest: digest('native'),
      mailboxDigest: digest('owner@example.test'),
      contextGeneration: randomUUID(),
      morningScheduleId: randomUUID(),
      afternoonScheduleId: randomUUID(),
      timeZone: 'Australia/Sydney',
      maxCandidateThreads: 10,
      maxModelAttempts: 3,
      maxDraftsPerDay: 5,
    };
    await admin.query(
      "INSERT INTO cos.mail_review_policies(scope_id,id,owner_id,session_id,agent_group_id,version,state) VALUES($1,$2,'owner','session',$1,1,'enabled')",
      [scope, policy],
    );
    const revision = async (body: unknown, version = 1) =>
      admin.query(
        `INSERT INTO cos.mail_review_policy_revisions(scope_id,binding_id,version,reader_binding_id,writer_binding_id,writer_version,body,digest,owner_config_ref)
       VALUES($1,$2,$3,$4,$5,1,$6,$7,$8)`,
        [scope, policy, version, reader, writer, JSON.stringify(body), digest(body), digest('owner configuration')],
      );
    await revision(binding);
    const rejected = async (operation: () => Promise<unknown>, code: string) => {
      await admin.query('SAVEPOINT rejected_case');
      try {
        await assert.rejects(operation, (error: { code?: string }) => error.code === code);
      } finally {
        await admin.query('ROLLBACK TO SAVEPOINT rejected_case');
        await admin.query('RELEASE SAVEPOINT rejected_case');
      }
    };
    const limits = { max_turns: 3, max_tool_calls: 16, deadline_seconds: 300, refresh_seconds: 30 };
    const schedule = (id: string, purpose = 'brief', slot: string | null = null, time?: string, maxTurns = 3) =>
      admin.query(
        `INSERT INTO cos.brief_schedules(scope_id,id,owner_id,session_id,agent_group_id,title,policy,limits,version,provenance,purpose,mail_review_policy_id,mail_review_policy_version,mail_review_slot)
         VALUES($1,$2,'owner','session',$1,'Fixture review',$3,$4,1,'{}',$5,$6,$7,$8)`,
        [
          scope,
          id,
          JSON.stringify({
            ...mailReviewSchedulePolicy(slot === 'afternoon' ? 'afternoon' : 'morning'),
            ...(time ? { local_time: time } : {}),
          }),
          JSON.stringify({ ...limits, max_turns: maxTurns }),
          purpose,
          purpose === 'mail_review' ? policy : null,
          purpose === 'mail_review' ? 1 : null,
          slot,
        ],
      );
    await schedule(randomUUID());
    await schedule(binding.morningScheduleId, 'mail_review', 'morning');
    await schedule(binding.afternoonScheduleId, 'mail_review', 'afternoon');
    await t.test('keeps one generic schedule and two mail slots', async () => {
      assert.equal(
        (await admin.query('SELECT count(*)::int AS count FROM cos.brief_schedules WHERE scope_id=$1', [scope])).rows[0]
          .count,
        3,
      );
      await rejected(() => schedule(randomUUID()), '23505');
      await rejected(() => schedule(randomUUID(), 'mail_review', 'morning'), '23505');
      await rejected(() => schedule(randomUUID(), 'mail_review', 'night'), '23514');
    });
    await t.test('refuses widened model budgets, altered times and policy bodies', async () => {
      await rejected(() => schedule(randomUUID(), 'mail_review', 'morning', '09:00'), '23514');
      await rejected(() => schedule(randomUUID(), 'mail_review', 'morning', undefined, 4), '23514');
      await rejected(() => revision({ ...binding, maxModelAttempts: 4 }, 2), '23514');
      await rejected(() => revision({ ...binding, sendEnabled: true }, 2), '23514');
    });
    await t.test('allows owner-administration provenance without forging a chat proposal', async () => {
      await admin.query(
        `INSERT INTO cos.brief_schedule_revisions(scope_id,schedule_id,version,body,proposal_id,mail_review_policy_id,mail_review_policy_version)
         SELECT scope_id,id,version,to_jsonb(s),NULL,mail_review_policy_id,mail_review_policy_version FROM cos.brief_schedules s WHERE scope_id=$1 AND id=$2`,
        [scope, binding.morningScheduleId],
      );
    });
    await t.test('the runtime can read but cannot grant or alter review authority', async () => {
      const privileges = await runtime.query(
        `SELECT has_table_privilege(current_user,'cos.mail_review_policies','SELECT') AS can_read,
         has_table_privilege(current_user,'cos.mail_review_policies','INSERT') AS can_insert,
         has_table_privilege(current_user,'cos.mail_review_policies','UPDATE') AS can_update,
         has_table_privilege(current_user,'cos.mail_review_policy_revisions','DELETE') AS can_delete,
         has_table_privilege(current_user,'cos.mail_review_policy_revisions','TRUNCATE') AS can_truncate`,
      );
      assert.deepEqual(privileges.rows[0], {
        can_read: true,
        can_insert: false,
        can_update: false,
        can_delete: false,
        can_truncate: false,
      });
      await runtime.query('SELECT * FROM cos.mail_review_policies LIMIT 0');
    });
  } finally {
    await admin.query('ROLLBACK').catch(() => {});
    await Promise.allSettled([admin.end(), runtime.end()]);
  }
});
