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
import type { PoolClient } from 'pg';
import type { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { BriefRunStore } from '../../modules/chief-of-staff/automation/brief-store.js';
import { BriefScheduleStore } from '../../modules/chief-of-staff/automation/schedule-store.js';
import type { CosBinding } from '../../cos-boundary.js';
import type { MailReviewHostProfile } from '../../modules/chief-of-staff/automation/mail-review-profile.js';
import { writeMailReviewStandingPolicy } from '../../modules/chief-of-staff/ops/mail-review-policy-store.js';

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
      assert.deepEqual(await access.scopeForReads(admin, context), { binding_id: reader, thread_ids: ['aa01'] });
      assert.equal(await access.scopeForReads(admin, { ...context, origin: undefined }), null);
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
            assert.deepEqual(await access.scopeForReads(admin, context), { binding_id: null, thread_ids: [] });
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
      await t.test(
        'prepared brief publication retains selected reads while further draft saves stay closed',
        async () => {
          await admin.query('SAVEPOINT prepared_review');
          try {
            await admin.query("UPDATE cos.brief_runs SET state='prepared' WHERE scope_id=$1", [scope]);
            assert.equal((await access.check(admin, context, 'read'))?.id, policy);
            assert.deepEqual(await access.scopeForReads(admin, context), { binding_id: reader, thread_ids: ['aa01'] });
            assert.equal(await access.check(admin, context, 'draft', 'aa01'), null);
          } finally {
            await admin.query('ROLLBACK TO SAVEPOINT prepared_review');
            await admin.query('RELEASE SAVEPOINT prepared_review');
          }
        },
      );
      await t.test(
        'selection preparation uses retained owner identity before installing a scheduled origin',
        async () => {
          const owner = { ...context, origin: undefined, ingressId: 'fixture-owner-event' };
          const prepareAccess = new MailReviewAccess({
            authority: () => identity,
            ownerAuthority: () => identity,
            matches: () => true,
          });
          assert.equal((await prepareAccess.preparation(admin, owner, runId, 1))?.inputs?.capture_id, captureId);
          assert.equal(await access.preparation(admin, owner, runId, 1), null);
          assert.equal(await prepareAccess.preparation(admin, context, runId, 1), null);
          assert.equal(await prepareAccess.preparation(admin, owner, runId, 2), null);
          await admin.query('SAVEPOINT initial_review_preparation');
          try {
            await admin.query('UPDATE cos.brief_runs SET model_calls=0,review_inputs=NULL WHERE scope_id=$1', [scope]);
            const initial = await prepareAccess.preparation(admin, owner, runId, 1);
            assert.equal(initial?.captureId, captureId);
            assert.equal(initial?.inputs, null);
            assert.equal(await prepareAccess.check(admin, context, 'read'), null);
            await admin.query('UPDATE cos.brief_runs SET model_calls=1 WHERE scope_id=$1', [scope]);
            assert.equal(await prepareAccess.preparation(admin, owner, runId, 1), null);
          } finally {
            await admin.query('ROLLBACK TO SAVEPOINT initial_review_preparation');
            await admin.query('RELEASE SAVEPOINT initial_review_preparation');
          }
        },
      );
      await t.test('a formerly fresh selection cannot save a draft after its last sync becomes stale', async () => {
        await admin.query('SAVEPOINT review_freshness');
        try {
          const old = new Date(Date.now() - 601000).toISOString();
          await admin.query('UPDATE cos.mail_states SET last_success_at=$2 WHERE scope_id=$1', [scope, old]);
          await admin.query(
            "UPDATE cos.brief_runs SET review_inputs=jsonb_set(review_inputs,'{last_success_at}',to_jsonb($2::text)) WHERE scope_id=$1",
            [scope, old],
          );
          assert.equal((await access.check(admin, context, 'read'))?.id, policy);
          assert.equal(await access.check(admin, context, 'draft', 'aa01'), null);
        } finally {
          await admin.query('ROLLBACK TO SAVEPOINT review_freshness');
          await admin.query('RELEASE SAVEPOINT review_freshness');
        }
      });
      await t.test(
        'freezes one verified selection and cannot replace it or start selection after model use',
        async () => {
          const owner = { ...context, origin: undefined, ingressId: 'fixture-owner-event' };
          const prepareAccess = new MailReviewAccess({
            authority: () => identity,
            ownerAuthority: () => identity,
            matches: () => true,
          });
          await admin.query('SAVEPOINT freeze_review_selection');
          try {
            await admin.query(
              'UPDATE cos.brief_runs SET model_calls=0,tool_calls=0,review_inputs=NULL WHERE scope_id=$1',
              [scope],
            );
            const prepared = await prepareAccess.preparation(admin, owner, runId, 1);
            assert.ok(prepared);
            const selected = { ...inputs, coverage: prepared.coverage, candidates: [] };
            // The synthetic policy fixture has no published messages: invented source references are rejected.
            assert.equal(
              await prepareAccess.freeze(admin, owner, runId, 1, prepared, {
                ...selected,
                candidates: inputs.candidates,
              }),
              false,
            );
            assert.equal(await prepareAccess.freeze(admin, owner, runId, 1, prepared, selected), true);
            const version = (await admin.query('SELECT version FROM cos.brief_runs WHERE scope_id=$1', [scope])).rows[0]
              .version;
            await admin.query('UPDATE cos.brief_runs SET model_calls=1 WHERE scope_id=$1', [scope]);
            assert.equal(await prepareAccess.freeze(admin, owner, runId, 1, prepared, selected), true);
            assert.equal(
              (await admin.query('SELECT version FROM cos.brief_runs WHERE scope_id=$1', [scope])).rows[0].version,
              version,
            );
            assert.equal(
              await prepareAccess.freeze(admin, owner, runId, 1, prepared, { ...selected, excluded_threads: 1 }),
              false,
            );
            assert.equal(await prepareAccess.freeze(admin, context, runId, 1, prepared, selected), false);
            await admin.query('UPDATE cos.brief_runs SET review_inputs=NULL WHERE scope_id=$1', [scope]);
            assert.equal(await prepareAccess.freeze(admin, owner, runId, 1, prepared, selected), false);
          } finally {
            await admin.query('ROLLBACK TO SAVEPOINT freeze_review_selection');
            await admin.query('RELEASE SAVEPOINT freeze_review_selection');
          }
        },
      );
      await t.test(
        'a different current capture cannot adopt frozen inputs even when its window is identical',
        async () => {
          const owner = { ...context, origin: undefined, ingressId: 'fixture-owner-event' };
          const prepareAccess = new MailReviewAccess({
            authority: () => identity,
            ownerAuthority: () => identity,
            matches: () => true,
          });
          await admin.query('SAVEPOINT frozen_capture_identity');
          try {
            const replacement = randomUUID();
            await admin.query(
              `INSERT INTO cos.mail_captures(scope_id,binding_id,id,binding_version,status,capture_window,content_digest,metadata,result)
            SELECT scope_id,binding_id,$3,binding_version,status,capture_window,content_digest,metadata,result FROM cos.mail_captures
            WHERE scope_id=$1 AND id=$2`,
              [scope, captureId, replacement],
            );
            await admin.query('UPDATE cos.mail_states SET current_capture=$2 WHERE scope_id=$1', [scope, replacement]);
            assert.equal(await prepareAccess.preparation(admin, owner, runId, 1), null);
          } finally {
            await admin.query('ROLLBACK TO SAVEPOINT frozen_capture_identity');
            await admin.query('RELEASE SAVEPOINT frozen_capture_identity');
          }
        },
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
    await t.test('three schedules share one active run and retain independent daily occurrence keys', async () => {
      await admin.query('SAVEPOINT queue_fixture');
      try {
        await admin.query('DELETE FROM cos.brief_runs WHERE scope_id=$1', [scope]);
        const generic = (
          await admin.query("SELECT id FROM cos.brief_schedules WHERE scope_id=$1 AND purpose='brief'", [scope])
        ).rows[0].id;
        const proposal = randomUUID();
        await admin.query(
          `INSERT INTO cos.proposals(id,scope_id,session_id,ingress_id,owner_id,change,payload_hash,challenge_hash,state,expires_at,applied_record_id)
          VALUES($1,$2,'session','fixture-ingress','owner','{}',$3,$3,'applied',clock_timestamp()+interval '1 day',$4)`,
          [proposal, scope, digest('fixture proposal'), generic],
        );
        await admin.query(
          `INSERT INTO cos.brief_schedule_revisions(scope_id,schedule_id,version,body,proposal_id,mail_review_policy_id,mail_review_policy_version)
          SELECT scope_id,id,version,to_jsonb(s),CASE WHEN purpose='brief' THEN $2 ELSE NULL END,mail_review_policy_id,mail_review_policy_version
          FROM cos.brief_schedules s WHERE scope_id=$1 AND id<>$3`,
          [scope, proposal, binding.morningScheduleId],
        );
        await admin.query("UPDATE cos.brief_schedules SET activated_at='2026-10-25T00:00:00Z' WHERE scope_id=$1", [
          scope,
        ]);
        // Actual SQL on the admitted target, enclosed by savepoints so all synthetic rows roll back.
        // Only transaction envelopes are adapted; no scheduling query or result is mocked.
        const database = {
          run: async <T>(operation: (client: PoolClient) => Promise<T>) => {
            await admin.query('SAVEPOINT store_call');
            const client = {
              query: async (sql: string, values?: unknown[]) =>
                ['BEGIN', 'COMMIT'].includes(sql) ? { rows: [], rowCount: 0 } : admin.query(sql, values),
            } as unknown as PoolClient;
            try {
              const result = await operation(client);
              await admin.query('RELEASE SAVEPOINT store_call');
              return result;
            } catch (error) {
              await admin.query('ROLLBACK TO SAVEPOINT store_call');
              await admin.query('RELEASE SAVEPOINT store_call');
              throw error;
            }
          },
        } as unknown as BoundedDatabase;
        let clock = '2026-10-26T05:00:00.000Z';
        const runs = new BriefRunStore(database, { clock: () => new Date(clock) });
        const readAccess = new MailReviewAccess({
          authority: () => ({
            bindingDigest: binding.nativeBindingDigest,
            contextGeneration: binding.contextGeneration,
          }),
          matches: () => true,
        });
        const ctx = {
          scopeId: scope,
          ownerId: 'owner',
          sessionId: 'session',
          agentGroupId: scope,
          ingressId: 'fixture-host',
        };
        const seen = new Set<string>();
        for (let n = 0; n < 3; n++) {
          const reserved = await runs.reserveDue(ctx);
          assert.equal(reserved.status, 'ok');
          const run = reserved.run as { id: string; schedule_id: string; provenance: { purpose: string } };
          assert.ok(run);
          assert.equal(seen.has(run.schedule_id), false);
          seen.add(run.schedule_id);
          const same = await runs.reserveDue(ctx);
          assert.equal((same.run as { id: string }).id, run.id);
          const claimed = await runs.claim(ctx, run.id, 'cos-native-' + binding.nativeBindingDigest);
          assert.equal(claimed.status, 'ok');
          assert.equal((await runs.authorize(ctx, run.id, Number(claimed.generation))).status, 'ok');
          assert.equal(run.provenance.purpose, run.schedule_id === generic ? 'brief' : 'mail_review');
          assert.deepEqual(
            await readAccess.scopeForReads(admin, {
              ...ctx,
              provider: 'codex',
              generation: binding.contextGeneration,
              ingressId: `brief:${run.id}:${claimed.generation}`,
              origin: { kind: 'schedule', runId: run.id, generation: Number(claimed.generation) },
            }),
            run.schedule_id === generic ? null : { binding_id: null, thread_ids: [] },
          );
          assert.equal((await runs.cancel(ctx, run.id, Number(claimed.generation))).status, 'ok');
        }
        assert.deepEqual(seen, new Set([generic, binding.morningScheduleId, binding.afternoonScheduleId]));
        assert.equal((await runs.reserveDue(ctx)).run, null);
        assert.equal(
          (
            await admin.query('SELECT count(DISTINCT local_date)::int AS n FROM cos.brief_runs WHERE scope_id=$1', [
              scope,
            ])
          ).rows[0].n,
          1,
        );
        // Both mail slots close on revocation while the generic brief stays independent.
        // Before the next afternoon slot, neither completed previous-day afternoon
        // may collide with its old key and starve the two newly due morning schedules.
        clock = '2026-10-26T21:01:00.000Z';
        const nextMorning = new Set<string>();
        for (let n = 0; n < 2; n++) {
          const reserved = await runs.reserveDue(ctx);
          assert.equal(reserved.status, 'ok');
          const run = reserved.run as { id: string; schedule_id: string };
          assert.ok(run);
          assert.notEqual(run.schedule_id, binding.afternoonScheduleId);
          nextMorning.add(run.schedule_id);
          const claim = await runs.claim(ctx, run.id, 'fixture-next-morning');
          assert.equal(claim.status, 'ok');
          assert.equal((await runs.cancel(ctx, run.id, Number(claim.generation))).status, 'ok');
        }
        assert.deepEqual(nextMorning, new Set([generic, binding.morningScheduleId]));
        assert.equal((await runs.reserveDue(ctx)).run, null);
        clock = '2026-10-27T05:00:00.000Z';
        await admin.query(
          "UPDATE cos.brief_schedules SET policy=jsonb_set(policy,'{state}','\"paused\"') WHERE scope_id=$1 AND purpose='brief'",
          [scope],
        );
        const pending = (await runs.reserveDue(ctx)).run as { id: string };
        assert.ok(pending);
        const claim = await runs.claim(ctx, pending.id, 'fixture-host');
        assert.equal(claim.status, 'ok');
        await admin.query("UPDATE cos.mail_review_policies SET state='revoked' WHERE scope_id=$1", [scope]);
        assert.equal((await runs.authorize(ctx, pending.id, Number(claim.generation))).status, 'denied');
        assert.equal((await runs.reserveDue(ctx)).run, null);
        assert.equal(
          (await runs.inspect(ctx, pending.id)).run &&
            ((await runs.inspect(ctx, pending.id)).run as { state: string }).state,
          'cancelled',
        );
      } finally {
        await admin.query('ROLLBACK TO SAVEPOINT queue_fixture');
        await admin.query('RELEASE SAVEPOINT queue_fixture');
      }
    });
    await t.test(
      'generic schedule discovery and proposals cannot read or change the mail-review schedules',
      async () => {
        const schedules = new BriefScheduleStore(),
          ctx = {
            scopeId: scope,
            ownerId: 'owner',
            sessionId: 'session',
            agentGroupId: scope,
            ingressId: 'fixture-ingress',
          };
        await admin.query('SAVEPOINT generic_schedule_boundary');
        try {
          await admin.query(
            "UPDATE cos.brief_schedules SET owner_id='other-owner' WHERE scope_id=$1 AND purpose='brief'",
            [scope],
          );
          assert.deepEqual(await schedules.read(admin as unknown as PoolClient, ctx), []);
          const changed = await schedules.applyApproved(
            admin as unknown as PoolClient,
            ctx,
            { id: 'fixture-proposal', decision_ingress_id: 'fixture-decision' },
            {
              kind: 'brief_schedule',
              record_id: binding.morningScheduleId,
              title: 'Changed generic schedule',
              reason: 'Fixture boundary',
              expected_version: 1,
              policy: mailReviewSchedulePolicy('morning'),
              limits,
            },
          );
          assert.equal(changed.status, 'conflict');
        } finally {
          await admin.query('ROLLBACK TO SAVEPOINT generic_schedule_boundary');
          await admin.query('RELEASE SAVEPOINT generic_schedule_boundary');
        }
      },
    );
    await t.test(
      'trusted review setup creates two bound schedules and replays without changing activation',
      async () => {
        await admin.query('SAVEPOINT trusted_policy_fixture');
        try {
          await admin.query('DELETE FROM cos.brief_runs WHERE scope_id=$1', [scope]);
          await admin.query(
            'DELETE FROM cos.brief_schedule_revisions WHERE scope_id=$1 AND mail_review_policy_id IS NOT NULL',
            [scope],
          );
          await admin.query("DELETE FROM cos.brief_schedules WHERE scope_id=$1 AND purpose='mail_review'", [scope]);
          await admin.query('DELETE FROM cos.mail_review_policy_revisions WHERE scope_id=$1', [scope]);
          await admin.query('DELETE FROM cos.mail_review_policies WHERE scope_id=$1', [scope]);
          const native: CosBinding = {
            scopeId: scope,
            ownerId: 'owner',
            sessionId: 'session',
            agentGroupId: scope,
            messagingGroupId: 'fixture-group',
            instanceId: scope,
            channelId: scope,
            botId: 'fixture-bot',
            provider: 'codex',
          };
          const writerBodyGoogle = { ...writerBody, provider: 'google', nativeBindingDigest: digest(native) };
          await admin.query("UPDATE cos.mail_bindings SET provider='google',credential_ref=$2 WHERE scope_id=$1", [
            scope,
            randomUUID(),
          ]);
          await admin.query('UPDATE cos.mail_draft_writer_revisions SET body=$2,digest=$3 WHERE scope_id=$1', [
            scope,
            JSON.stringify(writerBodyGoogle),
            digest(writerBodyGoogle),
          ]);
          const profile: MailReviewHostProfile = {
            format: 'cos-mail-review-host/v1',
            installationDigest: digest('fixture installation'),
            journalGeneration: writerBody.journalGeneration,
            scopeId: scope,
            ownerId: 'owner',
            sessionId: 'session',
            agentGroupId: scope,
            id: randomUUID(),
            version: 1,
            binding: {
              ...binding,
              provider: 'google',
              writerDigest: digest(writerBodyGoogle),
              nativeBindingDigest: digest(native),
              morningScheduleId: randomUUID(),
              afternoonScheduleId: randomUUID(),
            },
          };
          const invoke = async (value = profile, ready: () => Promise<void> = async () => {}) => {
            await admin.query('SAVEPOINT policy_write_call');
            const client = {
              query: async (sql: string, values?: unknown[]) => {
                if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
                if (sql === 'ROLLBACK') return admin.query('ROLLBACK TO SAVEPOINT policy_write_call');
                return admin.query(sql, values);
              },
            } as unknown as Pick<PoolClient, 'query'>;
            try {
              await writeMailReviewStandingPolicy(client, native, value, ready);
              await admin.query('RELEASE SAVEPOINT policy_write_call');
            } catch (error) {
              await admin.query('ROLLBACK TO SAVEPOINT policy_write_call');
              await admin.query('RELEASE SAVEPOINT policy_write_call');
              throw error;
            }
          };
          const before = (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now;
          let initialChecks = 0;
          await assert.rejects(
            invoke(profile, async () => {
              if (++initialChecks === 2) throw Error('fixture initial readiness lost');
            }),
            /fixture initial readiness lost/,
          );
          assert.equal(
            (await admin.query('SELECT count(*)::int AS n FROM cos.mail_review_policies WHERE scope_id=$1', [scope]))
              .rows[0].n,
            0,
          );
          assert.equal(
            (
              await admin.query(
                "SELECT count(*)::int AS n FROM cos.brief_schedules WHERE scope_id=$1 AND purpose='mail_review'",
                [scope],
              )
            ).rows[0].n,
            0,
          );
          const genericId = (
            await admin.query("SELECT id FROM cos.brief_schedules WHERE scope_id=$1 AND purpose='brief'", [scope])
          ).rows[0].id;
          await assert.rejects(
            invoke({ ...profile, binding: { ...profile.binding, morningScheduleId: genericId } }),
            /mail_review_policy_schedule_changed/,
          );
          assert.equal(
            (await admin.query('SELECT count(*)::int AS n FROM cos.mail_review_policies WHERE scope_id=$1', [scope]))
              .rows[0].n,
            0,
          );
          await invoke();
          const first = (
            await admin.query(
              "SELECT id,version,activated_at,policy FROM cos.brief_schedules WHERE scope_id=$1 AND purpose='mail_review' ORDER BY id",
              [scope],
            )
          ).rows;
          assert.equal(first.length, 2);
          assert.ok(first.every((row) => row.activated_at >= before));
          await invoke();
          assert.deepEqual(
            (
              await admin.query(
                "SELECT id,version,activated_at,policy FROM cos.brief_schedules WHERE scope_id=$1 AND purpose='mail_review' ORDER BY id",
                [scope],
              )
            ).rows,
            first,
          );
          assert.equal(
            (await admin.query('SELECT count(*)::int AS n FROM cos.brief_schedules WHERE scope_id=$1', [scope])).rows[0]
              .n,
            3,
          );
          assert.equal(
            (await admin.query('SELECT count(*)::int AS n FROM cos.mail_review_policies WHERE scope_id=$1', [scope]))
              .rows[0].n,
            1,
          );
          await assert.rejects(
            invoke({ ...profile, binding: { ...profile.binding, writerDigest: digest('wrong writer') } }),
            /mail_review_policy_writer_changed/,
          );
          let checks = 0;
          await assert.rejects(
            invoke(profile, async () => {
              if (++checks === 2) throw Error('fixture readiness lost');
            }),
            /fixture readiness lost/,
          );
          assert.equal(
            (
              await admin.query('SELECT count(*)::int AS n FROM cos.mail_review_policy_revisions WHERE scope_id=$1', [
                scope,
              ])
            ).rows[0].n,
            1,
          );
        } finally {
          await admin.query('ROLLBACK TO SAVEPOINT trusted_policy_fixture');
          await admin.query('RELEASE SAVEPOINT trusted_policy_fixture');
        }
      },
    );
  } finally {
    await admin.query('ROLLBACK').catch(() => {});
    await Promise.allSettled([admin.end(), runtime.end()]);
  }
});
