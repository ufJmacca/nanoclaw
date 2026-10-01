import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { fixtureDatabaseConfig, connectFixtureDatabase, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import type { ScheduleChange } from '../../modules/chief-of-staff/contracts/schedule-protocol.js';
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
