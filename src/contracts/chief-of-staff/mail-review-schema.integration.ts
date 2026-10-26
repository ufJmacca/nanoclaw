import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { connectFixtureDatabase, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import { mailReviewSchedulePolicy } from '../../modules/chief-of-staff/automation/mail-review-policy.js';
import type { MailReviewBinding } from '../../modules/chief-of-staff/automation/mail-review-binding.js';
import type { MailReviewInputs } from '../../modules/chief-of-staff/automation/mail-review-inputs.js';
import { MailReviewAccess } from '../../modules/chief-of-staff/automation/mail-review-access.js';

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
    await t.test('scheduled access requires the live owner policy, native lease and frozen selection', async (t) => {
      const captureId = randomUUID(),
        runId = digest('review fixture run');
      const captured = new Date(Date.now() - 1000).toISOString();
      const inputs: MailReviewInputs = {
        format: 'cos-mail-review-inputs/v1',
        policy_id: policy,
        policy_version: 1,
        policy_digest: digest(binding),
        context_generation: binding.contextGeneration,
        reader_binding_id: reader,
        writer_binding_id: writer,
        capture_id: captureId,
        captured_at: captured,
        last_success_at: captured,
        coverage: 'stored_selection',
        excluded_threads: 0,
        unexamined_threads: 0,
        candidates: [
          {
            thread_id: 'aa01',
            source_message_id: 'bb01',
            source_id: 'fixture-source',
            source_version: 1,
            revision_id: randomUUID(),
            revision_digest: digest('fixture source'),
            internal_date_ms: Date.parse(captured),
            subject: 'Please review',
            reason: 'request',
          },
        ],
      };
      await admin.query(
        `INSERT INTO cos.mail_captures(scope_id,binding_id,id,binding_version,status,capture_window,content_digest,metadata,result)
        VALUES($1,$2,$3,1,'complete',$4,$5,'{}','{}')`,
        [
          scope,
          reader,
          captureId,
          JSON.stringify({ capturedAt: Date.parse(captured), since: Date.parse(captured) - 30 * 86400000 }),
          digest('capture'),
        ],
      );
      await admin.query(
        'INSERT INTO cos.mail_states(scope_id,binding_id,current_capture,last_success_at) VALUES($1,$2,$3,$4)',
        [scope, reader, captureId, captured],
      );
      await admin.query(
        `INSERT INTO cos.brief_runs(scope_id,id,schedule_id,schedule_version,owner_id,session_id,agent_group_id,
        intended_at,local_date,state,limits,model_calls,generation,lease_owner,lease_until,deadline_at,provenance,review_inputs)
        VALUES($1,$2,$3,1,'owner','session',$1,clock_timestamp(),CURRENT_DATE,'dispatched',$4,1,1,$5,
          clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '5 minutes','{}',$6)`,
        [
          scope,
          runId,
          binding.morningScheduleId,
          JSON.stringify(limits),
          'cos-native-' + binding.nativeBindingDigest,
          JSON.stringify(inputs),
        ],
      );
      const context = {
        scopeId: scope,
        ownerId: 'owner',
        sessionId: 'session',
        agentGroupId: scope,
        ingressId: `brief:${runId}:1`,
        provider: 'codex',
        generation: binding.contextGeneration,
        origin: { kind: 'schedule' as const, runId, generation: 1 },
      };
      const identity = { bindingDigest: binding.nativeBindingDigest, contextGeneration: binding.contextGeneration };
      let hostCurrent = true,
        nativeCurrent = true;
      const access = new MailReviewAccess({
        authority: () => (nativeCurrent ? identity : null),
        matches: () => hostCurrent,
      });
      assert.equal((await access.check(admin, context, 'read'))?.id, policy);
      assert.equal((await access.check(admin, context, 'draft', 'aa01'))?.inputs.candidates.length, 1);
      assert.equal(await access.check(admin, context, 'draft', 'aa02'), null);
      assert.equal(await access.check(admin, { ...context, origin: undefined }, 'read'), null);
      assert.equal(
        await access.check(admin, { ...context, origin: { ...context.origin, generation: 2 } }, 'read'),
        null,
      );
      assert.equal(await access.check(admin, { ...context, ownerId: 'another-owner' }, 'read'), null);
      assert.equal(await access.check(admin, { ...context, generation: randomUUID() }, 'read'), null);
      assert.equal(await access.check(admin, { ...context, provider: 'claude' }, 'read'), null);
      hostCurrent = false;
      assert.equal(await access.check(admin, context, 'read'), null);
      hostCurrent = true;
      nativeCurrent = false;
      assert.equal(await access.check(admin, context, 'read'), null);
      nativeCurrent = true;
      let identityReads = 0;
      const changingNative = new MailReviewAccess({
        authority: () => (++identityReads === 1 ? identity : null),
        matches: () => true,
      });
      assert.equal(await changingNative.check(admin, context, 'read'), null);
      const mutations: Array<[string, string, unknown[]]> = [
        ['revoked policy', "UPDATE cos.mail_review_policies SET state='revoked' WHERE scope_id=$1", [scope]],
        ['disabled writer', "UPDATE cos.mail_draft_writer_bindings SET state='disabled' WHERE scope_id=$1", [scope]],
        ['revoked reader', "UPDATE cos.mail_bindings SET auth='revoked' WHERE scope_id=$1", [scope]],
        [
          'paused schedule',
          "UPDATE cos.brief_schedules SET policy=jsonb_set(policy,'{state}','\"paused\"') WHERE scope_id=$1",
          [scope],
        ],
        [
          'expired deadline',
          "UPDATE cos.brief_runs SET deadline_at=clock_timestamp()-interval '1 second' WHERE scope_id=$1",
          [scope],
        ],
        [
          'expired lease',
          "UPDATE cos.brief_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE scope_id=$1",
          [scope],
        ],
        ['another native host', "UPDATE cos.brief_runs SET lease_owner='other-host' WHERE scope_id=$1", [scope]],
        ['terminal run', "UPDATE cos.brief_runs SET state='delivered' WHERE scope_id=$1", [scope]],
        ['widened model count', 'UPDATE cos.brief_runs SET model_calls=4 WHERE scope_id=$1', [scope]],
        ['widened tool count', 'UPDATE cos.brief_runs SET tool_calls=17 WHERE scope_id=$1', [scope]],
        [
          'different policy digest',
          "UPDATE cos.brief_runs SET review_inputs=jsonb_set(review_inputs,'{policy_digest}',to_jsonb($2::text)) WHERE scope_id=$1",
          [scope, digest('other policy')],
        ],
        ['missing selection', 'UPDATE cos.brief_runs SET review_inputs=NULL WHERE scope_id=$1', [scope]],
        [
          'eleventh candidate thread',
          'UPDATE cos.brief_runs SET review_inputs=$2 WHERE scope_id=$1',
          [
            scope,
            JSON.stringify({
              ...inputs,
              candidates: Array.from({ length: 11 }, (_, i) => ({
                ...inputs.candidates[0],
                thread_id: (i + 1).toString(16),
              })),
            }),
          ],
        ],
        ['no longer current capture', 'UPDATE cos.mail_states SET current_capture=NULL WHERE scope_id=$1', [scope]],
      ];
      for (const [label, sql, values] of mutations)
        await t.test(label, async () => {
          await admin.query('SAVEPOINT access_denied');
          try {
            await admin.query(sql, values);
            assert.equal(await access.check(admin, context, 'read'), null);
          } finally {
            await admin.query('ROLLBACK TO SAVEPOINT access_denied');
            await admin.query('RELEASE SAVEPOINT access_denied');
          }
        });
      await t.test('stale selection can disclose its limits but cannot create drafts', async () => {
        await admin.query('SAVEPOINT stale_selection');
        try {
          await admin.query(
            "UPDATE cos.brief_runs SET review_inputs=jsonb_set(review_inputs,'{coverage}','\"stale\"') WHERE scope_id=$1",
            [scope],
          );
          assert.equal((await access.check(admin, context, 'read'))?.id, policy);
          assert.equal(await access.check(admin, context, 'draft', 'aa01'), null);
        } finally {
          await admin.query('ROLLBACK TO SAVEPOINT stale_selection');
          await admin.query('RELEASE SAVEPOINT stale_selection');
        }
      });
      await t.test('a claimed run cannot create drafts before its first model reservation', async () => {
        await admin.query('SAVEPOINT no_model_reservation');
        try {
          await admin.query('UPDATE cos.brief_runs SET model_calls=0 WHERE scope_id=$1', [scope]);
          assert.equal((await access.check(admin, context, 'read'))?.id, policy);
          assert.equal(await access.check(admin, context, 'draft', 'aa01'), null);
        } finally {
          await admin.query('ROLLBACK TO SAVEPOINT no_model_reservation');
          await admin.query('RELEASE SAVEPOINT no_model_reservation');
        }
      });
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
