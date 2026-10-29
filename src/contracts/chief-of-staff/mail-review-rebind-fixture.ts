import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type pg from 'pg';
import type { PoolClient } from 'pg';
import { ensureCosBoundarySchema, installCosBoundary, type CosBinding } from '../../cos-boundary.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../../db/schema.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import {
  mailReviewProfileName,
  readMailReviewHostProfile,
  type MailReviewHostProfile,
} from '../../modules/chief-of-staff/automation/mail-review-profile.js';
import type { MailReviewPolicyHead } from '../../modules/chief-of-staff/mail-drafts/journal.js';
import { writeMailReviewStandingPolicy } from '../../modules/chief-of-staff/ops/mail-review-policy-store.js';
import { writeMailReviewReboundPolicy } from '../../modules/chief-of-staff/ops/mail-review-rebind-store.js';
import { initializeTargetDraftJournal } from '../../modules/chief-of-staff/mail-drafts/host-ownership.js';
import { createConversationState } from '../../modules/chief-of-staff/bridge/conversation-state.js';
import { ensureModelBudget } from '../../modules/chief-of-staff/bridge/model-policy.js';
import { recoverConversation } from '../../modules/chief-of-staff/ops/conversation-recovery.js';
import { mailReviewContextRecoveryCurrent } from '../../modules/chief-of-staff/ops/mail-review-context-current.js';
import { publishReboundMailReview } from '../../modules/chief-of-staff/ops/mail-review-rebind-publication.js';
import { writeAtomic } from '../../modules/chief-of-staff/ops/target-state.js';

/** Actual selected fixture database, inside the caller's rollback-only transaction. No live account. */
export async function runMailReviewRebindSqlFixture(admin: pg.Client, runtime: pg.Client): Promise<void> {
  const scope = 'g06-rebind-' + randomUUID(),
    native: CosBinding = {
      scopeId: scope,
      ownerId: 'owner',
      sessionId: 'session',
      agentGroupId: scope,
      messagingGroupId: 'messages',
      instanceId: scope,
      channelId: scope,
      botId: 'bot',
      provider: 'codex',
    },
    installation = digest('fixture installation');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-rebind-sql-')),
    history = initializeTargetDraftJournal(root, installation),
    journal = history.generation,
    central = new Database(':memory:'),
    inbound = new Database(':memory:'),
    outbound = new Database(':memory:');
  try {
    ensureCosBoundarySchema(central);
    installCosBoundary(native, central);
    inbound.exec(INBOUND_SCHEMA);
    outbound.exec(OUTBOUND_SCHEMA);
    ensureModelBudget(central);
    central.prepare('INSERT INTO cos_model_budgets VALUES(?,?,7)').run('a'.repeat(32), digest('old allowance'));
    const account = digest('synthetic model account'),
      oldContext = createConversationState(root, central).prepare(native, account),
      generation = oldContext.generation;
    fs.writeFileSync(path.join(oldContext.directory, 'history'), 'synthetic prior conversation');
    const recovered = await recoverConversation({
      root,
      db: central,
      inbound,
      outbound,
      binding: native,
      accountFingerprint: account,
      expectedGeneration: generation,
      recoveryId: randomUUID(),
      assertAuthority() {},
      backup: async () => {},
    });
    await admin.query(
      "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'owner',$1,$1,$1,'paused')",
      [scope],
    );
    const createWriter = async () => {
      const reader = randomUUID(),
        writer = randomUUID(),
        consent = digest(randomUUID());
      const body = {
        format: 'cos-mail-draft-binding/v1',
        provider: 'google',
        readerBindingId: reader,
        mailboxDigest: digest('owner@example.test'),
        writerClientDigest: digest('writer client'),
        readerClientDigest: digest('reader client'),
        credentialReference: randomUUID(),
        nativeBindingDigest: digest(native),
        journalGeneration: journal,
        maxPerDay: 5,
        timeZone: 'Australia/Sydney',
        replyMode: 'plain_text_reply',
        permissionScopes: ['https://www.googleapis.com/auth/gmail.compose'],
        recoveryProofDigest: digest(randomUUID()),
      };
      await admin.query(
        `INSERT INTO cos.mail_bindings(scope_id,id,provider,mailbox_email,permission_scopes,processing_providers,auth,provenance,credential_ref)
      VALUES($1,$2,'google','owner@example.test',ARRAY['https://www.googleapis.com/auth/gmail.readonly'],ARRAY['codex'],'ready','{}',$3)`,
        [scope, reader, randomUUID()],
      );
      await admin.query(
        "INSERT INTO cos.mail_draft_writer_bindings(scope_id,id,reader_binding_id,owner_id,session_id,version,state) VALUES($1,$2,$3,'owner','session',1,'enabled')",
        [scope, writer, reader],
      );
      await admin.query(
        'INSERT INTO cos.mail_draft_writer_revisions(scope_id,binding_id,version,body,digest,consent_ref) VALUES($1,$2,1,$3,$4,$5)',
        [scope, writer, JSON.stringify(body), digest(body), consent],
      );
      return {
        readerBindingId: reader,
        writerBindingId: writer,
        writerVersion: 1,
        writerDigest: digest(body),
        writerConsentRef: consent,
      };
    };
    const previous: MailReviewHostProfile = {
      format: 'cos-mail-review-host/v1',
      installationDigest: digest('fixture installation'),
      journalGeneration: journal,
      scopeId: scope,
      ownerId: 'owner',
      sessionId: 'session',
      agentGroupId: scope,
      id: randomUUID(),
      version: 1,
      binding: {
        format: 'cos-mail-review-binding/v1',
        provider: 'google',
        ...(await createWriter()),
        nativeBindingDigest: digest(native),
        mailboxDigest: digest('owner@example.test'),
        contextGeneration: generation,
        morningScheduleId: randomUUID(),
        afternoonScheduleId: randomUUID(),
        timeZone: 'Australia/Sydney',
        maxCandidateThreads: 10,
        maxModelAttempts: 3,
        maxDraftsPerDay: 5,
      },
    };
    const profile = structuredClone(previous);
    profile.version = 2;
    Object.assign(profile.binding, await createWriter(), { contextGeneration: recovered.generation });
    const head: MailReviewPolicyHead = {
      scopeId: scope,
      policyId: previous.id,
      policyVersion: 1,
      profileDigest: digest(previous),
      revision: 1,
      enabled: true,
    };
    const manifest = {
      format: 'cos-mail-review-rebind/v1',
      expectedRevision: 1,
      expectedPinDigest: digest(head),
      previousProfileDigest: digest(previous),
      profile,
    };
    const requestId = randomUUID();
    history.publishReviewPolicyPin(
      {
        requestId: randomUUID(),
        expectedRevision: 0,
        enabled: true,
        pin: { scopeId: scope, policyId: previous.id, policyVersion: 1, profileDigest: digest(previous) },
      },
      () => {},
    );
    writeAtomic(path.join(root, 'mail-drafts'), mailReviewProfileName(scope), previous);
    const draftAt = Date.now();
    for (let index = 1; index <= 5; index++)
      history.reserve(
        {
          scopeId: scope,
          bindingId: previous.binding.writerBindingId,
          contextGeneration: generation,
          mailboxDigest: previous.binding.mailboxDigest,
          sourceMessageId: 'aa0' + index,
          threadId: 'bb0' + index,
          requestId: randomUUID(),
          contentDigest: digest('reply ' + index),
        },
        draftAt + index * 20,
      );
    // The actual SQL statements execute in a savepoint. Commit-ack loss keeps the applied SQL visible
    // for same-request reconciliation while the enclosing test still rolls all synthetic rows back.
    const invoke = async (
      operation: (client: Pick<PoolClient, 'query'>) => Promise<void>,
      loseAcknowledgement = false,
    ) => {
      await admin.query('SAVEPOINT rebind_call');
      let committed = false;
      const client = {
        query: async (sql: string, values?: unknown[]) => {
          if (sql === 'BEGIN') return { rows: [], rowCount: 0 };
          if (sql === 'COMMIT') {
            committed = true;
            if (loseAcknowledgement) throw Error('fixture_commit_ack_lost');
            return { rows: [], rowCount: 0 };
          }
          if (sql === 'ROLLBACK')
            return committed ? { rows: [], rowCount: 0 } : admin.query('ROLLBACK TO SAVEPOINT rebind_call');
          return admin.query(sql, values);
        },
      } as unknown as Pick<PoolClient, 'query'>;
      try {
        await operation(client);
      } finally {
        if (!committed) await admin.query('ROLLBACK TO SAVEPOINT rebind_call');
        await admin.query('RELEASE SAVEPOINT rebind_call');
      }
    };
    await invoke((client) => writeMailReviewStandingPolicy(client, native, previous, async () => {}));
    const oldRun = digest('cancelled review ' + scope);
    await admin.query(
      `INSERT INTO cos.brief_runs(scope_id,id,schedule_id,schedule_version,owner_id,session_id,agent_group_id,intended_at,local_date,state,limits,provenance,deadline_at)
    SELECT scope_id,$2,id,version,owner_id,session_id,agent_group_id,activated_at,CURRENT_DATE,'cancelled',limits,'{}',clock_timestamp()+interval '5 minutes' FROM cos.brief_schedules WHERE scope_id=$1 AND id=$3`,
      [scope, oldRun, previous.binding.morningScheduleId],
    );
    const snapshot = async () => ({
      policies: (await admin.query('SELECT * FROM cos.mail_review_policies WHERE scope_id=$1 ORDER BY id', [scope]))
        .rows,
      revisions: (
        await admin.query('SELECT * FROM cos.mail_review_policy_revisions WHERE scope_id=$1 ORDER BY version', [scope])
      ).rows,
      schedules: (await admin.query('SELECT * FROM cos.brief_schedules WHERE scope_id=$1 ORDER BY id', [scope])).rows,
      scheduleRevisions: (
        await admin.query('SELECT * FROM cos.brief_schedule_revisions WHERE scope_id=$1 ORDER BY schedule_id,version', [
          scope,
        ])
      ).rows,
      runs: (await admin.query('SELECT * FROM cos.brief_runs WHERE scope_id=$1 ORDER BY id', [scope])).rows,
    });
    const before = await snapshot();
    const rebind = (
      ready: () => Promise<void> = async () => {},
      selectedManifest: unknown = manifest,
      selectedHead = head,
      selectedRequest = requestId,
      lost = false,
    ) =>
      invoke(
        (client) =>
          writeMailReviewReboundPolicy(
            client,
            native,
            previous,
            selectedManifest,
            selectedHead,
            selectedRequest,
            ready,
          ),
        lost,
      );
    const rejectedMutation = async (sql: string, values: unknown[], pattern: RegExp) => {
      await admin.query('SAVEPOINT rejected_rebind');
      try {
        await admin.query(sql, values);
        await assert.rejects(rebind(), pattern);
      } finally {
        await admin.query('ROLLBACK TO SAVEPOINT rejected_rebind');
        await admin.query('RELEASE SAVEPOINT rejected_rebind');
      }
      assert.deepEqual(await snapshot(), before);
    };
    await rejectedMutation(
      "UPDATE cos.mail_draft_writer_bindings SET state='disabled' WHERE scope_id=$1 AND id=$2",
      [scope, profile.binding.writerBindingId],
      /mail_review_rebind_writer_changed/,
    );
    await rejectedMutation(
      "UPDATE cos.mail_bindings SET mailbox_email='other@example.test' WHERE scope_id=$1 AND id=$2",
      [scope, profile.binding.readerBindingId],
      /mail_review_rebind_writer_changed/,
    );
    await rejectedMutation(
      "UPDATE cos.mail_review_policies SET state='revoked' WHERE scope_id=$1",
      [scope],
      /mail_review_rebind_policy_changed/,
    );
    await rejectedMutation(
      "UPDATE cos.brief_schedules SET policy=jsonb_set(policy,'{state}','\"paused\"') WHERE scope_id=$1",
      [scope],
      /mail_review_rebind_schedule_changed/,
    );
    for (const state of ['queued', 'dispatched', 'prepared', 'uncertain'])
      await rejectedMutation(
        'UPDATE cos.brief_runs SET state=$2 WHERE scope_id=$1',
        [scope, state],
        /mail_review_rebind_run_unsettled/,
      );
    let checks = 0;
    await assert.rejects(
      rebind(async () => {
        if (++checks === 2) throw Error('fixture_readiness_lost');
      }),
      /fixture_readiness_lost/,
    );
    assert.deepEqual(await snapshot(), before);
    await assert.rejects(
      rebind(undefined, { ...manifest, profile: { ...profile, binding: { ...profile.binding, maxDraftsPerDay: 6 } } }),
      /mail_review_rebind_unverified/,
    );
    assert.deepEqual(await snapshot(), before);
    const databaseBefore = (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now;
    await assert.rejects(rebind(undefined, manifest, head, requestId, true), /fixture_commit_ack_lost/);
    const after = await snapshot();
    assert.equal(after.policies[0].version, 2);
    assert.equal(after.policies[0].state, 'enabled');
    assert.equal(after.revisions.length, 2);
    assert.deepEqual(after.revisions[0], before.revisions[0]);
    assert.deepEqual(after.runs, before.runs);
    assert.equal(after.scheduleRevisions.length, 4);
    for (const row of before.scheduleRevisions)
      assert.deepEqual(
        after.scheduleRevisions.find((x) => x.schedule_id === row.schedule_id && x.version === 1),
        row,
      );
    assert.ok(
      after.schedules.every(
        (row) => row.version === 2 && row.mail_review_policy_version === 2 && row.activated_at >= databaseBefore,
      ),
    );
    assert.equal(after.schedules[0].activated_at.getTime(), after.schedules[1].activated_at.getTime());
    await rebind();
    assert.deepEqual(await snapshot(), after);
    await assert.rejects(rebind(undefined, manifest, head, randomUUID()), /mail_review_rebind_policy_changed/);
    assert.deepEqual(await snapshot(), after);
    await admin.query('SAVEPOINT disabled_rebind');
    try {
      // Return only this synthetic fixture to its original revision, then prove independent disable survives.
      await admin.query('UPDATE cos.mail_review_policies SET version=1 WHERE scope_id=$1', [scope]);
      await admin.query(
        "UPDATE cos.brief_schedules s SET version=1,mail_review_policy_version=1,policy=r.body->'policy',provenance=r.body->'provenance',activated_at=(r.body->>'activated_at')::timestamptz FROM cos.brief_schedule_revisions r WHERE s.scope_id=$1 AND r.scope_id=s.scope_id AND r.schedule_id=s.id AND r.version=1",
        [scope],
      );
      await admin.query('DELETE FROM cos.brief_schedule_revisions WHERE scope_id=$1 AND version=2', [scope]);
      await admin.query('DELETE FROM cos.mail_review_policy_revisions WHERE scope_id=$1 AND version=2', [scope]);
      const disabled = { ...head, enabled: false },
        disabledManifest = { ...manifest, expectedPinDigest: digest(disabled) };
      await rebind(undefined, disabledManifest, disabled, randomUUID());
      const result = await snapshot();
      assert.equal(result.policies[0].state, 'disabled');
      assert.ok(result.schedules.every((row) => row.policy.state === 'paused'));
      assert.deepEqual(result.runs, before.runs);
    } finally {
      await admin.query('ROLLBACK TO SAVEPOINT disabled_rebind');
      await admin.query('RELEASE SAVEPOINT disabled_rebind');
    }
    await admin.query('SAVEPOINT runtime_cannot_rebind');
    try {
      await assert.rejects(
        runtime.query('UPDATE cos.mail_review_policies SET version=version WHERE scope_id=$1', [scope]),
        (error: { code?: string }) => error.code === '42501',
      );
    } finally {
      await admin.query('ROLLBACK TO SAVEPOINT runtime_cannot_rebind');
      await admin.query('RELEASE SAVEPOINT runtime_cannot_rebind');
    }
    assert.deepEqual(await snapshot(), after);
    const nativeBefore = central.serialize(),
      inputBefore = inbound.serialize(),
      outputBefore = outbound.serialize();
    const draftRows = () => {
      const db = new Database(path.join(history.root, 'effects.sqlite'), { readonly: true, fileMustExist: true });
      try {
        return db.prepare('SELECT * FROM effects ORDER BY operation_id').all();
      } finally {
        db.close();
      }
    };
    const draftsBefore = draftRows();
    const assertCurrent = () => {
      assert.equal(
        mailReviewContextRecoveryCurrent(central, root, native, generation, recovered.generation, account),
        true,
      );
    };
    const publish = () =>
      publishReboundMailReview({
        targetRoot: root,
        installationDigest: installation,
        journal: history,
        binding: native,
        manifest,
        requestId,
        currentGeneration: recovered.generation,
        assertAuthority: assertCurrent,
        ready: async () => assertCurrent(),
        writePolicy: async (ready, old, _proposed, oldHead) => {
          await invoke((client) =>
            writeMailReviewReboundPolicy(client, native, old, manifest, oldHead, requestId, ready),
          );
        },
      });
    assert.equal((await publish()).revision, 2);
    assert.equal((await publish()).revision, 2);
    assert.deepEqual(readMailReviewHostProfile(root, installation, history, scope), profile);
    assert.deepEqual(await snapshot(), after);
    assert.deepEqual(draftRows(), draftsBefore);
    assert.throws(
      () =>
        history.reserve(
          {
            scopeId: scope,
            bindingId: profile.binding.writerBindingId,
            contextGeneration: recovered.generation,
            mailboxDigest: profile.binding.mailboxDigest,
            sourceMessageId: 'aa06',
            threadId: 'bb06',
            requestId: randomUUID(),
            contentDigest: digest('sixth reply'),
          },
          draftAt + 200,
        ),
      /daily_limit/,
    );
    assert.deepEqual(central.serialize(), nativeBefore);
    assert.deepEqual(inbound.serialize(), inputBefore);
    assert.deepEqual(outbound.serialize(), outputBefore);
    assert.equal(fs.readFileSync(path.join(oldContext.directory, 'history'), 'utf8'), 'synthetic prior conversation');
  } finally {
    history.close();
    central.close();
    inbound.close();
    outbound.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
