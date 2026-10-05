import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { migrate, MIGRATIONS } from '../../modules/chief-of-staff/store/migrations.js';

let admin: pg.Client, runtime: pg.Client;
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  assert.equal(await migrate(admin, fixtureRuntimeUser()), 16);
  runtime = new pg.Client(await fixtureDatabaseConfig());
  await runtime.connect();
});
after(async () => {
  await runtime?.end();
  await admin?.end();
});

test('S09 durable effect schema preserves checksums, enables no writer and restricts immutable receipts', async () => {
  const history = (await admin.query('SELECT version,checksum FROM cos.schema_migrations ORDER BY version')).rows;
  assert.deepEqual(
    history,
    MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })),
  );
  for (const table of ['action_writer_bindings', 'action_writer_revisions']) {
    assert.equal((await runtime.query('SELECT count(*)::int AS n FROM cos.' + table)).rows[0].n, 0);
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
      assert.equal(
        (await runtime.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', ['cos.' + table, privilege]))
          .rows[0].allowed,
        false,
      );
  }
  for (const table of ['action_intents', 'action_request_starts', 'action_receipts']) {
    for (const privilege of ['SELECT', 'INSERT'])
      assert.equal(
        (await runtime.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', ['cos.' + table, privilege]))
          .rows[0].allowed,
        true,
      );
    for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE'])
      assert.equal(
        (await runtime.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', ['cos.' + table, privilege]))
          .rows[0].allowed,
        false,
      );
  }
});

test('S09 writer consent cannot be manufactured with the runtime database login', async () => {
  await assert.rejects(
    runtime.query(
      "INSERT INTO cos.action_writer_bindings(scope_id,id,owner_id,session_id,version,state) VALUES('foreign',$1,'owner','session',1,'enabled')",
      [randomUUID()],
    ),
    (error: unknown) => (error as { code?: string }).code === '42501',
  );
});
