import path from 'node:path';
import { digest } from '../domain/contracts.js';
import type { DeploymentSettings } from './deployment-settings.js';
import { readPrivate } from './target-state.js';
import { targetBinding } from './target-host.js';
import { createScheduledMaintenanceEffects } from './operations-maintenance-effects.js';
import { recoveryReleaseForManifest, type RecoveryRelease } from './recovery-manifest.js';
import { captureScheduledTargetVaultState, verifyScheduledTargetVaultState } from './backup-state-capture.js';
import { createVaultBackupQueue } from './backup-queue.js';
import { verifyVaultMemory } from './vault-memory.js';
import { assertMaintenanceLease, type MaintenanceLease } from './maintenance.js';
import type { CheckpointMaintenanceEffects } from './checkpoint-maintenance.js';

/** Installed scheduled checkpoint ports. No native pause/context writes, model
 * calls, restored authority, plaintext staging or NAS dependency.
 */
export function createCheckpointMaintenanceEffects(
  settings: DeploymentSettings,
  invokedHelper: string,
  requestId: string,
): CheckpointMaintenanceEffects {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId))
    throw Error('checkpoint_maintenance_unverified');
  const service = createScheduledMaintenanceEffects(settings, invokedHelper),
    binding = targetBinding(settings),
    operationId = 'release-backup-' + requestId,
    roots = {
      targetRoot: settings.stateRoot,
      installationRoot: settings.installationRoot,
      dataRoot: settings.dataRoot,
    };
  let recovery: RecoveryRelease | undefined;
  const recorded = async () => {
    verifyVaultMemory();
    const manifest = await service.verify();
    if (!['G02', 'G03', 'G04', 'G05'].includes(manifest.slice)) throw Error('checkpoint_maintenance_unverified');
    const selected = recoveryReleaseForManifest(manifest),
      receipt = readPrivate<Record<string, unknown>>(
        path.join(settings.stateRoot, 'releases', manifest.releaseId, 'deployment.json'),
      );
    if (
      receipt.version !== 1 ||
      receipt.releaseId !== manifest.releaseId ||
      receipt.manifestDigest !== selected.manifestDigest ||
      receipt.bindingDigest !== digest(binding) ||
      receipt.status !== 'healthy' ||
      receipt.pending !== null ||
      !Array.isArray(receipt.completed) ||
      receipt.completed.join(',') !== 'source,artifacts,quiesce,backup,migrate,activate,health' ||
      (recovery && digest(recovery) !== digest(selected))
    )
      throw Error('checkpoint_maintenance_unverified');
    recovery = selected;
    return manifest;
  };
  const held = async (lease: MaintenanceLease) => {
    await recorded();
    if (lease.owner !== operationId || lease.purpose !== 'deployment' || !recovery)
      throw Error('checkpoint_maintenance_unverified');
    assertMaintenanceLease(settings.stateRoot, binding, lease);
    return recovery;
  };
  return {
    ...service,
    verify: recorded,
    inspect: async () => {
      verifyVaultMemory();
      return createVaultBackupQueue(roots).inspect('state');
    },
    capture: async (lease) => captureScheduledTargetVaultState(settings, operationId, await held(lease)),
    verifyCapture: async (lease, expected) =>
      verifyScheduledTargetVaultState(settings, operationId, await held(lease), expected),
  };
}
