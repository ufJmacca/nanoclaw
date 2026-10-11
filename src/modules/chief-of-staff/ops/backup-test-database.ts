import type pg from 'pg';
import type { PoolConfig } from 'pg';
import type { DeploymentSettings } from './deployment-settings.js';
import { digest } from '../domain/contracts.js';
import { connectChecked, assertTestTarget } from '../store/preflight.js';
import { parseDatabaseConfig } from '../store/config.js';
import { checkedTargetDatabase, readTargetDatabaseEnvironment, readTargetTestEnvironment } from './target-host.js';
import { databaseFingerprint, databasePhysicalFingerprint } from './target-identity.js';

export type BackupTestDatabase = { client: pg.Client; config: PoolConfig; testTargetId: string };
export async function withSeparateBackupTestDatabase<T>(
  settings: DeploymentSettings,
  testEnvironmentFile: string,
  assertOwner: () => void,
  use: (sandbox: BackupTestDatabase, check: () => Promise<void>) => Promise<T>,
): Promise<T> {
  try {
    let active = true,
      cleanupFailed = false;
    const clients: Array<() => Promise<void>> = [],
      outcome: { result?: T } = {};
    try {
      assertOwner();
      const runtimeEnv = readTargetDatabaseEnvironment(settings, 'runtime'),
        testEnv = readTargetTestEnvironment(testEnvironmentFile),
        runtimeConfig = parseDatabaseConfig(runtimeEnv, 'runtime'),
        testConfig = parseDatabaseConfig(testEnv, 'test', 'migration'),
        testTargetId = testEnv.COS_TEST_TARGET_ID;
      if (!testTargetId) throw Error('test_marker_required');
      const profile = () =>
          digest({
            settings,
            runtime: readTargetDatabaseEnvironment(settings, 'runtime'),
            test: readTargetTestEnvironment(testEnvironmentFile),
            runtimeConfig,
            testConfig,
          }),
        initial = profile();
      const current = () => {
        if (!active || profile() !== initial) throw Error('test_profile_changed');
        assertOwner();
      };
      current();
      // This client is never exposed to the importer. Session-wide read-only
      // mode avoids holding a long transaction while remote recovery runs.
      const runtime = await checkedTargetDatabase(settings),
        runtimeQuery = runtime.query;
      clients.push(runtime.end.bind(runtime));
      current();
      await runtime.query('SET default_transaction_read_only = on');
      current();
      const client = await connectChecked(testEnv, 'test', 'migration'),
        testQuery = client.query;
      clients.push(client.end.bind(client));
      const sandbox: BackupTestDatabase = { client, config: testConfig, testTargetId };
      const pin = digest({ config: sandbox.config, testTargetId: sandbox.testTargetId });
      const held = () => {
        current();
        if (
          runtime.query !== runtimeQuery ||
          client.query !== testQuery ||
          sandbox.client !== client ||
          digest({ config: sandbox.config, testTargetId: sandbox.testTargetId }) !== pin
        )
          throw Error('test_client_changed');
      };
      const identities: { runtime?: string; test?: string } = {};
      const check = async () => {
        try {
          held();
          if (
            (await runtime.query("SELECT current_setting('default_transaction_read_only') AS read_only")).rows[0]
              ?.read_only !== 'on'
          )
            throw Error('runtime_read_only_required');
          held();
          if ((await databaseFingerprint(runtime, runtimeConfig)) !== settings.databaseFingerprint)
            throw Error('runtime_identity_changed');
          held();
          const actualRuntime = await databasePhysicalFingerprint(runtime, runtimeConfig);
          held();
          await assertTestTarget(client, testTargetId);
          held();
          const actualTest = await databasePhysicalFingerprint(client, testConfig);
          held();
          if (
            actualTest === actualRuntime ||
            (identities.runtime && identities.runtime !== actualRuntime) ||
            (identities.test && identities.test !== actualTest)
          )
            throw Error('separate_test_database_required');
          identities.runtime = actualRuntime;
          identities.test = actualTest;
        } catch {
          // eslint-disable-next-line preserve-caught-error -- Profiles, server addresses and driver failures remain private, including expired borrowed checks.
          throw Error('backup_test_database_separation_unavailable');
        }
      };
      await check();
      const result = await use(sandbox, check);
      await check();
      outcome.result = result;
    } finally {
      active = false;
      const closed = await Promise.allSettled(clients.map((close) => close()));
      cleanupFailed = closed.some((result) => result.status === 'rejected');
    }
    if (cleanupFailed) throw Error('database_cleanup_unavailable');
    return outcome.result as T;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Trusted database admission never exposes selected profiles or private driver diagnostics.
    throw Error('backup_test_database_separation_unavailable');
  }
}
