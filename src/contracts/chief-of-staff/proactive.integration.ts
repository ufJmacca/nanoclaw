import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { migrate, SCHEMA_VERSION } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import type { Context } from '../../modules/chief-of-staff/domain/contracts.js';
const scope = 'proactive-fixture-' + randomUUID();
const context: Context = {
  scopeId: scope,
  ownerId: 'fixture-owner',
  sessionId: scope,
  agentGroupId: scope,
  ingressId: randomUUID(),
};
let admin: pg.Client, pool: pg.Pool, store: PriorityStore;
const policy = {
  due_horizon_hours: 48,
  no_update_days: null,
  max_candidates: 3,
  max_proposals: 2,
  notifications_per_day: 1,
  time_zone: 'Australia/Sydney',
  quiet_hours: null,
  urgent_rule: null,
};
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  assert.equal(await migrate(admin, fixtureRuntimeUser()), SCHEMA_VERSION);
  pool = new pg.Pool(await fixtureDatabaseConfig());
  store = new PriorityStore(new BoundedDatabase(pool));
  await admin.query(
    "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,$2,'fixture',$1,$1,'active')",
    [scope, context.ownerId],
  );
});
after(async () => {
  if (admin) {
    for (const table of [
      'proactive_notifications',
      'proactive_feedback',
      'proactive_revisions',
      'proactive_suggestions',
      'proactive_batches',
      'proactive_observations',
      'proactive_policy_revisions',
      'proactive_policies',
      'outbox',
      'events',
      'operations',
      'proposals',
      'records',
    ])
      if ((await admin.query('SELECT to_regclass($1) AS present', ['cos.' + table])).rows[0].present)
        await admin.query(`DELETE FROM cos.${table} WHERE scope_id=$1`, [scope]);
    await admin.query('DELETE FROM cos.scopes WHERE id=$1', [scope]);
  }
  await pool?.end();
  await admin?.end();
});
test('S07-T07/T09 proactive configuration requires exact owner approval and cannot rewrite goals', async () => {
  const change = {
    kind: 'proactive_policy' as const,
    state: 'active' as const,
    policy,
    expected_version: 0,
    reason: 'Fixture owner limits',
  };
  const proposed = await store.propose(context, randomUUID(), change);
  assert.equal(proposed.status, 'ok');
  assert.equal((await pool.query('SELECT * FROM cos.proactive_policies WHERE scope_id=$1', [scope])).rowCount, 0);
  assert.equal(
    (
      await store.decide(
        { ...context, ownerId: 'foreign' },
        String(proposed.proposal_id),
        String(proposed.confirmation_token),
        'approve',
      )
    ).status,
    'denied',
  );
  assert.equal(
    (
      await store.decide(
        { ...context, ingressId: randomUUID() },
        String(proposed.proposal_id),
        String(proposed.confirmation_token),
        'approve',
      )
    ).status,
    'ok',
  );
  assert.equal((await store.apply(scope, String(proposed.proposal_id))).status, 'ok');
  assert.equal((await store.apply(scope, String(proposed.proposal_id))).status, 'ok');
  const row = (await pool.query('SELECT * FROM cos.proactive_policies WHERE scope_id=$1', [scope])).rows[0];
  assert.equal(row.version, 1);
  assert.deepEqual(row.policy, policy);
  assert.equal((await pool.query('SELECT * FROM cos.records WHERE scope_id=$1', [scope])).rowCount, 0);
  const stale = await store.propose(context, randomUUID(), { ...change, reason: 'Stale competing policy' });
  assert.equal(stale.status, 'denied');
});
test('S07-T01/T07 runtime cannot rewrite host observations, proposal revisions, owner feedback or budget receipts', async () => {
  for (const table of [
    'proactive_observations',
    'proactive_revisions',
    'proactive_feedback',
    'proactive_notifications',
    'proactive_policy_revisions',
  ]) {
    const p = (
      await pool.query(
        "SELECT has_table_privilege(current_user,$1,'SELECT') AS read,has_table_privilege(current_user,$1,'INSERT') AS insert,has_table_privilege(current_user,$1,'UPDATE') AS update,has_table_privilege(current_user,$1,'DELETE') AS delete,has_table_privilege(current_user,$1,'TRUNCATE') AS truncate",
        ['cos.' + table],
      )
    ).rows[0];
    assert.deepEqual(p, { read: true, insert: true, update: false, delete: false, truncate: false });
  }
});
