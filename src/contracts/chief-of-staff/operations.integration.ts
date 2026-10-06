/** Synthetic scopes in the explicitly admitted external test target; no live transports. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import type { Context } from '../../modules/chief-of-staff/domain/contracts.js';
import { STATUS_CATEGORIES, type StatusInput } from '../../modules/chief-of-staff/contracts/operations-protocol.js';
import { connectionFault } from './connection-fault.js';
import { MISSION_DEFAULT_LIMITS } from '../../modules/chief-of-staff/contracts/mission-protocol.js';
import Database from 'better-sqlite3';
import { installCosBoundary, type CosBinding } from '../../cos-boundary.js';
import type { Session } from '../../types.js';
import { HostOwnerControls, parseOwnerControl } from '../../modules/chief-of-staff/ops/owner-controls.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeStore } from '../../modules/chief-of-staff/knowledge/store.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import { ownerDenialsPermitResume } from '../../modules/chief-of-staff/ops/owner-denial-resume.js';
import { CalendarStore } from '../../modules/chief-of-staff/calendar/store.js';
import { CalendarConnector } from '../../modules/chief-of-staff/calendar/connector.js';
import { CalendarReadError, GOOGLE_EVENT_READ_SCOPE } from '../../modules/chief-of-staff/calendar/reader.js';
import { exportOwnerRecords, purgeOwnerExports } from '../../modules/chief-of-staff/ops/owner-export.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
let admin: pg.Client, store: PriorityStore;
let knowledge: KnowledgeStore, artifactRoot: string;
const scope = 'operations-' + randomUUID(),
  foreign = 'operations-foreign-' + randomUUID();
const context: Context = {
  scopeId: scope,
  ownerId: 'fixture-owner',
  agentGroupId: scope,
  sessionId: scope,
  ingressId: randomUUID(),
};
const sentinel = 'PRIVATE-PROSE-NOT-STATUS-' + randomUUID();
before(async () => {
  console.log(JSON.stringify({ fixtureRun: scope, foreignFixtureRun: foreign }));
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  await migrate(admin, fixtureRuntimeUser());
  artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-s11-operations-'));
  for (const name of ['artifacts', 'staging']) fs.mkdirSync(path.join(artifactRoot, name), { mode: 0o700 });
  const database = BoundedDatabase.fromConfig(await fixtureDatabaseConfig(process.env));
  knowledge = new KnowledgeStore(
    database,
    new KnowledgeArtifacts(path.join(artifactRoot, 'artifacts'), path.join(artifactRoot, 'staging')),
  );
  store = new PriorityStore(database, knowledge);
  for (const id of [scope, foreign])
    await admin.query(
      "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,$2,'fixture',$1,$1,'active')",
      [id, context.ownerId],
    );
  for (const id of [scope, foreign])
    await admin.query(
      "INSERT INTO cos.sources(id,scope_id,source_key,title,status,processing_providers,access_policy,provenance) VALUES($1,$2,$1,$3,'current',ARRAY['codex'],'{}','{}')",
      ['source-' + id, id, sentinel],
    );
  for (let i = 0; i < 25; i++)
    await admin.query(
      "INSERT INTO cos.records(id,scope_id,kind,title,description,lifecycle,version,provenance) VALUES($1,$2,'goal',$3,$3,'active',1,'{}')",
      ['goal-' + String(i).padStart(2, '0') + '-' + scope, scope, sentinel],
    );
  await admin.query(
    "INSERT INTO cos.records(id,scope_id,kind,title,description,lifecycle,version,provenance) VALUES($1,$2,'goal',$3,$3,'active',1,'{}')",
    ['foreign-goal-' + foreign, foreign, sentinel],
  );
  await admin.query(
    "INSERT INTO cos.mission_template_versions(scope_id,id,version,body,digest,reviewed_by,provenance) VALUES($1,'fixture',1,'{}',$2,'fixture-owner','{}')",
    [scope, 'a'.repeat(64)],
  );
  await admin.query(
    "INSERT INTO cos.mission_context_manifests(scope_id,digest,body,provenance) VALUES($1,$2,'{}','{}')",
    [scope, 'b'.repeat(64)],
  );
  for (const state of [
    'proposed',
    'authorised',
    'queued',
    'running',
    'awaiting_review',
    'completed',
    'partial',
    'blocked',
    'failed',
    'cancelling',
    'cancelled',
  ]) {
    const id = 'mission-' + state + '-' + scope;
    await admin.query(
      "INSERT INTO cos.mission_work_orders(scope_id,id,body,digest,context_digest,template_id,template_version,provenance) VALUES($1,$2,$3,$4,$5,'fixture',1,'{}')",
      [
        scope,
        id,
        JSON.stringify({
          origin: context,
          request: { limits: MISSION_DEFAULT_LIMITS },
          related: { goal: { id: 'goal-00-' + scope } },
          private: sentinel,
        }),
        'c'.repeat(64),
        'b'.repeat(64),
      ],
    );
    await admin.query("INSERT INTO cos.missions(scope_id,id,state,provenance) VALUES($1,$2,$3,'{}')", [
      scope,
      id,
      state,
    ]);
  }
  for (const state of ['pending', 'approved', 'rejected', 'applied', 'conflict', 'expired'])
    await admin.query(
      "INSERT INTO cos.proposals(id,scope_id,session_id,ingress_id,owner_id,change,payload_hash,challenge_hash,state,expires_at) VALUES($1,$2,$2,$1,$3,$4,$5,$5,$6,clock_timestamp()+interval '1 hour')",
      [randomUUID(), scope, context.ownerId, JSON.stringify({ private: sentinel }), sentinel, state],
    );
});
after(async () => {
  await store?.database.pool.end();
  try {
    if (admin)
      for (const id of [scope, foreign]) {
        await admin.query('BEGIN');
        await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=$1', [id]);
        for (const table of [
          'action_receipts',
          'action_request_starts',
          'actions',
          'action_intents',
          'action_writer_revisions',
          'action_writer_bindings',
          'outbox',
          'events',
          'revocation_tombstones',
          'derivation_links',
          'evidence_refs',
          'chunks',
          'source_revisions',
          'sources',
          'artifacts',
          'calendar_states',
          'calendar_bindings',
          'missions',
          'mission_work_orders',
          'mission_context_manifests',
          'mission_template_versions',
          'operations',
          'proposals',
          'records',
        ])
          await admin.query('DELETE FROM cos.' + table + ' WHERE scope_id=$1', [id]);
        await admin.query('DELETE FROM cos.scopes WHERE id=$1', [id]);
        await admin.query('COMMIT');
      }
  } finally {
    await admin?.end();
    if (artifactRoot) fs.rmSync(artifactRoot, { recursive: true, force: true });
  }
});
test('S11-T01 status reports every category and approval state without secret/prose disclosure', async () => {
  const result = await store.operatorStatus(context, {});
  assert.equal(result.status, 'ok');
  const categories = result.categories as Array<{ category: string; states: Record<string, number> }>;
  assert.deepEqual(
    categories.map((x) => x.category),
    [...STATUS_CATEGORIES],
  );
  assert.deepEqual(categories.find((x) => x.category === 'proposals')?.states, {
    applied: 1,
    approved: 1,
    conflict: 1,
    expired: 1,
    pending: 1,
    rejected: 1,
  });
  assert.equal(categories.find((x) => x.category === 'priorities')?.states.active, 25);
  assert.equal(result.monetary_usage, 'unavailable');
  assert.equal(result.execution_authority, 'inspection_only');
  assert.ok(!JSON.stringify(result).includes(sentinel));
});
test('S11-T01 bounded pages carry safe purpose/authority/evidence references and preserve IDs', async () => {
  const first = await store.operatorStatus(context, { category: 'priorities', limit: 20 });
  const second = await store.operatorStatus(context, { category: 'priorities', offset: 20, limit: 20 });
  assert.equal(first.status, 'ok');
  assert.equal((first.items as unknown[]).length, 20);
  assert.equal(first.next_offset, 20);
  assert.equal((second.items as unknown[]).length, 5);
  assert.equal(second.next_offset, null);
  for (const item of [
    ...(first.items as Array<{
      id: string;
      state: string;
      purpose_ref: unknown;
      authority_ref: unknown;
      evidence_ref: unknown;
    }>),
    ...(second.items as Array<{
      id: string;
      state: string;
      purpose_ref: unknown;
      authority_ref: unknown;
      evidence_ref: unknown;
    }>),
  ]) {
    assert.equal(item.state, 'active');
    assert.deepEqual(item.purpose_ref, { kind: 'priority', id: item.id });
    assert.deepEqual(item.authority_ref, { kind: 'scope', id: scope });
    assert.deepEqual(item.evidence_ref, { kind: 'priority', id: item.id });
  }
  assert.ok(!JSON.stringify([first, second]).includes(foreign));
  assert.ok(!JSON.stringify([first, second]).includes(sentinel));
});
test('S11-T01 queued/running/review/blocked/partial/cancelled remain distinct and retain actual limits', async () => {
  const result = await store.operatorStatus(context, { category: 'missions' });
  assert.equal(result.status, 'ok');
  const states = (result.items as Array<{ state: string; limits: unknown }>).map((x) => x.state).sort();
  assert.deepEqual(
    states,
    [
      'proposed',
      'authorised',
      'queued',
      'running',
      'awaiting_review',
      'completed',
      'partial',
      'blocked',
      'failed',
      'cancelling',
      'cancelled',
    ].sort(),
  );
  for (const item of result.items as Array<{ limits: unknown }>) assert.deepEqual(item.limits, MISSION_DEFAULT_LIMITS);
});
test('S11-T08 a controlled test-route partition withholds status rather than reporting an empty healthy scope', async () => {
  const relay = await connectionFault(await fixtureDatabaseConfig(process.env)),
    pool = new pg.Pool(relay.config);
  const interrupted = new PriorityStore(new BoundedDatabase(pool, 500));
  try {
    assert.equal((await interrupted.operatorStatus(context, {})).status, 'ok');
    relay.partition();
    assert.deepEqual(await interrupted.operatorStatus(context, {}), { status: 'unavailable' });
    relay.restore();
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.equal((await interrupted.operatorStatus(context, {})).status, 'ok');
  } finally {
    await pool.end();
    await relay.close();
  }
});
test('S11-T02 inspection remains available while paused and cannot reopen admission', async () => {
  await admin.query("UPDATE cos.scopes SET status='paused' WHERE id=$1", [scope]);
  assert.equal((await store.operatorStatus(context, {})).status, 'ok');
  assert.equal((await admin.query('SELECT status FROM cos.scopes WHERE id=$1', [scope])).rows[0].status, 'paused');
  await admin.query("UPDATE cos.scopes SET status='active' WHERE id=$1", [scope]);
});
test('S11-T06 status denies foreign owners/groups, automatic tasks and extra authority fields', async () => {
  for (const c of [
    { ...context, ownerId: 'foreign' },
    { ...context, agentGroupId: foreign },
    { ...context, origin: { kind: 'schedule' as const, runId: randomUUID(), generation: 1 } },
  ])
    assert.deepEqual(await store.operatorStatus(c, {}), { status: 'denied' });
  assert.deepEqual(await store.operatorStatus(context, { scope_id: foreign } as unknown as StatusInput), {
    status: 'denied',
  });
  await admin.query("UPDATE cos.scopes SET status='revoked' WHERE id=$1", [scope]);
  try {
    assert.deepEqual(await store.operatorStatus(context, {}), { status: 'denied' });
  } finally {
    await admin.query("UPDATE cos.scopes SET status='active' WHERE id=$1", [scope]);
  }
});
test('S11-T02/UI01 a durable scoped cancellation survives a test-route outage and reconciles exactly once', async () => {
  const relay = await connectionFault(await fixtureDatabaseConfig(process.env)),
    pool = new pg.Pool(relay.config),
    interrupted = new PriorityStore(new BoundedDatabase(pool, 500));
  const db = new Database(':memory:'),
    binding: CosBinding = {
      scopeId: scope,
      ownerId: context.ownerId,
      botId: 'fixture-bot',
      instanceId: 'fixture',
      channelId: scope,
      agentGroupId: scope,
      messagingGroupId: 'messages-' + scope,
      sessionId: scope,
      provider: 'codex',
    };
  const session = {
    id: scope,
    agent_group_id: scope,
    messaging_group_id: binding.messagingGroupId,
    thread_id: null,
    status: 'active',
    agent_provider: 'codex',
  } as Session;
  installCosBoundary(binding, db);
  db.prepare('UPDATE cos_identity_boundaries SET paused=0').run();
  const controls = new HostOwnerControls({
    db,
    session: () => session,
    stop: () => {
      throw Error('ordinary-work-must-not-be-stopped');
    },
  });
  const mission = 'mission-queued-' + scope,
    ingress = {
      id: 'offline-cancel',
      ownerId: context.ownerId,
      text: 'cos cancel mission ' + mission,
      timestamp: new Date().toISOString(),
    };
  try {
    assert.equal((await interrupted.operatorStatus(context, {})).status, 'ok');
    relay.partition();
    assert.equal(controls.record(binding, ingress, parseOwnerControl(ingress.text)!).status, 'ok');
    await controls.reconcile(binding, (c, id) => interrupted.missionRuns.cancel(c, id));
    assert.deepEqual(db.prepare('SELECT state FROM cos_operator_denials').get(), { state: 'recorded' });
    assert.equal(
      (await admin.query('SELECT state FROM cos.missions WHERE scope_id=$1 AND id=$2', [scope, mission])).rows[0].state,
      'queued',
    );
    relay.restore();
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.equal((await interrupted.missionRuns.cancel({ ...context, ownerId: 'foreign' }, mission)).status, 'denied');
    await controls.reconcile(binding, (c, id) => interrupted.missionRuns.cancel(c, id));
    const first = (
      await admin.query('SELECT state,generation,version FROM cos.missions WHERE scope_id=$1 AND id=$2', [
        scope,
        mission,
      ])
    ).rows[0];
    assert.equal(first.state, 'cancelled');
    await controls.reconcile(binding, (c, id) => interrupted.missionRuns.cancel(c, id));
    assert.deepEqual(
      (
        await admin.query('SELECT state,generation,version FROM cos.missions WHERE scope_id=$1 AND id=$2', [
          scope,
          mission,
        ])
      ).rows[0],
      first,
    );
    assert.deepEqual(db.prepare('SELECT state FROM cos_operator_denials').get(), { state: 'reconciled' });
    assert.deepEqual(db.prepare('SELECT paused FROM cos_identity_boundaries').get(), { paused: 0 });
  } finally {
    db.close();
    await pool.end();
    await relay.close();
  }
});
test('S11-T05 trusted owner revocation works while paused, preserves the tombstone and cannot cross scope or grant access', async () => {
  const source = 'source-' + scope;
  assert.deepEqual(await knowledge.revokeOwned({ ...context, ownerId: 'foreign' }, source), { status: 'denied' });
  assert.deepEqual(await knowledge.revokeOwned(context, 'source-' + foreign), { status: 'denied' });
  assert.deepEqual(
    await knowledge.revokeOwned(
      { ...context, origin: { kind: 'schedule', runId: randomUUID(), generation: 1 } },
      source,
    ),
    { status: 'denied' },
  );
  await admin.query("UPDATE cos.scopes SET status='paused' WHERE id=$1", [scope]);
  try {
    assert.equal((await knowledge.revokeOwned(context, source)).status, 'ok');
    const first = (
      await admin.query('SELECT status,version,processing_providers FROM cos.sources WHERE scope_id=$1 AND id=$2', [
        scope,
        source,
      ])
    ).rows[0];
    assert.equal(first.status, 'revoked');
    assert.deepEqual(first.processing_providers, []);
    const marker = (
      await admin.query(
        'SELECT kind,version,provenance FROM cos.revocation_tombstones WHERE scope_id=$1 AND source_id=$2',
        [scope, source],
      )
    ).rows[0];
    assert.equal(marker.kind, 'revoke');
    assert.equal(marker.version, first.version);
    assert.equal(marker.provenance.owner_id, context.ownerId);
    assert.equal((await knowledge.revokeOwned(context, source)).status, 'ok');
    assert.deepEqual(
      (
        await admin.query('SELECT status,version,processing_providers FROM cos.sources WHERE scope_id=$1 AND id=$2', [
          scope,
          source,
        ])
      ).rows[0],
      first,
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM cos.outbox WHERE scope_id=$1 AND kind='knowledge_invalidate'",
          [scope],
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await admin.query("UPDATE cos.scopes SET status='active' WHERE id=$1", [scope]);
  }
});
test('S11-T05 an independently retained native denial prevents resume when an older remote checkpoint lacks its tombstone', async () => {
  const db = new Database(':memory:'),
    binding: CosBinding = {
      scopeId: scope,
      ownerId: context.ownerId,
      botId: 'fixture-bot',
      instanceId: 'fixture',
      channelId: scope,
      agentGroupId: scope,
      messagingGroupId: 'messages-' + scope,
      sessionId: scope,
      provider: 'codex',
    };
  const session = {
    id: scope,
    agent_group_id: scope,
    messaging_group_id: binding.messagingGroupId,
    thread_id: null,
    status: 'active',
    agent_provider: 'codex',
  } as Session;
  installCosBoundary(binding, db);
  const controls = new HostOwnerControls({ db, session: () => session, stop: () => {} }),
    source = 'source-' + scope,
    ingress = {
      id: 'retained-source-denial',
      ownerId: context.ownerId,
      text: 'cos revoke source ' + source,
      timestamp: new Date().toISOString(),
    };
  const marker = (
    await admin.query('SELECT * FROM cos.revocation_tombstones WHERE scope_id=$1 AND source_id=$2', [scope, source])
  ).rows[0];
  try {
    assert.equal(controls.record(binding, ingress, parseOwnerControl(ingress.text)!).status, 'ok');
    await controls.reconcile(binding, async () => ({ status: 'denied' }), {
      revokeSource: (c, id) => knowledge.revokeOwned(c, id),
    });
    assert.equal(await ownerDenialsPermitResume(db, binding, admin), true);
    // Controlled synthetic-row loss models the older checkpoint; this is not a full restore/PITR claim.
    await admin.query('DELETE FROM cos.revocation_tombstones WHERE scope_id=$1 AND source_id=$2', [scope, source]);
    assert.equal(await ownerDenialsPermitResume(db, binding, admin), false);
    assert.deepEqual(db.prepare('SELECT paused FROM cos_identity_boundaries').get(), { paused: 1 });
  } finally {
    await admin.query(
      'INSERT INTO cos.revocation_tombstones(scope_id,source_id,kind,version,provenance) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [scope, source, marker.kind, marker.version, marker.provenance],
    );
    db.close();
  }
});
test('S11-UI01 connector disable preserves scope, uses its durable account fence and never reads tokens or contacts a provider', async () => {
  const calendars = new CalendarStore(store.database),
    bindingId = randomUUID(),
    foreignId = randomUUID();
  for (const [id, ctx] of [
    [bindingId, context],
    [foreignId, { ...context, scopeId: foreign, agentGroupId: foreign, sessionId: foreign }],
  ] as const)
    assert.equal(
      (
        await calendars.bind(ctx, {
          id,
          provider: 'fixture',
          calendarIds: ['synthetic'],
          scopes: [GOOGLE_EVENT_READ_SCOPE],
          timeZone: 'UTC',
          processingProviders: ['codex'],
        })
      ).status,
      'ok',
    );
  const denied = new Set<string>();
  let credentialReads = 0,
    providerCalls = 0;
  const connector = new CalendarConnector({
    store: calendars,
    admitted: () => false,
    fences: {
      deny: (s, id) => {
        denied.add(s + ':' + id);
      },
      assertOpen: (s, id) => {
        if (denied.has(s + ':' + id)) throw new CalendarReadError('calendar_auth_disconnected');
      },
      runCheck: async (_s, _id, operation) => operation(),
    },
    credentials: {
      inspect: async () => {
        credentialReads++;
        throw Error('no-credentials');
      },
      token: async () => {
        credentialReads++;
        throw Error('no-credentials');
      },
    },
    fetch: async () => {
      providerCalls++;
      throw Error('no-provider');
    },
  });
  assert.equal((await connector.disconnect(context, foreignId)).status, 'denied');
  assert.equal((await connector.disconnect(context, bindingId)).status, 'ok');
  assert.throws(() => connector.assertOpen(scope, bindingId), /calendar_auth_disconnected/);
  assert.equal(
    (await admin.query('SELECT auth FROM cos.calendar_bindings WHERE scope_id=$1 AND id=$2', [scope, bindingId]))
      .rows[0].auth,
    'disconnected',
  );
  assert.equal(
    (await admin.query('SELECT auth FROM cos.calendar_bindings WHERE scope_id=$1 AND id=$2', [foreign, foreignId]))
      .rows[0].auth,
    'ready',
  );
  assert.equal(credentialReads, 0);
  assert.equal(providerCalls, 0);
});
test('S11-T01/UI01 exact uncertain-action inspection is read-only, scope-bound and cannot infer that an absent effect did not happen', async () => {
  const ownAction = 'action-' + '1'.repeat(64),
    foreignAction = 'action-' + '2'.repeat(64);
  for (const [id, action] of [
    [scope, ownAction],
    [foreign, foreignAction],
  ]) {
    const proposal = randomUUID(),
      bindingId = randomUUID();
    await admin.query(
      "INSERT INTO cos.action_writer_bindings(scope_id,id,owner_id,session_id,version,state) VALUES($1,$2,$3,$1,1,'disabled')",
      [id, bindingId, context.ownerId],
    );
    await admin.query(
      "INSERT INTO cos.proposals(id,scope_id,session_id,ingress_id,owner_id,change,payload_hash,challenge_hash,state,expires_at,applied_record_id) VALUES($1,$2,$2,$1,$3,'{}',$4,$4,'applied',clock_timestamp()+interval '1 hour',$5)",
      [proposal, id, context.ownerId, 'a'.repeat(64), action],
    );
    await admin.query(
      "INSERT INTO cos.action_intents(scope_id,id,body,digest,authority,proposal_id,binding_id,calendar_id,event_id,expires_at) VALUES($1,$2,$3,$4,'{}',$5,$6,'synthetic',$7,clock_timestamp()+interval '1 hour')",
      [
        id,
        action,
        JSON.stringify({
          project_id: id === scope ? 'goal-00-' + scope : 'foreign-goal-' + foreign,
          private: sentinel,
        }),
        'a'.repeat(64),
        proposal,
        bindingId,
        'b'.repeat(64),
      ],
    );
    await admin.query("INSERT INTO cos.actions(scope_id,id,state,result) VALUES($1,$2,'outcome_uncertain',$3)", [
      id,
      action,
      JSON.stringify({ private: sentinel }),
    ]);
    await admin.query(
      "INSERT INTO cos.action_receipts(scope_id,id,action_id,kind,body) VALUES($1,$2,$3,'uncertain',$4)",
      [id, randomUUID(), action, JSON.stringify({ private: sentinel })],
    );
  }
  const before = (
    await admin.query('SELECT * FROM cos.actions WHERE scope_id=ANY($1::text[]) ORDER BY scope_id,id', [
      [scope, foreign],
    ])
  ).rows;
  const result = await store.operatorStatus(context, { category: 'actions', id: ownAction });
  assert.equal(result.status, 'ok');
  assert.equal(result.execution_authority, 'inspection_only');
  const items = result.items as Array<{ id: string; state: string; evidence_ref: unknown }>;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, ownAction);
  assert.equal(items[0].state, 'outcome_uncertain');
  assert.deepEqual(items[0].evidence_ref, { kind: 'action', id: ownAction });
  assert.ok(!JSON.stringify(result).includes(sentinel));
  assert.ok(!JSON.stringify(result).includes(foreignAction));
  const absent = await store.operatorStatus(context, { category: 'actions', id: foreignAction });
  assert.equal(absent.status, 'ok');
  assert.deepEqual(absent.items, []);
  assert.equal(absent.provider_effects, 'use_current_action_reconciliation');
  assert.deepEqual(
    (
      await admin.query('SELECT * FROM cos.actions WHERE scope_id=ANY($1::text[]) ORDER BY scope_id,id', [
        [scope, foreign],
      ])
    ).rows,
    before,
  );
});

test('S11-T06 owner-local export excludes revoked/foreign sources and credentials, audits once, and retires its own revoked copy', async () => {
  const root = path.join(artifactRoot, 'exports');
  fs.mkdirSync(root, { mode: 0o700 });
  const texts = ['PRIVATE_ALLOWED_EXPORT', 'PRIVATE_REVOKED_EXPORT'];
  const ids: string[] = [];
  for (const [index, text] of texts.entries()) {
    const filename = 'export-' + index + '.md';
    fs.writeFileSync(path.join(artifactRoot, 'staging', filename), text, { mode: 0o600 });
    const imported = await knowledge.importSource(context, randomUUID(), {
      sourceKey: 'export-' + index,
      filename,
      title: filename,
      processingProviders: ['codex'],
      expectedVersion: 0,
    });
    assert.equal(imported.status, 'ok');
    ids.push(imported.source_id as string);
  }
  assert.equal((await knowledge.revokeOwned(context, ids[1])).status, 'ok');
  const requestId = randomUUID(),
    options = {
      database: store.database,
      context,
      provider: 'codex',
      artifacts: knowledge.artifacts,
      root,
      requestId,
      check: async () => {},
    };
  const exported = await exportOwnerRecords(options);
  assert.equal(exported.status, 'ok');
  assert.equal(exported.delivery, 'owner_local_only');
  const file = exported.file as string,
    bytes = fs.readFileSync(file, 'utf8'),
    value = JSON.parse(bytes);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(bytes.includes(texts[0]));
  assert.ok(!bytes.includes(texts[1]));
  assert.ok(!bytes.includes('foreign-goal-'));
  assert.ok(!bytes.includes('challenge_hash'));
  assert.ok(!bytes.includes('calendar_bindings'));
  assert.equal(value.records.length, 25);
  assert.equal(value.sources.length, 1);
  assert.equal(exported.sha256, digest(value));
  assert.equal((await exportOwnerRecords(options)).status, 'ok');
  fs.chmodSync(file, 0o644);
  assert.notEqual(
    (await exportOwnerRecords({ ...options, database: new BoundedDatabase(store.database.pool) })).status,
    'ok',
  );
  fs.chmodSync(file, 0o600);
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM cos.events WHERE scope_id=$1 AND kind='owner_export' AND resource_id=$2",
        [scope, requestId],
      )
    ).rows[0].n,
    1,
  );
  const unrelated = path.join(root, 'ordinary-owner-file.txt');
  fs.writeFileSync(unrelated, 'preserve', { mode: 0o600 });
  assert.equal((await knowledge.revokeOwned(context, ids[0])).status, 'ok');
  assert.notEqual((await exportOwnerRecords(options)).status, 'ok');
  const purged = await purgeOwnerExports({ ...options, retentionMs: 7 * 24 * 60 * 60 * 1000 });
  assert.equal(purged.status, 'ok');
  assert.equal(purged.removed, 1);
  assert.ok(!fs.existsSync(file));
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'preserve');
});
test('S11-T06 export fails closed on lost native/current database authority without publishing an unaudited file', async () => {
  const root = path.join(artifactRoot, 'withheld-exports');
  fs.mkdirSync(root, { mode: 0o700 });
  let checks = 0;
  const options = {
    database: new BoundedDatabase(store.database.pool),
    context,
    provider: 'codex',
    artifacts: knowledge.artifacts,
    root,
    requestId: randomUUID(),
    check: async () => {
      if (++checks >= 3) throw Error('PRIVATE_OWNER_LOST');
    },
  };
  const foreignResult = await exportOwnerRecords({
    ...options,
    check: async () => {},
    requestId: randomUUID(),
    context: { ...context, ownerId: 'foreign-owner' },
  });
  assert.equal(foreignResult.status, 'denied');
  assert.equal(fs.readdirSync(root).filter((n) => n.endsWith('.export.json')).length, 0);
  const result = await exportOwnerRecords(options);
  assert.notEqual(result.status, 'ok');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_OWNER_LOST'));
  assert.equal(fs.readdirSync(root).filter((n) => n.endsWith('.export.json')).length, 0);
});

test('S11-T06 revocation during the export audit commit prevents subsequent local disclosure', async () => {
  const filename = 'export-race.md';
  fs.writeFileSync(path.join(artifactRoot, 'staging', filename), 'PRIVATE_RACE_EXPORT', { mode: 0o600 });
  const imported = await knowledge.importSource(context, randomUUID(), {
    sourceKey: 'export-race',
    filename,
    title: filename,
    processingProviders: ['codex'],
    expectedVersion: 0,
  });
  assert.equal(imported.status, 'ok');
  const root = path.join(artifactRoot, 'race-exports');
  fs.mkdirSync(root, { mode: 0o700 });
  const requestId = randomUUID();
  let revoked = false;
  const result = await exportOwnerRecords({
    database: store.database,
    context,
    provider: 'codex',
    artifacts: knowledge.artifacts,
    root,
    requestId,
    check: async () => {
      if (
        !revoked &&
        (
          await admin.query("SELECT 1 FROM cos.events WHERE scope_id=$1 AND kind='owner_export' AND resource_id=$2", [
            scope,
            requestId,
          ])
        ).rowCount === 1
      ) {
        revoked = true;
        assert.equal((await knowledge.revokeOwned(context, imported.source_id as string)).status, 'ok');
      }
    },
  });
  assert.equal(revoked, true);
  assert.notEqual(result.status, 'ok');
  assert.equal(fs.readdirSync(root).filter((n) => n.endsWith('.export.json')).length, 0);
});
test('S11-T06 a late authority callback cannot publish after the bounded database operation has expired', async () => {
  const root = path.join(artifactRoot, 'expired-exports');
  fs.mkdirSync(root, { mode: 0o700 });
  let release!: () => void,
    reached = false,
    checks = 0;
  const database = new BoundedDatabase(store.database.pool, 50);
  const operation = exportOwnerRecords({
    database,
    context,
    provider: 'codex',
    artifacts: knowledge.artifacts,
    root,
    requestId: randomUUID(),
    check: async () => {
      if (++checks === 2) {
        reached = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    },
  });
  const result = await operation;
  assert.equal(reached, true);
  assert.notEqual(result.status, 'ok');
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fs.readdirSync(root).filter((n) => n.endsWith('.export.json')).length, 0);
});

test('S11-T06 denied retention releases its transaction and leaves the bounded pool reusable', async () => {
  const root = path.join(artifactRoot, 'denied-retention');
  fs.mkdirSync(root, { mode: 0o700 });
  const pool = new pg.Pool({ ...(await fixtureDatabaseConfig(process.env)), max: 1 }),
    database = new BoundedDatabase(pool);
  try {
    const result = await purgeOwnerExports({
      database,
      context: { ...context, ownerId: 'foreign' },
      provider: 'codex',
      artifacts: knowledge.artifacts,
      root,
      requestId: randomUUID(),
      retentionMs: 0,
      check: async () => {},
    });
    assert.equal(result.status, 'denied');
    const state = await database.run(
      async (client) => (await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation,
    );
    assert.equal(state, 'read committed');
  } finally {
    await pool.end();
  }
});
