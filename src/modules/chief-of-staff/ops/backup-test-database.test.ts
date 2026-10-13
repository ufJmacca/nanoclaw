import type pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { parseDatabaseConfig } from '../store/config.js';
import { databaseFingerprint } from './target-identity.js';
import type { DeploymentSettings } from './deployment-settings.js';
const ports = vi.hoisted(() => ({ runtimeEnv: vi.fn(), testEnv: vi.fn(), runtime: vi.fn(), test: vi.fn() }));
vi.mock('./target-host.js', () => ({
  readTargetDatabaseEnvironment: ports.runtimeEnv,
  readTargetTestEnvironment: ports.testEnv,
  checkedTargetDatabase: ports.runtime,
}));
vi.mock('../store/preflight.js', async (original) => ({
  ...(await original<typeof import('../store/preflight.js')>()),
  connectChecked: ports.test,
}));
import { withSeparateBackupTestDatabase, type BackupTestDatabase } from './backup-test-database.js';
afterEach(() => vi.resetAllMocks());
async function fixture() {
  const runtimeEnv = {
      COS_PGHOST: 'runtime-db.lan',
      COS_PGDATABASE: 'fixture_runtime',
      COS_PGUSER: 'fixture_runtime',
      COS_PGPASSWORD: 'PRIVATE_RUNTIME_CANARY',
    },
    testEnv = {
      COS_TEST_PGHOST: 'test-db.lan',
      COS_TEST_PGDATABASE: 'fixture_test',
      COS_TEST_PG_MIGRATION_USER: 'fixture_test_migration',
      COS_TEST_PG_MIGRATION_PASSWORD: 'PRIVATE_TEST_CANARY',
      COS_TEST_TARGET_ID: 'fixture-test',
    },
    runtimeIdentity = {
      database: 'fixture_runtime',
      database_oid: '12345',
      server_address: '192.168.56.20',
      server_port: 5432,
    },
    testIdentity = { ...runtimeIdentity, database: 'fixture_test', database_oid: '54321' },
    marker = {
      target_id: testEnv.COS_TEST_TARGET_ID,
      purpose: 'test',
      writable: false,
      schema_writable: false,
      owner_member: false,
    };
  let readOnly = true;
  const runtime = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'SET default_transaction_read_only = on') return { rows: [] };
        if (sql.includes("current_setting('default_transaction_read_only')"))
          return { rows: [{ read_only: readOnly ? 'on' : 'off' }] };
        if (sql.includes('current_database()')) return { rows: [runtimeIdentity] };
        throw Error('runtime_query_forbidden');
      }),
      end: vi.fn().mockResolvedValue(undefined),
    },
    test = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('current_database()')) return { rows: [testIdentity] };
        if (sql.includes('cos_admin.target_identity')) return { rows: [marker] };
        throw Error('test_query_unexpected');
      }),
      end: vi.fn().mockResolvedValue(undefined),
    },
    settings = {
      stateRoot: '/fixture/state',
      runtimeEnvironment: '/fixture/runtime.env',
      databaseFingerprint: await databaseFingerprint(
        runtime as unknown as pg.Client,
        parseDatabaseConfig(runtimeEnv, 'runtime'),
      ),
    } as DeploymentSettings,
    owner = vi.fn();
  runtime.query.mockClear();
  ports.runtimeEnv.mockImplementation(() => runtimeEnv);
  ports.testEnv.mockImplementation(() => testEnv);
  ports.runtime.mockResolvedValue(runtime);
  ports.test.mockResolvedValue(test);
  return {
    runtimeEnv,
    testEnv,
    runtimeIdentity,
    testIdentity,
    marker,
    runtime,
    test,
    settings,
    owner,
    readOnly: (value: boolean) => (readOnly = value),
    run: <T>(use: (sandbox: BackupTestDatabase, check: () => Promise<void>) => Promise<T>) =>
      withSeparateBackupTestDatabase(settings, '/fixture/test.env', owner, use),
  };
}
it('admits only the selected test client and keeps runtime access read only', async () => {
  const f = await fixture();
  await expect(
    f.run(async (sandbox, check) => {
      expect(sandbox.client).toBe(f.test);
      expect(sandbox.config).toMatchObject({ database: 'fixture_test', user: 'fixture_test_migration' });
      expect(sandbox.testTargetId).toBe('fixture-test');
      expect(JSON.stringify(sandbox)).not.toContain('PRIVATE_RUNTIME_CANARY');
      await check();
      return 'verified';
    }),
  ).resolves.toBe('verified');
  expect(ports.test).toHaveBeenCalledWith(f.testEnv, 'test', 'migration');
  expect(ports.runtime).toHaveBeenCalledWith(f.settings);
  expect(
    f.runtime.query.mock.calls.every(
      ([sql]) => sql.startsWith('SELECT') || sql === 'SET default_transaction_read_only = on',
    ),
  ).toBe(true);
  expect(f.runtime.end).toHaveBeenCalledOnce();
  expect(f.test.end).toHaveBeenCalledOnce();
});
it('refuses the actual runtime database even when the selected test connection has different labels', async () => {
  const f = await fixture();
  Object.assign(f.testIdentity, f.runtimeIdentity);
  f.testEnv.COS_TEST_PGDATABASE = f.runtimeIdentity.database;
  const use = vi.fn();
  await expect(f.run(use)).rejects.toThrow(/^backup_test_database_separation_unavailable$/);
  expect(use).not.toHaveBeenCalled();
  expect(f.runtime.end).toHaveBeenCalledOnce();
  expect(f.test.end).toHaveBeenCalledOnce();
});
it.each([
  'runtime_environment',
  'test_environment',
  'settings',
  'runtime_server',
  'test_server',
  'marker',
  'read_only',
  'runtime_query',
  'test_query',
  'selected_client',
  'selected_config',
])('refuses %s withdrawal across an awaited operation and closes both clients', async (change) => {
  const f = await fixture();
  await expect(
    f.run(async (sandbox, check) => {
      await Promise.resolve();
      if (change === 'runtime_environment') f.runtimeEnv.COS_PGPASSWORD = 'changed';
      if (change === 'test_environment') f.testEnv.COS_TEST_PG_MIGRATION_PASSWORD = 'changed';
      if (change === 'settings') f.settings.databaseFingerprint = digest('changed');
      if (change === 'runtime_server') f.runtimeIdentity.server_address = '192.168.56.21';
      if (change === 'test_server') f.testIdentity.server_address = '192.168.56.21';
      if (change === 'marker') f.marker.purpose = 'runtime';
      if (change === 'read_only') f.readOnly(false);
      if (change === 'runtime_query') f.runtime.query = vi.fn();
      if (change === 'test_query') f.test.query = vi.fn();
      if (change === 'selected_client') sandbox.client = {} as pg.Client;
      if (change === 'selected_config') sandbox.config.host = 'changed-db.lan';
      await check();
      return 'must_not_acknowledge';
    }),
  ).rejects.toThrow(/^backup_test_database_separation_unavailable$/);
  expect(f.runtime.end).toHaveBeenCalledOnce();
  expect(f.test.end).toHaveBeenCalledOnce();
});
it('rechecks before acknowledgment and expires borrowed guards after closing', async () => {
  const f = await fixture();
  let borrowed: (() => Promise<void>) | undefined;
  await expect(
    f.run(async (_sandbox, check) => {
      borrowed = check;
      f.readOnly(false);
      return 'must_not_acknowledge';
    }),
  ).rejects.toThrow(/^backup_test_database_separation_unavailable$/);
  await expect(borrowed!()).rejects.toThrow(/^backup_test_database_separation_unavailable$/);
});
it('closes the runtime client when selected test admission fails without leaking diagnostics', async () => {
  const f = await fixture();
  ports.test.mockRejectedValue(Error('PRIVATE_TEST_CANARY'));
  const use = vi.fn();
  await expect(f.run(use)).rejects.toThrow(/^backup_test_database_separation_unavailable$/);
  expect(use).not.toHaveBeenCalled();
  expect(f.runtime.end).toHaveBeenCalledOnce();
});
it.skipIf(!process.env.COS_TEST_TARGET_ID)(
  'refuses an actual admitted test database selected again under a runtime connection alias',
  async () => {
    const { connectChecked: connect } =
        await vi.importActual<typeof import('../store/preflight.js')>('../store/preflight.js'),
      keys = [
        'HOST',
        'PORT',
        'DATABASE',
        'SSLMODE',
        'SSLROOTCERT',
        '_ALLOW_PLAINTEXT',
        '_MIGRATION_USER',
        '_MIGRATION_PASSWORD',
      ].map((suffix) => 'COS_TEST_PG' + suffix),
      selected: NodeJS.ProcessEnv = {};
    for (const key of [...keys, 'COS_TEST_TARGET_ID'])
      if (process.env[key] !== undefined) selected[key] = process.env[key];
    // Both actual connections are to the separately admitted test database.
    // The runtime source/profile is an explicit read-only admission fixture.
    const source = await connect(selected, 'test', 'migration');
    const sourceEnd = vi.spyOn(source, 'end');
    let destination: pg.Client | undefined;
    let destinationClosed = () => false;
    try {
      destination = await connect(selected, 'test', 'migration');
      const destinationEnd = vi.spyOn(destination, 'end');
      destinationClosed = () => destinationEnd.mock.calls.length > 0;
      const runtimeEnv: NodeJS.ProcessEnv = {};
      for (const key of keys)
        if (selected[key] !== undefined) runtimeEnv[key.replace('COS_TEST_PG', 'COS_PG')] = selected[key];
      runtimeEnv.COS_PGHOST = 'alias-db.lan';
      runtimeEnv.COS_PGUSER = selected.COS_TEST_PG_MIGRATION_USER;
      runtimeEnv.COS_PGPASSWORD = selected.COS_TEST_PG_MIGRATION_PASSWORD;
      const sourceConfig = parseDatabaseConfig(runtimeEnv, 'runtime'),
        settings = {
          runtimeEnvironment: '/fixture/source-test.env',
          databaseFingerprint: await databaseFingerprint(source, sourceConfig),
        } as DeploymentSettings;
      expect(await databaseFingerprint(destination, parseDatabaseConfig(selected, 'test', 'migration'))).not.toBe(
        settings.databaseFingerprint,
      );
      ports.runtimeEnv.mockReturnValue(runtimeEnv);
      ports.testEnv.mockReturnValue(selected);
      ports.runtime.mockResolvedValue(source);
      ports.test.mockResolvedValue(destination);
      const use = vi.fn();
      await expect(withSeparateBackupTestDatabase(settings, '/fixture/test.env', () => {}, use)).rejects.toThrow(
        /^backup_test_database_separation_unavailable$/,
      );
      expect(use).not.toHaveBeenCalled();
      expect(sourceEnd).toHaveBeenCalledOnce();
      expect(destinationEnd).toHaveBeenCalledOnce();
    } finally {
      await Promise.allSettled([
        ...(sourceEnd.mock.calls.length ? [] : [source.end()]),
        ...(destination && !destinationClosed() ? [destination.end()] : []),
      ]);
    }
  },
  30000,
);
