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
let admin: pg.Client, store: PriorityStore;
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
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  await migrate(admin, fixtureRuntimeUser());
  store = new PriorityStore(BoundedDatabase.fromConfig(await fixtureDatabaseConfig(process.env)));
  for (const id of [scope, foreign])
    await admin.query(
      "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,$2,'fixture',$1,$1,'active')",
      [id, context.ownerId],
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
  if (admin)
    for (const id of [scope, foreign]) {
      for (const table of [
        'missions',
        'mission_work_orders',
        'mission_context_manifests',
        'mission_template_versions',
        'proposals',
        'records',
      ])
        await admin.query('DELETE FROM cos.' + table + ' WHERE scope_id=$1', [id]);
      await admin.query('DELETE FROM cos.scopes WHERE id=$1', [id]);
    }
  await admin?.end();
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
