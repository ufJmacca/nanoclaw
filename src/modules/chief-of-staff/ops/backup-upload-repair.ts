import path from 'node:path';
import { digest } from '../domain/contracts.js';
import type { DeploymentSettings } from './deployment-settings.js';
import type { BackupUploadJobEffects } from './backup-upload-job.js';
import { createBackupUploadJobEffects } from './backup-upload-job-effects.js';
import { verifyBackupInitializationRepair } from './backup-initialization-repair.js';
import { targetBinding } from './target-host.js';
import { verifyVaultMemory } from './vault-memory.js';

/** Deliver pending copies with a fully tested prepared repair while the healthy
 * runtime remains installed. The ordinary job, queue, original receipt, remote
 * readback and repository writer retain all upload and retirement authority.
 * This adds no capture, activation, migration, credential or service controls. */
export function createBackupUploadRepairEffects(
  settings: DeploymentSettings,
  invokedHelper: string,
): BackupUploadJobEffects {
  let installed: BackupUploadJobEffects | undefined, expected: string | undefined;
  const current = () => {
    if (!installed) throw Error('backup_upload_repair_verification_required');
    return installed;
  };
  const verify = async () => {
    verifyVaultMemory();
    const proof = await verifyBackupInitializationRepair(settings, targetBinding(settings), invokedHelper),
      identity = digest(proof);
    if (expected && expected !== identity) throw Error('backup_upload_repair_changed');
    const effects = createBackupUploadJobEffects(
      settings,
      path.join(
        settings.releaseRoot,
        proof.runtime.releaseId,
        'payload/dist/modules/chief-of-staff/ops/target-helper.js',
      ),
    );
    if (digest(await effects.verify()) !== digest(proof.runtime)) throw Error('backup_upload_repair_runtime_changed');
    verifyVaultMemory();
    expected ??= identity;
    installed = effects;
    return proof.runtime;
  };
  const admitted = async <T>(guard: () => void, operation: () => Promise<T>): Promise<T> => {
    await verify();
    guard();
    const result = await operation();
    guard();
    await verify();
    return result;
  };
  return {
    verify,
    healthy: () => current().healthy(),
    inspect: (kind) => current().inspect(kind),
    reconcile: (kind, guard) => admitted(guard, () => current().reconcile(kind, guard)),
    mount: (guard) => admitted(guard, () => current().mount(guard)),
    upload: (kind, operationId, guard) => admitted(guard, () => current().upload(kind, operationId, guard)),
    maintain: (guard) => admitted(guard, () => current().maintain(guard)),
  };
}
