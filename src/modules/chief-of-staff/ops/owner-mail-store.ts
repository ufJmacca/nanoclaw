import { MailStore } from '../mail/store.js';
import { connectChecked, DatabasePreflightError } from '../store/preflight.js';
import { externalDatabaseConfig, parseDatabaseConfig } from '../store/config.js';
import { migrationStatus, SCHEMA_VERSION } from '../store/migrations.js';
import { BoundedDatabase } from '../store/client.js';
import { openKnowledgeArtifacts } from '../knowledge/config.js';
import { localTarget, databaseFingerprint } from './target-identity.js';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';

/** Only the enclosing trusted owner command admits a paused native binding.
 * This subclass never changes scope status, source policy or model admission.
 */
export class OwnerMailStore extends MailStore {
  protected readonly ownerAdministration = true;
}
/** Dedicated database lifetime; no Calendar/actions, pollers, model or RPC owners. */
export async function connectOwnerMailStore(
  env: NodeJS.ProcessEnv,
  roots: CalendarStorageRoots,
  admitted: () => boolean,
): Promise<OwnerMailStore> {
  const guard = () => {
    if (!admitted()) throw Error('mail_account_operation_unavailable');
  };
  guard();
  const checked = await connectChecked(env, 'runtime');
  try {
    guard();
    const target = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot);
    if (
      (await databaseFingerprint(checked, parseDatabaseConfig(env, 'runtime'))) !== target.binding.databaseFingerprint
    )
      throw new DatabasePreflightError('database_identity_mismatch');
    if ((await migrationStatus(checked)) !== SCHEMA_VERSION) throw new DatabasePreflightError('schema_incompatible');
    guard();
  } finally {
    await checked.end();
  }
  const artifacts = openKnowledgeArtifacts(roots.targetRoot, [roots.installationRoot, roots.dataRoot]),
    config = await externalDatabaseConfig(env, 'runtime');
  guard();
  return new OwnerMailStore(BoundedDatabase.fromConfig(config, admitted), artifacts);
}
