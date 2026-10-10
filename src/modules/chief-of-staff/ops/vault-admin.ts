import path from 'node:path';
import { localTarget } from './target-identity.js';
import { vaultStorageStatus } from './vault-storage.js';
/** Host-owner inspection only. No database connection, token read, model turn or directory creation. */
export function vaultStatusCommand(env: NodeJS.ProcessEnv): Record<string, unknown> {
  try {
    if (!env.COS_TARGET_STATE_DIR) throw new Error('target_unbound');
    const target = localTarget(env.COS_TARGET_STATE_DIR, process.cwd(), path.join(process.cwd(), 'data'));
    if (target.lifecycle !== 'protected') throw new Error('target_unprotected');
    return vaultStorageStatus({
      targetRoot: env.COS_TARGET_STATE_DIR,
      installationRoot: target.binding.installationRoot,
      dataRoot: target.binding.dataRoot,
    });
  } catch {
    // eslint-disable-next-line no-catch-all/no-catch-all -- Owner health returns a fixed failure without target diagnostics or private paths.
    return { status: 'unavailable', googleCredentials: 'unavailable', code: 'vault_storage_unavailable' };
  }
}
