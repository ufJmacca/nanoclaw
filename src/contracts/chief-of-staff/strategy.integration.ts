/** Remote PostgreSQL contracts; fixture scopes and the explicitly selected protected test target only. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type pg from 'pg';
import { migrate, MIGRATIONS } from '../../modules/chief-of-staff/store/migrations.js';
import { connectFixtureDatabase, fixtureRuntimeUser } from './fixture-database.js';

const immutable = [
  'review_charter_revisions',
  'strategy_observations',
  'strategy_review_snapshots',
  'strategy_review_results',
  'strategy_decisions',
  'strategy_direction_revisions',
];
const heads = ['review_charters', 'strategy_directions'];
let admin: pg.Client, runtime: pg.Client, version: number;
let protectedBefore: Record<string, number>;
async function protectedCounts() {
  const counts: Record<string, number> = {};
  for (const table of ['records', 'work_items', 'missions', 'actions', 'action_writer_bindings'])
    counts[table] = (await admin.query('SELECT count(*)::int AS n FROM cos.' + table)).rows[0].n;
  return counts;
}
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  protectedBefore = await protectedCounts();
  version = await migrate(admin, fixtureRuntimeUser());
  runtime = await connectFixtureDatabase(process.env, 'runtime');
});
after(async () => {
  await runtime?.end();
  await admin?.end();
});

test('S10 explicit schema17 migration preserves every predecessor checksum and protected row count', async () => {
  assert.equal(version, 17);
  assert.deepEqual(
    (await admin.query('SELECT version,checksum FROM cos.schema_migrations ORDER BY version')).rows,
    MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })),
  );
  assert.deepEqual(await protectedCounts(), protectedBefore);
  for (const table of [...immutable, ...heads])
    assert.equal(
      (await admin.query('SELECT to_regclass($1) IS NOT NULL AS present', ['cos.' + table])).rows[0].present,
      true,
    );
});
test('S10 reviewed charters, observations, snapshots, reviews and decisions have append-only runtime grants', async () => {
  for (const table of immutable) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
      assert.equal(
        (await runtime.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', ['cos.' + table, privilege]))
          .rows[0].allowed,
        ['SELECT', 'INSERT'].includes(privilege),
        `${table} ${privilege}`,
      );
    await assert.rejects(runtime.query(`UPDATE cos.${table} SET scope_id=scope_id WHERE false`), { code: '42501' });
  }
});
test('S10 mutable review/direction heads cannot delete approved history or truncate state', async () => {
  for (const table of heads) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
      assert.equal(
        (await runtime.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', ['cos.' + table, privilege]))
          .rows[0].allowed,
        ['SELECT', 'INSERT', 'UPDATE'].includes(privilege),
        `${table} ${privilege}`,
      );
  }
});
test('S10 schema grants cannot enable a real calendar writer', async () => {
  for (const table of ['action_writer_bindings', 'action_writer_revisions'])
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
      assert.equal(
        (await runtime.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', ['cos.' + table, privilege]))
          .rows[0].allowed,
        false,
      );
});
