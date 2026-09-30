import { localTarget, databaseFingerprint } from './ops/target-identity.js';
import { connectChecked, DatabasePreflightError } from './store/preflight.js';
import { externalDatabaseConfig, parseDatabaseConfig } from './store/config.js';
import { migrationStatus, SCHEMA_VERSION } from './store/migrations.js';
import { BoundedDatabase } from './store/client.js';
import { PriorityStore } from './store/priorities.js';
import type { PurgeHooks } from './knowledge/purge.js';
import { KnowledgeStore } from './knowledge/store.js';
import { knowledgeSettings, openKnowledgeArtifacts } from './knowledge/config.js';

/** Runtime credentials only. Startup validates the schema; it never migrates or opens source access implicitly. */
export async function connectCosHostStore(
  env: NodeJS.ProcessEnv,
  roots: { targetRoot: string; installationRoot: string; dataRoot: string },
  admitted: () => boolean,
  retention: Pick<PurgeHooks, 'purgeContexts'> = {},
): Promise<PriorityStore> {
  const settings = knowledgeSettings(env);
  const check = await connectChecked(env, 'runtime');
  try {
    const target = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot);
    if ((await databaseFingerprint(check, parseDatabaseConfig(env, 'runtime'))) !== target.binding.databaseFingerprint)
      throw new DatabasePreflightError('database_identity_mismatch');
    if ((await migrationStatus(check)) !== SCHEMA_VERSION) throw new DatabasePreflightError('schema_incompatible');
  } finally {
    await check.end();
  }
  const artifacts = openKnowledgeArtifacts(roots.targetRoot, [roots.installationRoot, roots.dataRoot]);
  const database = BoundedDatabase.fromConfig(await externalDatabaseConfig(env, 'runtime'), admitted);
  // Keep the store and its denial/retention obligations active when ingestion/retrieval are switched off.
  return new PriorityStore(
    database,
    new KnowledgeStore(database, artifacts, retention, {
      retentionMs: settings.retentionMs,
      retrievalEnabled: () => settings.enabled,
    }),
  );
}
