import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { fixtureDatabaseConfig, connectFixtureDatabase, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import {
  KnowledgeStore,
  type KnowledgeContext,
  type ImportSource,
  type Evidence,
} from '../../modules/chief-of-staff/knowledge/store.js';
import { connectionFault } from './connection-fault.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import Database from 'better-sqlite3';
import { KnowledgeInvalidation } from '../../modules/chief-of-staff/knowledge/invalidation.js';
import { installCosBoundary, permitCosOutbound, type CosBinding } from '../../cos-boundary.js';
import { initTestDb, closeDb } from '../../db/connection.js';
import { createCosRuntime } from '../../modules/chief-of-staff/runtime.js';
import { createRpcHandler } from '../../modules/chief-of-staff/bridge/rpc.js';
import { resolveKnowledgeContext } from '../../modules/chief-of-staff/knowledge/context.js';
import { ensureConversationSchema } from '../../modules/chief-of-staff/bridge/conversation-state.js';
import { digest, type Change } from '../../modules/chief-of-staff/domain/contracts.js';
import type { Session } from '../../types.js';
import type { AnswerDraft } from '../../modules/chief-of-staff/knowledge/answers.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../../db/schema.js';
import { recoverConversation } from '../../modules/chief-of-staff/ops/conversation-recovery.js';
import { issueActivation, rebindRecoveredActivation } from '../../modules/chief-of-staff/ops/model-activation.js';
import {
  ensureModelBudget,
  reserveSubscriptionAttempt,
  type SubscriptionActivation,
} from '../../modules/chief-of-staff/bridge/model-policy.js';

const scope = 'knowledge-' + randomUUID(),
  other = scope + '-other';
const context: KnowledgeContext = {
  scopeId: scope,
  ownerId: 'fixture-owner',
  agentGroupId: scope,
  sessionId: scope,
  ingressId: randomUUID(),
  provider: 'codex',
  generation: randomUUID(),
};
let admin: pg.Client, pool: pg.Pool, store: KnowledgeStore, artifacts: KnowledgeArtifacts, base: string;
const note = (key: string, text: string, overrides: Partial<ImportSource> = {}): ImportSource => {
  const filename = key + '.md';
  fs.writeFileSync(path.join(base, 'staging', filename), text, { mode: 0o600 });
  return { sourceKey: key, filename, title: key, processingProviders: ['codex'], expectedVersion: 0, ...overrides };
};
const imported = async (input: ImportSource, ctx = context) => {
  const result = await store.importSource(ctx, randomUUID(), input);
  assert.equal(result.status, 'ok');
  return result;
};
before(async () => {
  console.log(JSON.stringify({ fixtureRun: scope }));
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  assert.equal(await migrate(admin, fixtureRuntimeUser()), 2);
  pool = new pg.Pool(await fixtureDatabaseConfig());
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-knowledge-integration-'));
  for (const directory of ['artifacts', 'staging']) fs.mkdirSync(path.join(base, directory), { mode: 0o700 });
  artifacts = new KnowledgeArtifacts(path.join(base, 'artifacts'), path.join(base, 'staging'));
  store = new KnowledgeStore(BoundedDatabase.fromConfig(await fixtureDatabaseConfig()), artifacts);
  for (const id of [scope, other])
    await pool.query(
      "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'fixture-owner','fixture-instance',$1,$1,'active')",
      [id],
    );
});
after(async () => {
  if (pool) {
    await pool.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=ANY($1)', [[scope, other]]);
    for (const table of [
      'derivation_links',
      'evidence_refs',
      'chunks',
      'revocation_tombstones',
      'source_revisions',
      'sources',
      'records',
      'artifacts',
      'outbox',
      'operations',
      'proposals',
      'events',
    ])
      await pool.query(`DELETE FROM cos.${table} WHERE scope_id=ANY($1)`, [[scope, other]]);
    await pool.query('DELETE FROM cos.scopes WHERE id=ANY($1)', [[scope, other]]);
    await pool.end();
  }
  await store?.database.pool.end();
  await admin?.end();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

test('S02-T01: scope filters exclude foreign text, scores and citations before retrieval', async () => {
  const a = await imported(note('alpha', 'Pilot Alpha blocked on supplier approval.'));
  await imported(note('foreign', 'Pilot Alpha FOREIGN_CANARY never disclose.'), {
    ...context,
    scopeId: other,
    agentGroupId: other,
    sessionId: other,
  });
  const result = await store.search(context, { query: 'Pilot Alpha' });
  assert.equal(result.status, 'ok');
  assert.equal(JSON.stringify(result).includes('FOREIGN_CANARY'), false);
  const rows = result.items as Evidence[];
  assert.ok(rows.some((row) => row.source_id === a.source_id));
  assert.equal((await store.search({ ...context, scopeId: other }, { query: 'Pilot' })).status, 'denied');
});
test('S02-T02: evidence resolves exact revision digest and actual normalized line locator', async () => {
  const text = '# Citation\nCafé approval blocks the pilot.\n',
    a = await imported(note('citation', text));
  const found = await store.search(
    { ...context, generation: randomUUID() },
    { query: 'Café', sourceId: String(a.source_id) },
  );
  assert.equal(found.status, 'ok');
  const row = (found.items as Evidence[])[0];
  assert.ok(row.evidence_id);
  assert.equal(row.revision_digest, a.digest);
  assert.equal(
    text
      .split('\n')
      .slice(row.start_line - 1, row.end_line)
      .join('\n'),
    row.text,
  );
  const exact = await store.get(context, String(a.source_id), String(a.revision_id), row.ordinal);
  assert.equal(exact.status, 'ok');
  assert.equal((exact.items as Evidence[])[0].text, row.text);
  assert.equal(JSON.stringify(exact).includes(base), false);
});
test('S02-T03: retries reconcile one immutable revision and changed content retains history', async () => {
  const input = note('revisions', 'The dependency is blocked.'),
    request = randomUUID();
  const a = await store.importSource(context, request, input);
  assert.equal(a.status, 'ok');
  assert.deepEqual(await store.importSource(context, request, input), a);
  const duplicate = await imported(input);
  assert.equal(duplicate.revision_id, a.revision_id);
  const b = await imported(note('revisions', 'The dependency is approved.', { expectedVersion: Number(a.version) }));
  assert.notEqual(b.revision_id, a.revision_id);
  assert.equal(b.version, 2);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM cos.source_revisions WHERE source_id=$1', [a.source_id])).rows[0]
      .n,
    2,
  );
  assert.equal((await store.importSource(context, request, input)).status, 'conflict');
});
test('S02-T07: contradictory independent sources remain visible without changing approved priorities', async () => {
  const ctx = { ...context, generation: randomUUID() };
  await imported(note('conflict-old', 'ContradictionCanary pilot supplier is blocked.'));
  await imported(note('conflict-new', 'ContradictionCanary pilot supplier is approved.'));
  const result = await store.search(ctx, { query: 'ContradictionCanary' });
  assert.equal(result.status, 'ok');
  assert.equal((result.items as Evidence[]).length, 2);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM cos.records WHERE scope_id=$1', [scope])).rows[0].n,
    0,
  );
});
test('S02-T09: processing policy excludes a readable source from disallowed model contexts', async () => {
  const a = await imported(
    note('policy', 'ProviderPolicyCanary confidential text.', { processingProviders: ['claude'] }),
  );
  const result = await store.search({ ...context, generation: randomUUID() }, { query: 'ProviderPolicyCanary' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.items, []);
  assert.equal((await store.get(context, String(a.source_id), String(a.revision_id), 0)).status, 'denied');
});
test('S02-T10: correction fences exposed context; a new context retrieves only the current revision', async () => {
  const ctx = { ...context, generation: randomUUID() },
    a = await imported(note('correction', 'CorrectionCanary the launch is blocked.'));
  assert.equal((await store.search(ctx, { query: 'CorrectionCanary' })).status, 'ok');
  const b = await imported(note('correction', 'CorrectionCanary the launch is ready.', { expectedVersion: 1 }));
  assert.equal((await store.search(ctx, { query: 'CorrectionCanary' })).status, 'denied');
  const fresh = await store.search({ ...ctx, generation: randomUUID() }, { query: 'CorrectionCanary' });
  assert.equal(fresh.status, 'ok');
  assert.equal((fresh.items as Evidence[])[0].revision_id, b.revision_id);
  assert.notEqual(b.revision_id, a.revision_id);
});
test('S02-PG01: real connection loss after byte publication admits nothing and retries one revision', async () => {
  const relay = await connectionFault(await fixtureDatabaseConfig()),
    database = new BoundedDatabase(new pg.Pool(relay.config), 350);
  let fail = true;
  const fault = new KnowledgeStore(database, artifacts, {
    afterPublication: async () => {
      if (fail) relay.partition();
    },
  });
  try {
    await database.run((client) => client.query('SELECT 1'));
    const input = note('partition-import', 'PartitionImportCanary source.'),
      request = randomUUID();
    assert.ok(['pending', 'unavailable'].includes((await fault.importSource(context, request, input)).status));
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM cos.sources WHERE scope_id=$1 AND source_key=$2', [
          scope,
          input.sourceKey,
        ])
      ).rows[0].n,
      0,
    );
    assert.ok(fs.readdirSync(artifacts.root).some((name) => name.endsWith('.blob')));
    fail = false;
    relay.restore();
    await new Promise((resolve) => setTimeout(resolve, 1050));
    const retry = await fault.importSource(context, request, input);
    assert.equal(retry.status, 'ok');
    assert.deepEqual(await fault.importSource(context, request, input), retry);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM cos.source_revisions WHERE source_id=$1', [retry.source_id]))
        .rows[0].n,
      1,
    );
  } finally {
    await database.pool.end();
    await relay.close();
  }
});
test('S02-PG02: database-policy outage blocks cached private search and source redisplay', async () => {
  const relay = await connectionFault(await fixtureDatabaseConfig()),
    database = new BoundedDatabase(new pg.Pool(relay.config), 350),
    fault = new KnowledgeStore(database, artifacts);
  try {
    const a = await imported(note('outage', 'OutageCanary private source.')),
      ctx = { ...context, generation: randomUUID() };
    assert.equal((await fault.search(ctx, { query: 'OutageCanary' })).status, 'ok');
    relay.partition();
    const result = await fault.search(ctx, { query: 'OutageCanary' });
    assert.equal(result.status, 'unavailable');
    assert.equal(JSON.stringify(result).includes('OutageCanary'), false);
    assert.equal((await fault.get(ctx, String(a.source_id), String(a.revision_id), 0)).status, 'unavailable');
  } finally {
    await database.pool.end();
    await relay.close();
  }
});
test('S02-T06: a prepared retrieval is denied if access changes before disclosure', async () => {
  const a = await imported(note('during-read', 'RevocationRaceCanary private source.'));
  const guarded = new KnowledgeStore(store.database, artifacts, {
    beforeDisclosure: async () => {
      await pool.query("UPDATE cos.sources SET status='revoked',version=version+1 WHERE scope_id=$1 AND id=$2", [
        scope,
        a.source_id,
      ]);
    },
  });
  const result = await guarded.search({ ...context, generation: randomUUID() }, { query: 'RevocationRaceCanary' });
  assert.equal(result.status, 'denied');
  assert.equal(JSON.stringify(result).includes('RevocationRaceCanary'), false);
});
test('S02-T03: concurrent corrections honour the reviewed source version and preserve one winner', async () => {
  const a = await imported(note('concurrent', 'ConcurrentCanary initial dependency.'));
  const first = note('concurrent-one', 'ConcurrentCanary supplier is ready.', {
    sourceKey: 'concurrent',
    expectedVersion: 1,
  });
  const second = note('concurrent-two', 'ConcurrentCanary supplier is delayed.', {
    sourceKey: 'concurrent',
    expectedVersion: 1,
  });
  const outcomes = await Promise.all([
    store.importSource(context, randomUUID(), first),
    store.importSource(context, randomUUID(), second),
  ]);
  assert.deepEqual(outcomes.map((r) => r.status).sort(), ['conflict', 'ok']);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM cos.source_revisions WHERE source_id=$1', [a.source_id])).rows[0]
      .n,
    2,
  );
});
test('S02-T06: source revocation reuses exact owner approval, fences context and quarantines derivatives', async () => {
  const a = await imported(note('approval-revoke', 'ApprovalRevokeCanary private source.')),
    ctx = { ...context, generation: randomUUID() };
  const read = await store.search(ctx, { query: 'ApprovalRevokeCanary' });
  assert.equal(read.status, 'ok');
  const evidence = (read.items as Evidence[])[0],
    artifactId = 'answer-' + randomUUID();
  await pool.query(
    "INSERT INTO cos.artifacts(id,scope_id,kind,digest,byte_length,lifecycle,provenance) VALUES($1,$2,'answer',$3,0,'published','{}')",
    [artifactId, scope, 'a'.repeat(64)],
  );
  await pool.query('INSERT INTO cos.derivation_links(scope_id,artifact_id,evidence_id) VALUES($1,$2,$3)', [
    scope,
    artifactId,
    evidence.evidence_id,
  ]);
  const priorities = new PriorityStore(store.database, store);
  const request = randomUUID(),
    change = {
      kind: 'source_revoke' as const,
      source_id: String(a.source_id),
      expected_version: 1,
      reason: 'Owner withdrew the selected source',
    };
  const proposed = await priorities.propose(context, request, change);
  assert.equal(proposed.status, 'ok');
  assert.deepEqual(await priorities.propose(context, request, change), proposed);
  assert.equal((await store.get(ctx, String(a.source_id), String(a.revision_id), 0)).status, 'ok');
  assert.equal(
    (
      await priorities.decide(
        { ...context, ownerId: 'foreign', ingressId: randomUUID() },
        String(proposed.proposal_id),
        String(proposed.confirmation_token),
        'approve',
      )
    ).status,
    'denied',
  );
  assert.equal(
    (
      await priorities.decide(
        { ...context, ingressId: randomUUID() },
        String(proposed.proposal_id),
        String(proposed.confirmation_token),
        'approve',
      )
    ).status,
    'ok',
  );
  assert.equal((await priorities.apply(scope, String(proposed.proposal_id))).status, 'ok');
  assert.equal((await priorities.apply(scope, String(proposed.proposal_id))).status, 'ok');
  const invalidations = await store.pendingInvalidations(scope);
  assert.equal(invalidations.status, 'ok');
  const job = (invalidations.items as Array<{ id: string }>).find(
    (item) => item.id === 'knowledge-proposal-' + proposed.proposal_id,
  );
  assert.ok(job);
  assert.equal((await store.acknowledgeInvalidation(other, job.id)).status, 'denied');
  assert.equal((await store.acknowledgeInvalidation(scope, job.id)).status, 'ok');
  assert.equal((await store.acknowledgeInvalidation(scope, job.id)).status, 'ok');
  assert.equal(
    ((await store.pendingInvalidations(scope)).items as Array<{ id: string }>).some((item) => item.id === job.id),
    false,
  );
  assert.deepEqual(await priorities.propose(context, request, change), proposed);
  assert.equal((await store.contextReady(ctx)).status, 'denied');
  assert.equal(
    (await store.get({ ...ctx, generation: randomUUID() }, String(a.source_id), String(a.revision_id), 0)).status,
    'denied',
  );
  assert.equal(
    (await pool.query('SELECT lifecycle FROM cos.artifacts WHERE id=$1', [artifactId])).rows[0].lifecycle,
    'quarantined',
  );
  assert.equal((await pool.query('SELECT version FROM cos.sources WHERE id=$1', [a.source_id])).rows[0].version, 2);
  assert.equal(
    (
      await pool.query('SELECT kind FROM cos.revocation_tombstones WHERE scope_id=$1 AND source_id=$2', [
        scope,
        a.source_id,
      ])
    ).rows[0].kind,
    'revoke',
  );
});
test('S02-T06: deletion requires the exact current owner proposal and preserves its retention deadline on replay', async () => {
  const a = await imported(note('approval-delete', 'DeleteCanary private source.'));
  const retentionMs = 7200000;
  const knowledge = new KnowledgeStore(store.database, artifacts, {}, { retentionMs });
  const priorities = new PriorityStore(store.database, knowledge);
  const change = {
    kind: 'source_delete' as const,
    source_id: String(a.source_id),
    expected_version: 1,
    reason: 'Remove the selected synthetic note',
  };
  assert.equal(
    (await priorities.propose({ ...context, scopeId: other, agentGroupId: other }, randomUUID(), change)).status,
    'denied',
  );
  const rejected = await priorities.propose(context, randomUUID(), change);
  assert.equal(rejected.status, 'ok');
  assert.equal(
    (
      await priorities.decide(
        { ...context, ingressId: randomUUID() },
        String(rejected.proposal_id),
        String(rejected.confirmation_token),
        'reject',
      )
    ).status,
    'ok',
  );
  assert.equal((await priorities.apply(scope, String(rejected.proposal_id))).status, 'denied');
  const request = randomUUID(),
    proposal = await priorities.propose(context, request, change);
  assert.equal(proposal.status, 'ok');
  assert.equal((await priorities.apply(scope, String(proposal.proposal_id))).status, 'denied');
  assert.equal(
    (
      await priorities.decide(
        { ...context, ingressId: randomUUID() },
        String(proposal.proposal_id),
        String(proposal.confirmation_token),
        'approve',
      )
    ).status,
    'ok',
  );
  assert.equal((await priorities.apply(scope, String(proposal.proposal_id))).status, 'ok');
  const tombstone = (
    await pool.query(
      'SELECT kind,purge_after,EXTRACT(EPOCH FROM (purge_after-created_at))*1000 AS retention FROM cos.revocation_tombstones WHERE scope_id=$1 AND source_id=$2',
      [scope, a.source_id],
    )
  ).rows[0];
  assert.equal(tombstone.kind, 'delete');
  assert.ok(Math.abs(Number(tombstone.retention) - retentionMs) < 1000);
  assert.equal((await priorities.apply(scope, String(proposal.proposal_id))).status, 'ok');
  assert.deepEqual(await priorities.propose(context, request, change), proposal);
  assert.equal(
    (
      await pool.query('SELECT purge_after FROM cos.revocation_tombstones WHERE scope_id=$1 AND source_id=$2', [
        scope,
        a.source_id,
      ])
    ).rows[0].purge_after.toISOString(),
    tombstone.purge_after.toISOString(),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM cos.outbox WHERE scope_id=$1 AND kind='knowledge_purge' AND payload->>'source_id'=$2",
        [scope, a.source_id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await store.get({ ...context, generation: randomUUID() }, String(a.source_id), String(a.revision_id), 0)).status,
    'denied',
  );
  assert.equal(
    (await priorities.propose(context, randomUUID(), { ...change, kind: 'source_revoke', expected_version: 2 })).status,
    'denied',
  );
});
test('S02-T06: a correction after preview makes the approved source action conflict without removing the new revision', async () => {
  const a = await imported(note('stale-approval', 'StaleApprovalCanary original note.'));
  const priorities = new PriorityStore(store.database, store);
  const proposal = await priorities.propose(context, randomUUID(), {
    kind: 'source_revoke',
    source_id: String(a.source_id),
    expected_version: 1,
    reason: 'Revoke the reviewed version',
  });
  assert.equal(proposal.status, 'ok');
  const revised = await imported(note('stale-approval', 'StaleApprovalCanary corrected note.', { expectedVersion: 1 }));
  assert.equal(
    (
      await priorities.decide(
        { ...context, ingressId: randomUUID() },
        String(proposal.proposal_id),
        String(proposal.confirmation_token),
        'approve',
      )
    ).status,
    'ok',
  );
  assert.equal((await priorities.apply(scope, String(proposal.proposal_id))).status, 'conflict');
  assert.equal((await priorities.apply(scope, String(proposal.proposal_id))).status, 'conflict');
  assert.equal(
    (await store.get({ ...context, generation: randomUUID() }, String(a.source_id), String(revised.revision_id), 0))
      .status,
    'ok',
  );
});
test('S02-T10: the durable revocation job invalidates exposed native state while preserving pause and retry safety', async () => {
  const a = await imported(note('native-invalidation', 'NativeInvalidationCanary source.'));
  const ctx = { ...context, generation: randomUUID() };
  assert.equal((await store.search(ctx, { query: 'NativeInvalidationCanary' })).status, 'ok');
  const priorities = new PriorityStore(store.database, store);
  const proposal = await priorities.propose(context, randomUUID(), {
    kind: 'source_revoke',
    source_id: String(a.source_id),
    expected_version: 1,
    reason: 'Withdraw synthetic source from context',
  });
  assert.equal(proposal.status, 'ok');
  assert.equal(
    (
      await priorities.decide(
        { ...context, ingressId: randomUUID() },
        String(proposal.proposal_id),
        String(proposal.confirmation_token),
        'approve',
      )
    ).status,
    'ok',
  );
  assert.equal((await priorities.apply(scope, String(proposal.proposal_id))).status, 'ok');
  const db = new Database(':memory:'),
    inbound = new Database(':memory:'),
    outbound = new Database(':memory:');
  try {
    const binding: CosBinding = {
      scopeId: scope,
      agentGroupId: scope,
      messagingGroupId: scope,
      sessionId: scope,
      provider: 'codex',
      instanceId: 'fixture-instance',
      channelId: scope,
      ownerId: 'fixture-owner',
      botId: 'fixture-bot',
    };
    const session = {
      id: scope,
      agent_group_id: scope,
      messaging_group_id: scope,
      thread_id: null,
      status: 'active',
      agent_provider: 'codex',
    } as Session;
    installCosBoundary(binding, db);
    ensureConversationSchema(db);
    db.prepare(
      "INSERT INTO cos_conversation_states(scope_id,binding_digest,account_fingerprint,generation,status,updated_at) VALUES(?,?,?,?,'active',?)",
    ).run(scope, digest(binding), 'a'.repeat(64), ctx.generation, new Date().toISOString());
    const root = path.join(base, 'recovery-' + randomUUID());
    fs.mkdirSync(root, { mode: 0o700 });
    fs.mkdirSync(path.join(root, 'conversations'), { mode: 0o700 });
    const oldHome = path.join(root, 'conversations', ctx.generation);
    fs.mkdirSync(oldHome, { mode: 0o700 });
    fs.writeFileSync(path.join(oldHome, 'history'), 'NativeInvalidationCanary retained source context.', {
      mode: 0o600,
    });
    inbound.exec(INBOUND_SCHEMA);
    outbound.exec(OUTBOUND_SCHEMA);
    ensureModelBudget(db);
    inbound.exec(
      "INSERT INTO messages_in(id,kind,timestamp,content) VALUES('stale-input','chat','fixture','NativeInvalidationCanary stale prompt')",
    );
    outbound.exec(
      "INSERT INTO messages_out(id,kind,timestamp,content) VALUES('stale-output','chat','fixture','NativeInvalidationCanary stale reply')",
    );
    outbound
      .prepare('INSERT INTO session_state VALUES(?,?,?)')
      .run('continuation:cos-codex-subscription:' + ctx.generation, 'old-native-thread', 'fixture');
    const options = {
      root,
      db,
      inbound,
      outbound,
      binding,
      accountFingerprint: 'a'.repeat(64),
      assertAuthority: () => {
        assert.deepEqual(db.prepare('SELECT paused FROM cos_identity_boundaries').get(), { paused: 1 });
      },
    };
    const policy: SubscriptionActivation = {
      version: 2,
      runtime: 'codex-subscription/v1',
      activationId: randomUUID().replaceAll('-', ''),
      scopeId: scope,
      provider: 'codex',
      model: 'fixture-model',
      consentRef: 'synthetic recovery test only',
      maxAttempts: 2,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      accountFingerprint: options.accountFingerprint,
      contextGeneration: ctx.generation,
    };
    issueActivation(options, policy);
    assert.equal(reserveSubscriptionAttempt(db, policy, 'fixture-ingress', randomUUID()), true);
    let stops = 0;
    const dependencies = {
      db,
      store,
      session: () => session,
      stop: (id: string) => {
        assert.equal(id, scope);
        stops++;
        assert.deepEqual(db.prepare('SELECT status,generation FROM cos_conversation_states').get(), {
          status: 'invalidated',
          generation: ctx.generation,
        });
        assert.deepEqual(db.prepare('SELECT paused FROM cos_identity_boundaries').get(), { paused: 1 });
      },
    };
    await new KnowledgeInvalidation(dependencies).drain(binding);
    assert.equal(stops, 1);
    assert.deepEqual((await store.pendingInvalidations(scope)).items, []);
    await new KnowledgeInvalidation(dependencies).drain(binding);
    assert.equal(stops, 1);
    assert.equal((await store.contextReady(ctx)).status, 'denied');
    const request = { expectedGeneration: ctx.generation, recoveryId: randomUUID() };
    const recovered = await recoverConversation({ ...options, ...request, backup: async () => {} });
    assert.equal(rebindRecoveredActivation(options, request).status, 'rebound_paused');
    assert.deepEqual(db.prepare('SELECT used FROM cos_model_budgets').get(), { used: 1 });
    assert.deepEqual(fs.readdirSync(path.join(root, 'conversations', recovered.generation)), []);
    assert.equal(
      outbound
        .prepare('SELECT value FROM session_state WHERE key=?')
        .get('continuation:cos-codex-subscription:' + recovered.generation),
      undefined,
    );
    assert.deepEqual(inbound.prepare("SELECT status,trigger FROM messages_in WHERE id='stale-input'").get(), {
      status: 'failed',
      trigger: 0,
    });
    assert.deepEqual(inbound.prepare("SELECT status FROM delivered WHERE message_out_id='stale-output'").get(), {
      status: 'quarantined_context_recovery',
    });
    const cleanContext = { ...ctx, generation: recovered.generation, ingressId: randomUUID() };
    const clean = await store.search(cleanContext, { query: 'NativeInvalidationCanary' });
    assert.equal(clean.status, 'ok');
    assert.deepEqual(clean.items, []);
    const answer = await store.answers.prepare(cleanContext, randomUUID(), {
      kind: 'answer',
      coverage: 'insufficient',
      claims: [],
    });
    assert.equal(answer.status, 'ok');
    assert.equal(JSON.stringify(answer).includes('NativeInvalidationCanary'), false);
    assert.deepEqual(db.prepare('SELECT paused FROM cos_identity_boundaries').get(), { paused: 1 });
  } finally {
    db.close();
    inbound.close();
    outbound.close();
  }
});
test('S02-T08: cleanup cannot pass an import awaiting metadata admission and preserves current references', async () => {
  let reached!: () => void, release!: () => void;
  const published = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const importer = new KnowledgeStore(store.database, artifacts, {
    afterPublication: async () => {
      reached();
      await hold;
    },
  });
  const input = note('gc-import', 'GarbageCollectionCanary admitted note.'),
    request = randomUUID();
  const importing = importer.importSource(context, request, input);
  try {
    await published;
    assert.equal((await store.reconcileArtifacts(0)).status, 'unavailable');
    assert.equal(
      (await store.importSource(context, randomUUID(), note('gc-competing', 'Competing import.'))).status,
      'unavailable',
    );
  } finally {
    release();
  }
  const admitted = await importing;
  assert.equal(admitted.status, 'ok');
  const orphan = await artifacts.exclusive(async (lease) =>
    artifacts.capture(scope, note('gc-orphan', 'Orphan not admitted.').filename, lease),
  );
  fs.utimesSync(path.join(artifacts.root, orphan.id + '.blob'), 0, 0);
  fs.writeFileSync(path.join(artifacts.root, 'unrelated.txt'), 'keep', { mode: 0o600 });
  const cleaned = await store.reconcileArtifacts(0);
  assert.equal(cleaned.status, 'ok');
  assert.equal(fs.existsSync(path.join(artifacts.root, orphan.id + '.blob')), false);
  assert.equal(fs.readFileSync(path.join(artifacts.root, 'unrelated.txt'), 'utf8'), 'keep');
  assert.equal(
    (
      await store.get(
        { ...context, generation: randomUUID() },
        String(admitted.source_id),
        String(admitted.revision_id),
        0,
      )
    ).status,
    'ok',
  );
  assert.deepEqual(await store.importSource(context, request, input), admitted);
});
test('S02-PG02: artifact cleanup never deletes from an unavailable reference snapshot', async () => {
  const orphan = await artifacts.exclusive(async (lease) =>
    artifacts.capture(scope, note('gc-outage', 'Orphan outage canary.').filename, lease),
  );
  fs.utimesSync(path.join(artifacts.root, orphan.id + '.blob'), 0, 0);
  const relay = await connectionFault(await fixtureDatabaseConfig()),
    database = new BoundedDatabase(new pg.Pool(relay.config), 350);
  const fault = new KnowledgeStore(database, artifacts);
  try {
    await database.run((client) => client.query('SELECT 1'));
    relay.partition();
    assert.equal((await fault.reconcileArtifacts(0)).status, 'unavailable');
    assert.equal(artifacts.read(orphan.id, orphan.digest), 'Orphan outage canary.');
  } finally {
    await database.pool.end();
    await relay.close();
  }
});
test('S02-PG01: cleanup waits for an uncertain remote metadata commit before taking its reference snapshot', async () => {
  const captured = await artifacts.exclusive(async (lease) =>
    artifacts.capture(scope, note('gc-commit', 'Commit barrier canary.').filename, lease),
  );
  fs.utimesSync(path.join(artifacts.root, captured.id + '.blob'), 0, 0);
  await admin.query('BEGIN');
  let cleaning: ReturnType<KnowledgeStore['reconcileArtifacts']> | undefined;
  try {
    await admin.query('SELECT pg_advisory_xact_lock(73101004)');
    await admin.query(
      "INSERT INTO cos.artifacts(id,scope_id,kind,digest,byte_length,lifecycle,provenance) VALUES($1,$2,'source',$3,$4,'published','{}')",
      [captured.id, scope, captured.digest, captured.byteLength],
    );
    cleaning = store.reconcileArtifacts(0);
    let waiting = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      waiting = (
        await admin.query(
          "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=73101004 AND NOT granted) AS waiting",
        )
      ).rows[0].waiting;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true);
    await admin.query('COMMIT');
    assert.equal((await cleaning).status, 'ok');
    assert.equal(artifacts.read(captured.id, captured.digest), 'Commit barrier canary.');
  } finally {
    await admin.query('ROLLBACK');
    await cleaning;
  }
});
async function approveDeletion(knowledge: KnowledgeStore, sourceId: string, expectedVersion = 1) {
  const priorities = new PriorityStore(knowledge.database, knowledge);
  const proposal = await priorities.propose(context, randomUUID(), {
    kind: 'source_delete',
    source_id: sourceId,
    expected_version: expectedVersion,
    reason: 'Delete selected synthetic source',
  });
  assert.equal(proposal.status, 'ok');
  assert.equal(
    (
      await priorities.decide(
        { ...context, ingressId: randomUUID() },
        String(proposal.proposal_id),
        String(proposal.confirmation_token),
        'approve',
      )
    ).status,
    'ok',
  );
  assert.equal((await priorities.apply(scope, String(proposal.proposal_id))).status, 'ok');
  return String(proposal.proposal_id);
}
test('S02-T06: due deletion purges raw capture, full-text chunks and linked derivatives but retains the tombstone', async () => {
  const a = await imported(note('purge-source', 'PurgeSourceCanary private text.'));
  const read = await store.search({ ...context, generation: randomUUID() }, { query: 'PurgeSourceCanary' }),
    evidence = (read.items as Evidence[])[0];
  const derived = await artifacts.exclusive(async (lease) =>
    artifacts.capture(scope, note('purge-answer', 'PurgeSourceCanary synthetic derived answer.').filename, lease),
  );
  await pool.query(
    "INSERT INTO cos.artifacts(id,scope_id,kind,digest,byte_length,lifecycle,provenance) VALUES($1,$2,'answer',$3,$4,'published','{}')",
    [derived.id, scope, derived.digest, derived.byteLength],
  );
  await pool.query('INSERT INTO cos.derivation_links(scope_id,artifact_id,evidence_id) VALUES($1,$2,$3)', [
    scope,
    derived.id,
    evidence.evidence_id,
  ]);
  const sourceArtifact = (await pool.query('SELECT artifact_id FROM cos.source_revisions WHERE id=$1', [a.revision_id]))
    .rows[0].artifact_id;
  const purge = new KnowledgeStore(store.database, artifacts, {}, { retentionMs: 0 });
  const proposal = await approveDeletion(purge, String(a.source_id));
  assert.equal(fs.existsSync(path.join(artifacts.root, sourceArtifact + '.blob')), true);
  assert.deepEqual(await purge.purgeDue(other), { status: 'ok', processed: 0 });
  assert.equal(fs.existsSync(path.join(artifacts.root, sourceArtifact + '.blob')), true);
  assert.equal((await purge.purgeDue(scope)).status, 'ok');
  for (const id of [sourceArtifact, derived.id]) {
    assert.equal(fs.existsSync(path.join(artifacts.root, id + '.blob')), false);
    assert.equal(
      (await pool.query('SELECT lifecycle FROM cos.artifacts WHERE id=$1', [id])).rows[0].lifecycle,
      'deleted',
    );
  }
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM cos.chunks WHERE revision_id=$1', [a.revision_id])).rows[0].n,
    0,
  );
  const tombstone = (
    await pool.query('SELECT kind,provenance FROM cos.revocation_tombstones WHERE scope_id=$1 AND source_id=$2', [
      scope,
      a.source_id,
    ])
  ).rows[0];
  assert.equal(tombstone.kind, 'delete');
  assert.equal(tombstone.provenance.content_purge.state, 'completed');
  assert.ok(
    (await pool.query('SELECT delivered_at FROM cos.outbox WHERE id=$1', ['knowledge-purge-' + proposal])).rows[0]
      .delivered_at,
  );
  assert.equal((await purge.purgeDue(scope)).status, 'ok');
  assert.equal(
    (await store.get({ ...context, generation: randomUUID() }, String(a.source_id), String(a.revision_id), 0)).status,
    'denied',
  );
  assert.equal(
    (await store.importSource(context, randomUUID(), note('purge-source', 'PurgeSourceCanary private text.'))).status,
    'denied',
  );
  assert.equal(fs.existsSync(path.join(artifacts.root, sourceArtifact + '.blob')), false);
  assert.equal(
    (await store.importSource(context, randomUUID(), note('purge-reintroduced', 'PurgeSourceCanary private text.')))
      .status,
    'conflict',
  );
  assert.equal(fs.existsSync(path.join(artifacts.root, sourceArtifact + '.blob')), false);
});
test('S02-T06: retention deadlines and other admitted references prevent premature byte deletion', async () => {
  const text = 'SharedPurgeCanary shared content.';
  const a = await imported(note('purge-shared-a', text)),
    b = await imported(note('purge-shared-b', text));
  const artifactId = (await pool.query('SELECT artifact_id FROM cos.source_revisions WHERE id=$1', [a.revision_id]))
    .rows[0].artifact_id;
  const purge = new KnowledgeStore(store.database, artifacts, {}, { retentionMs: 0 });
  await approveDeletion(purge, String(a.source_id));
  assert.equal((await purge.purgeDue(scope)).status, 'ok');
  assert.equal(fs.existsSync(path.join(artifacts.root, artifactId + '.blob')), true);
  assert.equal(
    (await store.get({ ...context, generation: randomUUID() }, String(b.source_id), String(b.revision_id), 0)).status,
    'ok',
  );
  await approveDeletion(store, String(b.source_id));
  assert.equal((await purge.purgeDue(scope)).status, 'ok');
  assert.equal(fs.existsSync(path.join(artifacts.root, artifactId + '.blob')), true);
  await pool.query(
    "UPDATE cos.revocation_tombstones SET purge_after=clock_timestamp()-interval '1 second' WHERE scope_id=$1 AND source_id=$2",
    [scope, b.source_id],
  );
  assert.equal((await purge.purgeDue(scope)).status, 'ok');
  assert.equal(fs.existsSync(path.join(artifacts.root, artifactId + '.blob')), false);
});
test('S02-T08: interrupted purge resumes from committed metadata and missing bytes without reopening access', async () => {
  const a = await imported(note('purge-retry', 'PurgeRetryCanary private text.'));
  let fail = true;
  const purge = new KnowledgeStore(
    store.database,
    artifacts,
    {
      afterPurgeUnlink: async () => {
        if (fail) throw new Error('fixture interrupted after unlink');
      },
    },
    { retentionMs: 0 },
  );
  const proposal = await approveDeletion(purge, String(a.source_id));
  await assert.rejects(purge.purgeDue(scope), /fixture interrupted after unlink/);
  assert.equal(
    (await pool.query('SELECT delivered_at FROM cos.outbox WHERE id=$1', ['knowledge-purge-' + proposal])).rows[0]
      .delivered_at,
    null,
  );
  assert.equal(
    (await store.get({ ...context, generation: randomUUID() }, String(a.source_id), String(a.revision_id), 0)).status,
    'denied',
  );
  fail = false;
  assert.equal((await purge.purgeDue(scope)).status, 'ok');
  assert.ok(
    (await pool.query('SELECT delivered_at FROM cos.outbox WHERE id=$1', ['knowledge-purge-' + proposal])).rows[0]
      .delivered_at,
  );
});
test('S02-PG02: a database outage blocks purge before byte removal and reconciles a lost final acknowledgement', async () => {
  const a = await imported(note('purge-outage', 'PurgeOutageCanary private text.'));
  const artifactId = (await pool.query('SELECT artifact_id FROM cos.source_revisions WHERE id=$1', [a.revision_id]))
    .rows[0].artifact_id;
  const relay = await connectionFault(await fixtureDatabaseConfig()),
    database = new BoundedDatabase(new pg.Pool(relay.config), 350);
  let fail = true;
  const purge = new KnowledgeStore(
    database,
    artifacts,
    {
      afterPurgeUnlink: async () => {
        if (fail) relay.partition();
      },
    },
    { retentionMs: 0 },
  );
  const proposal = await approveDeletion(purge, String(a.source_id));
  try {
    relay.partition();
    assert.ok(['unavailable', 'pending'].includes((await purge.purgeDue(scope)).status));
    assert.equal(fs.existsSync(path.join(artifacts.root, artifactId + '.blob')), true);
    relay.restore();
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.ok(['unavailable', 'pending'].includes((await purge.purgeDue(scope)).status));
    assert.equal(fs.existsSync(path.join(artifacts.root, artifactId + '.blob')), false);
    assert.equal(
      (await pool.query('SELECT delivered_at FROM cos.outbox WHERE id=$1', ['knowledge-purge-' + proposal])).rows[0]
        .delivered_at,
      null,
    );
    fail = false;
    relay.restore();
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.equal((await purge.purgeDue(scope)).status, 'ok');
    assert.ok(
      (await pool.query('SELECT delivered_at FROM cos.outbox WHERE id=$1', ['knowledge-purge-' + proposal])).rows[0]
        .delivered_at,
    );
  } finally {
    await database.pool.end();
    await relay.close();
  }
});
test('S02-T02/T07: prepared answers carry checked citations and provenance without becoming approved direction', async () => {
  const a = await imported(note('answer-source', 'AnswerCanary supplier approval is pending.'));
  const ctx = { ...context, generation: randomUUID() },
    read = await store.search(ctx, { query: 'AnswerCanary' }),
    evidence = (read.items as Evidence[])[0];
  const draft: AnswerDraft = {
    kind: 'answer',
    coverage: 'limited',
    claims: [
      {
        kind: 'quote',
        text: 'supplier approval is pending.',
        citations: [{ kind: 'source', evidence_id: evidence.evidence_id }],
      },
      {
        kind: 'inference',
        text: 'Ask the supplier for a decision date.',
        citations: [{ kind: 'source', evidence_id: evidence.evidence_id }],
      },
    ],
  };
  const request = randomUUID(),
    prepared = await store.answers.prepare(ctx, request, draft);
  assert.equal(prepared.status, 'ok');
  assert.match(String(prepared.text), /Inference: Ask/);
  assert.equal((await store.answers.authorizePublication(ctx, String(prepared.text))).status, 'ok');
  assert.equal(
    (await store.answers.authorizePublication(ctx, String(prepared.text) + ' Unsupported extra claim.')).status,
    'denied',
  );
  assert.equal(
    (await store.answers.authorizePublication({ ...ctx, ingressId: randomUUID() }, String(prepared.text))).status,
    'denied',
  );
  assert.deepEqual(await store.answers.prepare(ctx, request, draft), prepared);
  assert.equal((await store.answers.prepare(ctx, request, { ...draft, kind: 'summary' })).status, 'conflict');
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM cos.derivation_links WHERE artifact_id=$1', [
        prepared.artifact_id,
      ])
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM cos.records WHERE scope_id=$1', [scope])).rows[0].n,
    0,
  );
  assert.equal(JSON.stringify(prepared).includes(artifacts.root), false);
  assert.equal(
    (
      await store.answers.get(
        { ...ctx, scopeId: other, agentGroupId: other, sessionId: other },
        String(prepared.artifact_id),
      )
    ).status,
    'denied',
  );
  assert.equal(
    (
      await store.answers.prepare(ctx, randomUUID(), {
        ...draft,
        claims: [{ ...draft.claims[0], text: 'The supplier approved it.' }],
      })
    ).status,
    'denied',
  );
  assert.equal(
    (await store.answers.prepare({ ...ctx, generation: randomUUID() }, randomUUID(), draft)).status,
    'denied',
  );
  const fresh = { ...ctx, generation: randomUUID() };
  assert.equal((await store.answers.authorizePublication(fresh, String(prepared.text))).status, 'denied');
  assert.equal((await store.answers.get(fresh, String(prepared.artifact_id))).status, 'ok');
  assert.equal((await store.answers.authorizePublication(fresh, String(prepared.text))).status, 'ok');
  await imported(note('answer-source', 'AnswerCanary supplier approval has arrived.', { expectedVersion: 1 }));
  assert.equal((await store.contextReady(fresh)).status, 'denied');
  assert.equal((await store.answers.authorizePublication(fresh, String(prepared.text))).status, 'denied');
  assert.equal(
    (await store.answers.get({ ...ctx, generation: randomUUID() }, String(prepared.artifact_id))).status,
    'denied',
  );
  assert.equal(
    (await pool.query('SELECT lifecycle FROM cos.artifacts WHERE id=$1', [prepared.artifact_id])).rows[0].lifecycle,
    'quarantined',
  );
  assert.notEqual(a.revision_id, undefined);
});
test('S02-T02/T06: actual RPC and final private chat boundary enforce exact prepared answers and current revocation', async () => {
  const ctx = { ...context, generation: randomUUID() };
  const importedSource = await imported(note('answer-delivery', 'DeliveryCanary supplier approval is pending.'));
  const db = initTestDb();
  const binding: CosBinding = {
    scopeId: scope,
    ownerId: ctx.ownerId,
    sessionId: ctx.sessionId,
    agentGroupId: ctx.agentGroupId,
    messagingGroupId: scope,
    instanceId: 'fixture-instance',
    channelId: scope,
    botId: 'fixture-bot',
    provider: 'codex',
  };
  const session = {
    id: ctx.sessionId,
    agent_group_id: ctx.agentGroupId,
    messaging_group_id: scope,
    thread_id: null,
    agent_provider: 'codex',
    status: 'active',
  } as Session;
  installCosBoundary(binding, db);
  ensureConversationSchema(db);
  db.prepare('UPDATE cos_identity_boundaries SET paused=0,ingress_id=?,ingress_at=?').run(
    ctx.ingressId,
    new Date().toISOString(),
  );
  db.prepare(
    "INSERT INTO cos_conversation_states(scope_id,binding_digest,account_fingerprint,generation,status,updated_at) VALUES(?,?,?,?,'active',?)",
  ).run(scope, digest(binding), 'a'.repeat(64), ctx.generation, new Date().toISOString());
  const priorities = new PriorityStore(store.database, store);
  const runtime = createCosRuntime({
    db,
    enabled: true,
    store: priorities,
    facts: async () => ({
      id: scope,
      type: 'P',
      delete_at: 0,
      members: [binding.botId, binding.ownerId],
      activeSubscription: true,
    }),
    session: () => session,
    destination: () => undefined,
    stop: () => {},
    wake: async () => {},
  });
  const handler = createRpcHandler({
    store: priorities,
    knowledge: store,
    resolveContext: () => runtime.controller.context(session),
    resolveKnowledgeContext: async (actualSession, actualContext) =>
      resolveKnowledgeContext(actualSession, actualContext, db),
  });
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const requestId = randomUUID();
    await handler(
      {
        action: 'cos_rpc',
        delivery_id: randomUUID(),
        request: { protocol: 'cos-rpc/v1', request_id: requestId, method, params },
      },
      session,
      db,
    );
    const row = db.prepare('SELECT response FROM cos_rpc_responses WHERE request_id=?').get(requestId) as {
      response: string;
    };
    const response = JSON.parse(row.response);
    assert.equal(response.status, 'ok');
    return response.result;
  };
  const message = (text: string) => ({
    kind: 'chat',
    channel_type: 'mattermost',
    platform_id: `mattermost:fixture-instance:${scope}`,
    thread_id: 'visual-reply',
    content: JSON.stringify({ text }),
  });
  try {
    const clarification = await rpc('cos_answer_prepare', {
      draft: {
        kind: 'answer',
        coverage: 'not_applicable',
        claims: [],
        questions: ['Which project should we focus on?'],
        notice: 'approval_required',
      },
    });
    assert.equal(await permitCosOutbound(session, message(clarification.text)), true);
    assert.match(clarification.text, /Question: Which project/);
    assert.match(clarification.text, /require your approval/);
    assert.equal(
      (db.prepare('SELECT generation FROM cos_conversation_states').get() as { generation: string }).generation,
      ctx.generation,
    );
    const evidence = (await rpc('cos_knowledge_search', { query: 'DeliveryCanary' })).items[0];
    const prepared = await rpc('cos_answer_prepare', {
      draft: {
        kind: 'answer',
        coverage: 'limited',
        claims: [
          { kind: 'quote', text: evidence.text, citations: [{ kind: 'source', evidence_id: evidence.evidence_id }] },
        ],
      },
    });
    assert.equal(await permitCosOutbound(session, message(prepared.text)), true);
    assert.equal(
      await permitCosOutbound(session, { ...message(prepared.text), thread_id: 'another-visual-thread' }),
      true,
    );
    assert.equal(await permitCosOutbound(session, message(prepared.text + '\nUncited extra claim.')), false);
    assert.equal(
      await permitCosOutbound(session, {
        ...message(prepared.text),
        platform_id: 'mattermost:fixture-instance:foreign',
      }),
      false,
    );
    db.prepare('UPDATE cos_identity_boundaries SET ingress_id=?').run(randomUUID());
    assert.equal(await permitCosOutbound(session, message(prepared.text)), false);
    await rpc('cos_answer_get', { artifact_id: prepared.artifact_id });
    assert.equal(await permitCosOutbound(session, message(prepared.text)), true);
    await approveDeletion(store, String(importedSource.source_id));
    assert.equal(await permitCosOutbound(session, message(prepared.text)), false);
    const ordinary = { ...session, id: 'ordinary', agent_group_id: 'ordinary', messaging_group_id: 'ordinary' };
    assert.equal(await permitCosOutbound(ordinary, message('Ordinary chat remains available.')), true);
  } finally {
    runtime.dispose();
    closeDb();
  }
});
test('S02-T06: revocation during answer preparation cannot admit a publishable derivative', async () => {
  await imported(note('answer-race', 'AnswerRaceCanary private source.'));
  const ctx = { ...context, generation: randomUUID() },
    read = await store.search(ctx, { query: 'AnswerRaceCanary' }),
    evidence = (read.items as Evidence[])[0];
  const guarded = new KnowledgeStore(store.database, artifacts, {
    afterAnswerPublication: async () => {
      await pool.query("UPDATE cos.sources SET status='revoked',version=version+1 WHERE scope_id=$1 AND id=$2", [
        scope,
        evidence.source_id,
      ]);
    },
  });
  const result = await guarded.answers.prepare(ctx, randomUUID(), {
    kind: 'answer',
    coverage: 'limited',
    claims: [
      { kind: 'quote', text: evidence.text, citations: [{ kind: 'source', evidence_id: evidence.evidence_id }] },
    ],
  });
  assert.equal(result.status, 'denied');
  assert.equal(JSON.stringify(result).includes('AnswerRaceCanary'), false);
});
test('S02-PG02: historical answer redisplay fails closed when current database policy is unavailable', async () => {
  const ctx = { ...context, generation: randomUUID() };
  const prepared = await store.answers.prepare(ctx, randomUUID(), {
    kind: 'answer',
    coverage: 'insufficient',
    claims: [],
  });
  assert.equal(prepared.status, 'ok');
  const relay = await connectionFault(await fixtureDatabaseConfig()),
    database = new BoundedDatabase(new pg.Pool(relay.config), 350),
    fault = new KnowledgeStore(database, artifacts);
  try {
    assert.equal((await fault.answers.get(ctx, String(prepared.artifact_id))).status, 'ok');
    relay.partition();
    const result = await fault.answers.get(ctx, String(prepared.artifact_id));
    assert.equal(result.status, 'unavailable');
    assert.equal(result.text, undefined);
  } finally {
    await database.pool.end();
    await relay.close();
  }
});
test('S02-T07: priority summaries cite approved record versions without changing them and reject stale publication', async () => {
  const priorities = new PriorityStore(store.database, store),
    ctx = { ...context, generation: randomUUID() };
  const approve = async (change: Change) => {
    const proposal = await priorities.propose(context, randomUUID(), change);
    assert.equal(proposal.status, 'ok');
    assert.equal(
      (
        await priorities.decide(
          { ...context, ingressId: randomUUID() },
          String(proposal.proposal_id),
          String(proposal.confirmation_token),
          'approve',
        )
      ).status,
      'ok',
    );
    const result = await priorities.apply(scope, String(proposal.proposal_id));
    assert.equal(result.status, 'ok');
    return String(result.record_id);
  };
  const change: Change = {
    kind: 'project',
    title: 'Approved pilot',
    description: 'Obtain a supplier decision.',
    lifecycle: 'active',
    reason: 'Synthetic priority citation fixture',
    expected_version: 0,
  };
  const id = await approve(change);
  const prepared = await store.answers.prepare(ctx, randomUUID(), {
    kind: 'summary',
    coverage: 'limited',
    claims: [
      {
        kind: 'inference',
        text: 'Focus attention on the approved pilot.',
        citations: [{ kind: 'record', record_id: id, version: 1 }],
      },
    ],
  });
  assert.equal(prepared.status, 'ok');
  assert.equal(prepared.kind, 'summary');
  assert.match(String(prepared.text), /Approved project/);
  assert.equal((await pool.query('SELECT version FROM cos.records WHERE id=$1', [id])).rows[0].version, 1);
  assert.equal((await store.answers.authorizePublication(ctx, String(prepared.text))).status, 'ok');
  await approve({
    ...change,
    record_id: id,
    expected_version: 1,
    description: 'Supplier has confirmed; schedule the pilot.',
  });
  assert.equal((await store.answers.authorizePublication(ctx, String(prepared.text))).status, 'denied');
  assert.equal((await store.answers.get(ctx, String(prepared.artifact_id))).status, 'denied');
});
test('S02-PG01: answer publication losing database access admits no artifact and reconciles one retry', async () => {
  const relay = await connectionFault(await fixtureDatabaseConfig()),
    database = new BoundedDatabase(new pg.Pool(relay.config), 350);
  let fail = true;
  const fault = new KnowledgeStore(database, artifacts, {
    afterAnswerPublication: async () => {
      if (fail) relay.partition();
    },
  });
  const ctx = { ...context, generation: randomUUID() },
    request = randomUUID(),
    draft: AnswerDraft = { kind: 'answer', coverage: 'insufficient', claims: [] };
  try {
    assert.ok(['unavailable', 'pending'].includes((await fault.answers.prepare(ctx, request, draft)).status));
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM cos.operations WHERE session_id=$1 AND request_id=$2', [
          ctx.sessionId,
          request,
        ])
      ).rows[0].n,
      0,
    );
    fail = false;
    relay.restore();
    await new Promise((resolve) => setTimeout(resolve, 1050));
    const retry = await fault.answers.prepare(ctx, request, draft);
    assert.equal(retry.status, 'ok');
    assert.deepEqual(await fault.answers.prepare(ctx, request, draft), retry);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM cos.artifacts WHERE id=$1', [retry.artifact_id])).rows[0].n,
      1,
    );
  } finally {
    await database.pool.end();
    await relay.close();
  }
});
test('S02-T06/T10: conversational artifacts retain context-source dependencies through redisplay and deletion', async () => {
  const source = await imported(note('context-dependency', 'ContextDependencyCanary needs supplier approval.'));
  const ctx = { ...context, generation: randomUUID() };
  assert.equal((await store.search(ctx, { query: 'ContextDependencyCanary' })).status, 'ok');
  const answer = await store.answers.prepare(ctx, randomUUID(), {
    kind: 'answer',
    coverage: 'not_applicable',
    claims: [],
    questions: ['What should we do about ContextDependencyCanary?'],
  });
  assert.equal(answer.status, 'ok');
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM cos.derivation_links WHERE artifact_id=$1', [answer.artifact_id]))
      .rows[0].n,
    1,
  );
  const fresh = { ...ctx, generation: randomUUID() };
  await pool.query("UPDATE cos.sources SET processing_providers=ARRAY['claude'] WHERE scope_id=$1 AND id=$2", [
    scope,
    source.source_id,
  ]);
  assert.equal((await store.answers.get(fresh, String(answer.artifact_id))).status, 'denied');
  await pool.query("UPDATE cos.sources SET processing_providers=ARRAY['codex'] WHERE scope_id=$1 AND id=$2", [
    scope,
    source.source_id,
  ]);
  assert.equal((await store.answers.get(fresh, String(answer.artifact_id))).status, 'ok');
  const purge = new KnowledgeStore(store.database, artifacts, {}, { retentionMs: 0 });
  await approveDeletion(purge, String(source.source_id));
  assert.equal((await store.contextReady(ctx)).status, 'denied');
  assert.equal((await store.contextReady(fresh)).status, 'denied');
  assert.equal(
    (await store.answers.get({ ...ctx, generation: randomUUID() }, String(answer.artifact_id))).status,
    'denied',
  );
  assert.equal(
    (await pool.query('SELECT lifecycle FROM cos.artifacts WHERE id=$1', [answer.artifact_id])).rows[0].lifecycle,
    'quarantined',
  );
  assert.equal((await purge.purgeDue(scope)).status, 'ok');
  assert.equal(fs.existsSync(path.join(artifacts.root, String(answer.artifact_id) + '.blob')), false);
});
test('S02 rollback: retrieval disable preserves priority replies, revocation checks and due deletion', async () => {
  let enabled = true;
  const guarded = new KnowledgeStore(
    store.database,
    artifacts,
    {},
    { retentionMs: 0, retrievalEnabled: () => enabled },
  );
  const source = await imported(note('retrieval-switch', 'SwitchCanary supplier approval is pending.'));
  const ctx = { ...context, generation: randomUUID() };
  const found = await guarded.search(ctx, { query: 'SwitchCanary' });
  assert.equal(found.status, 'ok');
  const evidence = (found.items as Evidence[])[0];
  const answer = await guarded.answers.prepare(ctx, randomUUID(), {
    kind: 'answer',
    coverage: 'limited',
    claims: [
      { kind: 'quote', text: evidence.text, citations: [{ kind: 'source', evidence_id: evidence.evidence_id }] },
    ],
  });
  assert.equal(answer.status, 'ok');
  enabled = false;
  const fresh = { ...ctx, generation: randomUUID() };
  assert.equal((await guarded.search(fresh, { query: 'SwitchCanary' })).status, 'unavailable');
  assert.equal(
    (await guarded.get(fresh, String(source.source_id), String(source.revision_id), 0)).status,
    'unavailable',
  );
  assert.equal(
    (await guarded.importSource(context, randomUUID(), note('disabled-import', 'Never publish this.'))).status,
    'unavailable',
  );
  assert.equal((await guarded.answers.get(fresh, String(answer.artifact_id))).status, 'denied');
  assert.equal((await guarded.contextReady(ctx)).status, 'denied');
  assert.equal((await guarded.contextReady(fresh)).status, 'ok');
  const priorities = new PriorityStore(store.database, guarded);
  const approved = await priorities.context(fresh);
  assert.equal(approved.status, 'ok');
  const record = (approved.records as Array<{ id: string; version: number; title: string }>)[0];
  assert.ok(record);
  const reply = await guarded.answers.prepare(fresh, randomUUID(), {
    kind: 'answer',
    coverage: 'limited',
    claims: [
      {
        kind: 'quote',
        text: record.title,
        citations: [{ kind: 'record', record_id: record.id, version: record.version }],
      },
    ],
  });
  assert.equal(reply.status, 'ok');
  assert.equal((await guarded.answers.authorizePublication(fresh, String(reply.text))).status, 'ok');
  await approveDeletion(guarded, String(source.source_id));
  assert.equal((await guarded.purgeDue(scope)).status, 'ok');
  assert.equal(fs.existsSync(path.join(artifacts.root, String(answer.artifact_id) + '.blob')), false);
  enabled = true;
  assert.equal((await guarded.answers.get(fresh, String(answer.artifact_id))).status, 'denied');
  assert.equal((await guarded.get(fresh, String(source.source_id), String(source.revision_id), 0)).status, 'denied');
});
test('S02 rollback: a retrieval switch closed during disclosure returns no private content', async () => {
  let enabled = true;
  await imported(note('switch-race', 'SwitchRaceCanary private note.'));
  const guarded = new KnowledgeStore(
    store.database,
    artifacts,
    {
      beforeDisclosure: async () => {
        enabled = false;
      },
    },
    { retrievalEnabled: () => enabled },
  );
  const result = await guarded.search({ ...context, generation: randomUUID() }, { query: 'SwitchRaceCanary' });
  assert.equal(result.status, 'unavailable');
  assert.equal(JSON.stringify(result).includes('SwitchRaceCanary'), false);
});

test('S02 owner inventory pages every state without bodies, foreign scope or retrieval access', async () => {
  const states = ['admitted', 'indexing', 'current', 'stale', 'revoked', 'failed', 'unsupported'];
  const ids: string[] = [];
  for (const [index, status] of states.entries()) {
    const id = randomUUID();
    ids.push(id);
    await pool.query(
      `INSERT INTO cos.sources(id,scope_id,source_key,title,status,processing_providers,access_policy,provenance)
      VALUES($1,$2,$3,$4,$5,'{}','{}','{}')`,
      [id, other, 'inventory-' + index, 'Inventory ' + status, status],
    );
  }
  const owner = { ...context, scopeId: other, agentGroupId: other, sessionId: other };
  const disabled = new KnowledgeStore(store.database, artifacts, {}, { retrievalEnabled: () => false });
  const found: Array<Record<string, unknown>> = [];
  let after: string | undefined;
  do {
    const result = await disabled.inventory(owner, { limit: 2, ...(after ? { after } : {}) });
    assert.equal(result.status, 'ok');
    assert.ok(Array.isArray(result.items));
    assert.ok(result.items.length <= 2);
    found.push(...result.items);
    after = result.next_after as string | undefined;
  } while (after);
  assert.equal(new Set(found.map((row) => row.id)).size, found.length);
  for (const id of ids) assert.ok(found.some((row) => row.id === id));
  for (const status of states) {
    const result = await disabled.inventory(owner, { status, limit: 100 });
    assert.equal(result.status, 'ok');
    assert.ok((result.items as Array<{ status: string }>).every((row) => row.status === status));
  }
  assert.equal(JSON.stringify(found).includes('FOREIGN_CANARY'), false);
  assert.ok(found.every((row) => !('text' in row) && !('provenance' in row) && !('artifact_id' in row)));
  assert.deepEqual(await store.inventory({ ...context, scopeId: other }, { limit: 2 }), { status: 'denied' });
  for (const page of [
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { after: '../escape' },
    { status: 'missing' },
    { scopeId: other },
  ])
    assert.deepEqual(await store.inventory(owner, page), { status: 'denied' });
});
