import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { DeploymentSettings } from './deployment-settings.js';
import {
  targetBinding,
  targetCommands,
  verifyTargetPaths,
  checkedTargetDatabase,
  readTargetDatabaseEnvironment,
  RUNTIME_DATABASE_ENVIRONMENT_KEYS,
} from './target-host.js';
import { verifyRetainedAdminHelper } from './retained-admin-helper.js';
import { assertNativeReleaseCompatibility } from './native-release-compatibility.js';
import { migrationStatus } from '../store/migrations.js';
import type { ReleaseManifest } from './release-manifest.js';
import type { OperationsMaintenanceEffects } from './operations-maintenance.js';

/** Compare in the trusted admin's memory. Neither old/new values nor hashes are recorded or forwarded. */
export function runtimeServiceEnvironmentMatches(selected: NodeJS.ProcessEnv, bytes: Buffer): boolean {
  if (
    bytes.length > 65536 ||
    !selected.COS_PGUSER ||
    !selected.COS_PGPASSWORD ||
    Object.keys(selected).some((key) => !RUNTIME_DATABASE_ENVIRONMENT_KEYS.includes(key))
  )
    return false;
  const observed: NodeJS.ProcessEnv = {};
  for (const item of bytes.toString('utf8').split('\0')) {
    const separator = item.indexOf('='),
      key = item.slice(0, separator);
    if (!key.startsWith('COS_PG') && !key.startsWith('COS_TEST_PG')) continue;
    if (separator < 1 || !RUNTIME_DATABASE_ENVIRONMENT_KEYS.includes(key) || observed[key] !== undefined) return false;
    observed[key] = item.slice(separator + 1);
  }
  return Object.entries(selected).every(([key, value]) => value !== undefined && observed[key] === value);
}

/** Fixed installed-service operation. No Docker stops, restore, migration or provider/model calls. */
export function createOperationsMaintenanceEffects(
  settings: DeploymentSettings,
  invokedHelper: string,
): OperationsMaintenanceEffects {
  const binding = targetBinding(settings),
    commands = targetCommands(settings),
    central = path.join(settings.dataRoot, 'v2.db');
  let manifest: ReleaseManifest | undefined;
  const native = <T>(operation: (db: Database.Database) => T) => {
    const db = new Database(central, { readonly: true, fileMustExist: true });
    try {
      return operation(db);
    } finally {
      db.close();
    }
  };
  const paused = () =>
    native((db) => {
      const rows = db.prepare('SELECT paused FROM cos_identity_boundaries LIMIT 2').all() as Array<{ paused: number }>;
      if (rows.length !== 1 || rows[0].paused !== 1 || !manifest) throw new Error('operations_maintenance_unverified');
      assertNativeReleaseCompatibility(db, manifest);
    });
  const databaseCompatible = async () => {
    if (!manifest) return false;
    let client: Awaited<ReturnType<typeof checkedTargetDatabase>> | undefined;
    try {
      client = await checkedTargetDatabase(settings);
      const version = await migrationStatus(client);
      return (
        version >= manifest.postgres.minimum &&
        version <= manifest.postgres.maximum &&
        (await client.query('SELECT pg_try_advisory_lock(73101003) AS locked')).rows[0]?.locked === true
      );
      // eslint-disable-next-line no-catch-all/no-catch-all -- Missing old/new access leaves the maintenance latch closed and exposes no credential or driver diagnostics.
    } catch {
      return false;
    } finally {
      await client?.end();
    }
  };
  const workersIdle = async () => (await commands.ownedContainers()).length === 0;
  return {
    async verify() {
      verifyTargetPaths(settings, 0);
      manifest = await verifyRetainedAdminHelper(settings, binding, invokedHelper);
      paused();
      return manifest;
    },
    workersIdle,
    async stopNative() {
      paused();
      if (!(await workersIdle())) throw new Error('operations_workers_active');
      await commands.service('stop');
    },
    async nativeStopped() {
      paused();
      const observed = await commands.observe();
      if (
        observed.pid !== 0 ||
        observed.cwd !== settings.installationRoot ||
        !['inactive', 'failed'].includes(observed.activeState) ||
        !(await workersIdle())
      )
        return false;
      return native((db) => {
        const lease = db.prepare('SELECT pid FROM host_execution_lease WHERE singleton_id=1').get() as
          | { pid: number }
          | undefined;
        return !lease || (Number.isSafeInteger(lease.pid) && lease.pid > 0 && !fs.existsSync('/proc/' + lease.pid));
      });
    },
    databaseCompatible,
    async startNative() {
      paused();
      await commands.service('start');
    },
    async healthy() {
      paused();
      const observed = await commands.observe();
      if (
        !manifest ||
        observed.cwd !== settings.installationRoot ||
        observed.activeState !== 'active' ||
        observed.subState !== 'running' ||
        observed.pid <= 0
      )
        return false;
      const proc = '/proc/' + observed.pid,
        payload = path.join(settings.releaseRoot, manifest.releaseId, 'payload');
      if (
        fs.statSync(proc).uid !== process.getuid?.() ||
        fs.readlinkSync(proc + '/cwd') !== settings.installationRoot ||
        fs.readlinkSync(proc + '/exe') !== path.join(payload, 'node/bin/node')
      )
        return false;
      const args = fs
        .readFileSync(proc + '/cmdline', 'utf8')
        .split('\0')
        .filter(Boolean);
      if (args.length !== 2 || args[1] !== path.join(payload, 'dist/index.js')) return false;
      const owned = native(
        (db) =>
          (db.prepare('SELECT pid FROM host_execution_lease WHERE singleton_id=1').get() as { pid: number } | undefined)
            ?.pid === observed.pid,
      );
      if (!owned) return false;
      const environment = fs.readFileSync(proc + '/environ');
      let injected: boolean;
      try {
        injected = runtimeServiceEnvironmentMatches(readTargetDatabaseEnvironment(settings, 'runtime'), environment);
      } finally {
        environment.fill(0);
      }
      return injected && (await databaseCompatible());
    },
  };
}
