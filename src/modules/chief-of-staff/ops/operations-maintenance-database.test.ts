import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type pg from 'pg';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectFixtureDatabase, fixtureProfile } from '../../../contracts/chief-of-staff/fixture-database.js';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import type { DeploymentSettings } from './deployment-settings.js';

const ports = vi.hoisted(() => ({
  connect: vi.fn(),
  paths: vi.fn(),
  retained: vi.fn(),
  nativeCompatibility: vi.fn(),
  duringSchemaCheck: vi.fn(),
  commands: vi.fn(),
  process: undefined as
    | { pid: number; cwd: string; executable: string; arguments: string; environment: Buffer }
    | undefined,
}));
// Native/process attestation is synthetic; PostgreSQL admission, schema reads
// and competing session locks use only the separately admitted real test DB.
vi.mock('./target-host.js', async (original) => ({
  ...(await original<typeof import('./target-host.js')>()),
  checkedTargetDatabase: ports.connect,
  verifyTargetPaths: ports.paths,
  targetCommands: ports.commands,
  readTargetDatabaseEnvironment: () => ({ COS_PGUSER: 'fixture-health', COS_PGPASSWORD: 'synthetic' }),
}));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      readlinkSync: (...args: unknown[]) => {
        const file = String(args[0]),
          nativeProcess = ports.process;
        if (nativeProcess && file === '/proc/' + nativeProcess.pid + '/cwd') return nativeProcess.cwd;
        if (nativeProcess && file === '/proc/' + nativeProcess.pid + '/exe') return nativeProcess.executable;
        return Reflect.apply(actual.readlinkSync, actual, args);
      },
      readFileSync: (...args: unknown[]) => {
        const file = String(args[0]),
          nativeProcess = ports.process;
        if (nativeProcess && file === '/proc/' + nativeProcess.pid + '/cmdline') return nativeProcess.arguments;
        if (nativeProcess && file === '/proc/' + nativeProcess.pid + '/environ')
          return Buffer.from(nativeProcess.environment);
        return Reflect.apply(actual.readFileSync, actual, args);
      },
    },
  };
});
vi.mock('./retained-admin-helper.js', () => ({ verifyRetainedAdminHelper: ports.retained }));
vi.mock('./native-release-compatibility.js', () => ({
  assertNativeReleaseCompatibility: ports.nativeCompatibility,
}));
vi.mock('../store/migrations.js', async (original) => {
  const actual = await original<typeof import('../store/migrations.js')>();
  return {
    ...actual,
    migrationStatus: async (client: pg.Client) => {
      await ports.duringSchemaCheck();
      return actual.migrationStatus(client);
    },
  };
});
import { migrationStatus, SCHEMA_VERSION } from '../store/migrations.js';
import { createScheduledMaintenanceEffects } from './operations-maintenance-effects.js';

const roots: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  ports.process = undefined;
  ports.duringSchemaCheck.mockReset();
  ports.duringSchemaCheck.mockResolvedValue(undefined);
  ports.connect.mockImplementation(async () => {
    expect(fixtureProfile()).toBe('test');
    const client = await connectFixtureDatabase(process.env, 'runtime');
    await client.query('SET default_transaction_read_only = on');
    return client;
  });
});
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(slice: 'G03' | 'G04' = 'G04') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-schema-health-'));
  roots.push(home);
  const settings: DeploymentSettings = {
    version: 1,
    target: 'pi',
    sshAlias: 'fixture',
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    userHome: home,
    installationRoot: home + '/app',
    dataRoot: home + '/app/data',
    stateRoot: home + '/state',
    releaseRoot: home + '/releases',
    stagingRoot: home + '/staging',
    sourceRoot: home + '/sources',
    runtimeEnvironment: home + '/.config/runtime',
    migrationEnvironment: home + '/.config/migration',
  };
  fs.mkdirSync(settings.dataRoot, { recursive: true });
  const native = new Database(settings.dataRoot + '/v2.db');
  native.exec(
    'CREATE TABLE cos_identity_boundaries(paused INTEGER); INSERT INTO cos_identity_boundaries VALUES(1);' +
      'CREATE TABLE host_execution_lease(singleton_id INTEGER,pid INTEGER);' +
      'INSERT INTO host_execution_lease VALUES(1,' +
      process.pid +
      ')',
  );
  native.close();
  const manifest = fixtureVaultRelease(slice),
    payload = settings.releaseRoot + '/' + manifest.releaseId + '/payload';
  ports.retained.mockResolvedValue(manifest);
  ports.commands.mockReturnValue({
    observe: async () => ({
      cwd: settings.installationRoot,
      activeState: 'active',
      subState: 'running',
      pid: process.pid,
    }),
  });
  ports.process = {
    pid: process.pid,
    cwd: settings.installationRoot,
    executable: payload + '/node/bin/node',
    arguments: payload + '/node/bin/node\0' + payload + '/dist/index.js\0',
    environment: Buffer.from('COS_PGUSER=fixture-health\0COS_PGPASSWORD=synthetic\0'),
  };
  const effects = createScheduledMaintenanceEffects(settings, '/fixture/target-helper.js');
  await effects.verify();
  return effects;
}

async function withTestClient(use: (client: pg.Client) => Promise<void>) {
  expect(fixtureProfile()).toBe('test');
  const client = await connectFixtureDatabase(process.env, 'runtime');
  try {
    await client.query('SET default_transaction_read_only = on');
    expect(await migrationStatus(client)).toBe(SCHEMA_VERSION);
    await use(client);
  } finally {
    await client.end();
  }
}

const configured = process.env.COS_TEST_TARGET_ID !== undefined;
it.runIf(configured)('accepts compatible schema health while an admitted reader holds the schema fence', async () => {
  await withTestClient(async (reader) => {
    const effects = await fixture();
    await reader.query('SELECT pg_advisory_lock_shared(73101003)');
    expect(await effects.healthy()).toBe(true);
  });
});

it.runIf(configured)('denies schema health while a migration holds the exclusive schema fence', async () => {
  await withTestClient(async (migration) => {
    const effects = await fixture();
    await migration.query('SELECT pg_advisory_lock(73101003)');
    expect(await effects.healthy()).toBe(false);
  });
});

it.runIf(configured)('denies an incompatible sealed release and releases the schema fence', async () => {
  await withTestClient(async (observer) => {
    const effects = await fixture('G03');
    expect(await effects.healthy()).toBe(false);
    const { rows } = await observer.query('SELECT pg_try_advisory_lock(73101003) AS locked');
    expect(rows[0].locked).toBe(true);
    await observer.query('SELECT pg_advisory_unlock(73101003)');
  });
});

it.runIf(configured)('excludes a concurrent migration throughout the schema compatibility read', async () => {
  await withTestClient(async (migration) => {
    const effects = await fixture();
    let acquired: boolean | undefined;
    ports.duringSchemaCheck.mockImplementation(async () => {
      if (acquired !== undefined) return;
      acquired = (await migration.query('SELECT pg_try_advisory_lock(73101003) AS locked')).rows[0].locked;
      if (acquired) await migration.query('SELECT pg_advisory_unlock(73101003)');
    });
    expect(await effects.healthy()).toBe(true);
    expect(acquired).toBe(false);
  });
});

it.runIf(configured)(
  'keeps the quiescence compatibility gate exclusive while an admitted reader is active',
  async () => {
    await withTestClient(async (reader) => {
      const effects = await fixture();
      await reader.query('SELECT pg_advisory_lock_shared(73101003)');
      expect(await effects.databaseCompatible()).toBe(false);
    });
  },
);
