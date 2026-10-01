import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { fixtureDatabaseConfig, connectFixtureDatabase, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import type { ScheduleChange } from '../../modules/chief-of-staff/contracts/schedule-protocol.js';
import { BriefRunStore } from '../../modules/chief-of-staff/automation/brief-store.js';
import { connectionFault } from './connection-fault.js';
import { setTimeout as delay } from 'node:timers/promises';
const scope = 'brief-schedule-' + randomUUID(),
  context = {
    scopeId: scope,
    ownerId: 'fixture-owner',
    agentGroupId: scope,
    sessionId: scope,
    ingressId: randomUUID(),
  };
const change: ScheduleChange = {
  kind: 'brief_schedule',
  title: 'Morning brief',
  reason: 'Owner approved weekdays',
  expected_version: 0,
  policy: {
    state: 'active',
    time_zone: 'Australia/Sydney',
    local_time: '09:00',
    weekdays: [1, 2, 3, 4, 5],
    quiet_hours: { start: '22:00', end: '08:00' },
    snooze_until: null,
  },
  limits: { max_turns: 2, max_tool_calls: 12, deadline_seconds: 120, refresh_seconds: 20 },
};
let admin: pg.Client, pool: pg.Pool, store: PriorityStore;
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  await migrate(admin, fixtureRuntimeUser());
  pool = new pg.Pool(await fixtureDatabaseConfig());
  store = new PriorityStore(BoundedDatabase.fromConfig(await fixtureDatabaseConfig()));
  await pool.query(
    "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,$2,'fixture-instance',$1,$1,'active')",
    [scope, context.ownerId],
  );
});
after(async () => {
  if (admin) {
    for (const table of [
      'brief_call_reservations',
      'brief_notifications',
      'brief_runs',
      'brief_schedule_revisions',
      'brief_schedules',
      'outbox',
      'events',
      'operations',
      'proposals',
      'records',
    ])
      if ((await admin.query('SELECT to_regclass($1) AS t', ['cos.' + table])).rows[0].t)
        await admin.query(`DELETE FROM cos.${table} WHERE scope_id=$1`, [scope]);
    await admin.query('DELETE FROM cos.scopes WHERE id=$1', [scope]);
  }
  await store?.database.pool.end();
  await pool?.end();
  await admin?.end();
});
async function approve(c: ScheduleChange) {
  const p = await store.propose(context, randomUUID(), c);
  assert.equal(p.status, 'ok');
  assert.equal(
    (
      await store.decide(
        { ...context, ingressId: randomUUID() },
        String(p.proposal_id),
        String(p.confirmation_token),
        'approve',
      )
    ).status,
    'ok',
  );
  return store.apply(scope, String(p.proposal_id));
}
test('S04-T10 a schedule proposal creates no authority until the exact owner approves; replay and revisions remain exact', async () => {
  const requestId = randomUUID(),
    p = await store.propose(context, requestId, change);
  assert.equal(p.status, 'ok');
  assert.equal(
    (await pool.query('SELECT method FROM cos.operations WHERE session_id=$1 AND request_id=$2', [scope, requestId]))
      .rows[0].method,
    'cos_brief_schedule_propose',
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM cos.brief_schedules WHERE scope_id=$1', [scope])).rows[0].n,
    0,
  );
  assert.equal((await store.apply(scope, String(p.proposal_id))).status, 'denied');
  assert.equal(
    (
      await store.decide(
        { ...context, ownerId: 'intruder', ingressId: randomUUID() },
        String(p.proposal_id),
        String(p.confirmation_token),
        'approve',
      )
    ).status,
    'denied',
  );
  assert.equal(
    (
      await store.decide(
        { ...context, ingressId: randomUUID() },
        String(p.proposal_id),
        String(p.confirmation_token),
        'approve',
      )
    ).status,
    'ok',
  );
  const a = await store.apply(scope, String(p.proposal_id));
  assert.equal(a.status, 'ok');
  assert.deepEqual(await store.apply(scope, String(p.proposal_id)), a);
  const row = (await pool.query('SELECT * FROM cos.brief_schedules WHERE scope_id=$1', [scope])).rows[0];
  assert.equal(row.owner_id, context.ownerId);
  assert.equal(row.session_id, context.sessionId);
  assert.deepEqual(row.policy, change.policy);
  assert.deepEqual(row.limits, change.limits);
  assert.equal((await store.context({ ...context, ownerId: 'intruder' })).status, 'denied');
  assert.deepEqual((await store.context({ ...context, sessionId: 'foreign-session' })).brief_schedules, []);
  assert.equal(((await store.context(context)).brief_schedules as any[])[0].id, a.record_id);
  const paused = {
    ...change,
    record_id: String(a.record_id),
    expected_version: 1,
    policy: { ...change.policy, state: 'paused' as const },
  };
  assert.equal((await approve(paused)).status, 'ok');
  assert.equal((await approve(paused)).status, 'conflict');
  assert.equal((await approve({ ...change, record_id: String(a.record_id), expected_version: 2 })).status, 'ok');
  const revisions = (
    await pool.query('SELECT version,body FROM cos.brief_schedule_revisions WHERE scope_id=$1 ORDER BY version', [
      scope,
    ])
  ).rows;
  assert.deepEqual(
    revisions.map((r) => r.version),
    [1, 2, 3],
  );
  assert.deepEqual(
    revisions.map((r) => r.body.policy.state),
    ['active', 'paused', 'active'],
  );
  await assert.rejects(
    pool.query("UPDATE cos.brief_schedule_revisions SET body='{}' WHERE scope_id=$1", [scope]),
    (e: any) => e.code === '42501',
  );
  assert.equal((await approve(change)).status, 'conflict'); // This slice permits one approved brief schedule per scope.
  assert.equal(
    (
      await approve({
        ...change,
        record_id: String(a.record_id),
        expected_version: 3,
        policy: { ...change.policy, snooze_until: '2000-01-01T00:00:00Z' },
      })
    ).status,
    'conflict',
  );
});

test('S04-T01/T02/T08 repeated wakes and restarted hosts reconcile one run and notification without resetting budgets', async () => {
  const existing = (await pool.query('SELECT id,version FROM cos.brief_schedules WHERE scope_id=$1', [scope])).rows[0];
  assert.equal(
    (
      await approve({
        ...change,
        record_id: existing.id,
        expected_version: existing.version,
        policy: { ...change.policy, time_zone: 'UTC', quiet_hours: null, weekdays: [1, 2, 3, 4, 5, 6, 7] },
      })
    ).status,
    'ok',
  );
  const now = new Date(Date.now() + 86400000);
  now.setUTCHours(9, 0, 0, 0);
  const briefs = new BriefRunStore(store.database, { clock: () => now });
  const attempts = await Promise.all(Array.from({ length: 4 }, () => briefs.reserveDue(context)));
  assert.ok(attempts.every((result) => result.status === 'ok'));
  const run = attempts[0].run as any;
  assert.ok(run.id);
  assert.ok(attempts.every((result) => (result.run as any).id === run.id));
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM cos.brief_runs WHERE scope_id=$1', [scope])).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM cos.brief_notifications WHERE scope_id=$1', [scope])).rows[0].n,
    1,
  );
  const claim = await briefs.claim(context, run.id, 'host-a');
  assert.equal(claim.status, 'ok');
  assert.equal((await briefs.claim(context, run.id, 'host-b')).status, 'denied');
  const generation = Number(claim.generation),
    call = randomUUID();
  assert.equal((await briefs.reserveCall(context, run.id, generation, 'model', call)).status, 'ok');
  assert.equal((await briefs.reserveCall(context, run.id, generation, 'model', call)).status, 'denied');
  const restarted = new BriefRunStore(store.database, { clock: () => now });
  const recovered = await restarted.reserveDue(context);
  assert.equal(recovered.status, 'ok');
  assert.equal((recovered.run as any).id, run.id);
  assert.equal((recovered.run as any).deadline_at, run.deadline_at);
  assert.equal((await restarted.reserveCall(context, run.id, generation, 'model', randomUUID())).status, 'ok');
  assert.equal((await restarted.reserveCall(context, run.id, generation, 'model', randomUUID())).status, 'denied');
  for (let i = 0; i < change.limits.max_tool_calls; i++)
    assert.equal((await briefs.reserveCall(context, run.id, generation, 'tool', randomUUID())).status, 'ok');
  assert.equal((await briefs.reserveCall(context, run.id, generation, 'tool', randomUUID())).status, 'denied');
  assert.equal(
    (await briefs.reserveCall({ ...context, ownerId: 'intruder' }, run.id, generation, 'tool', randomUUID())).status,
    'denied',
  );
  assert.equal((await briefs.reserveCall(context, run.id, generation + 1, 'tool', randomUUID())).status, 'denied');
  await pool.query(
    "UPDATE cos.brief_notifications SET state='delivering',attempt_id=$2,started_at=clock_timestamp() WHERE scope_id=$1 AND run_id=$3",
    [scope, randomUUID(), run.id],
  );
  const current = (await pool.query('SELECT id,version FROM cos.brief_schedules WHERE scope_id=$1', [scope])).rows[0];
  assert.equal(
    (
      await approve({
        ...change,
        record_id: current.id,
        expected_version: current.version,
        policy: { ...change.policy, state: 'paused' },
      })
    ).status,
    'ok',
  );
  assert.equal((await briefs.claim(context, run.id, 'host-a')).status, 'denied');
  assert.equal((await briefs.reserveDue(context)).run, null);
  assert.equal(
    (await pool.query('SELECT state FROM cos.brief_notifications WHERE scope_id=$1 AND run_id=$2', [scope, run.id]))
      .rows[0].state,
    'uncertain',
  );
  assert.equal(
    (await pool.query('SELECT state FROM cos.brief_runs WHERE scope_id=$1 AND id=$2', [scope, run.id])).rows[0].state,
    'uncertain',
  );
});
test('S04 run-store outage, lost reservation acknowledgement and expiry never reset the occurrence budget', async () => {
  const current = (await pool.query('SELECT id,version FROM cos.brief_schedules WHERE scope_id=$1', [scope])).rows[0];
  assert.equal(
    (
      await approve({
        ...change,
        record_id: current.id,
        expected_version: current.version,
        policy: { ...change.policy, time_zone: 'UTC', quiet_hours: null, weekdays: [1, 2, 3, 4, 5, 6, 7] },
      })
    ).status,
    'ok',
  );
  const now = new Date(Date.now() + 2 * 86400000);
  now.setUTCHours(9, 0, 0, 0);
  const before = (await pool.query('SELECT count(*)::int AS n FROM cos.brief_runs WHERE scope_id=$1', [scope])).rows[0]
    .n;
  const relay = await connectionFault(await fixtureDatabaseConfig()),
    database = new BoundedDatabase(new pg.Pool(relay.config), 350);
  try {
    await database.run((client) => client.query('SELECT 1'));
    relay.partition();
    const fault = new BriefRunStore(database, { clock: () => now });
    assert.ok(['pending', 'unavailable'].includes((await fault.reserveDue(context)).status));
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM cos.brief_runs WHERE scope_id=$1', [scope])).rows[0].n,
      before,
    );
    relay.restore();
    await delay(1100);
    assert.equal((await fault.reserveDue(context)).status, 'ok');
  } finally {
    await database.pool.end();
    await relay.close();
  }
  const briefs = new BriefRunStore(store.database, { clock: () => now }),
    run = (await briefs.reserveDue(context)).run as any;
  const claimed = await briefs.claim(context, run.id, 'host-recovered');
  assert.equal(claimed.status, 'ok');
  const faultyPool = new pg.Pool(await fixtureDatabaseConfig()),
    client = await faultyPool.connect(),
    original = client.query.bind(client);
  let dropped = false;
  client.query = (async (...args: unknown[]) => {
    const result = await (original as (...a: unknown[]) => Promise<unknown>)(...args);
    if (args[0] === 'COMMIT' && !dropped) {
      dropped = true;
      throw new Error('fixture_lost_brief_call_ack');
    }
    return result;
  }) as typeof client.query;
  client.release();
  const callId = randomUUID(),
    generation = Number(claimed.generation);
  try {
    const lost = new BriefRunStore(new BoundedDatabase(faultyPool));
    assert.equal((await lost.reserveCall(context, run.id, generation, 'model', callId)).status, 'pending');
    assert.equal((await briefs.reserveCall(context, run.id, generation, 'model', callId)).status, 'denied');
    assert.equal((await briefs.reserveCall(context, run.id, generation, 'model', randomUUID())).status, 'ok');
    assert.equal((await briefs.reserveCall(context, run.id, generation, 'model', randomUUID())).status, 'denied');
  } finally {
    await faultyPool.end();
  }
  await pool.query(
    "UPDATE cos.brief_runs SET deadline_at=clock_timestamp()-interval '1 second' WHERE scope_id=$1 AND id=$2",
    [scope, run.id],
  );
  assert.equal((await briefs.claim(context, run.id, 'host-recovered')).status, 'denied');
  assert.equal((await briefs.reserveCall(context, run.id, generation, 'tool', randomUUID())).status, 'denied');
  assert.equal((await briefs.reserveDue(context)).run, null);
  assert.equal(
    (await pool.query('SELECT state FROM cos.brief_notifications WHERE scope_id=$1 AND run_id=$2', [scope, run.id]))
      .rows[0].state,
    'failed',
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM cos.brief_runs WHERE scope_id=$1', [scope])).rows[0].n,
    before + 1,
  );
});
