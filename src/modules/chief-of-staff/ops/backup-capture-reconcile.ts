import { digest } from '../domain/contracts.js';
import { deploymentSettings, type DeploymentSettings } from './deployment-settings.js';
import type { BackupKind } from './backup-policy.js';
import { createVaultBackupQueue } from './backup-queue.js';
import { withDeploymentLock } from './deployment-lock.js';
import { admittedGeneration } from './maintenance.js';
import { createScheduledMaintenanceEffects } from './operations-maintenance-effects.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import { targetBinding, verifyTargetPaths } from './target-host.js';
import { readTarget } from './target-state.js';
import { verifyVaultMemory } from './vault-memory.js';

/** Fixed installed owner operation. Current retained G02/healthy admission and
 * the queue's kernel writer are required throughout. It neither captures new
 * state nor changes primary credentials, native pause, admission or the NAS. */
export async function reconcileTargetBackupCapture(
  input: DeploymentSettings,
  invokedHelper: string,
  kind: BackupKind,
  operationId: string,
): Promise<Record<string, unknown>> {
  try {
    if (
      !['state', 'credentials'].includes(kind) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId)
    )
      throw Error('backup_capture_recovery_unavailable');
    const settings = deploymentSettings(structuredClone(input)),
      binding = targetBinding(settings),
      service = createScheduledMaintenanceEffects(settings, invokedHelper);
    let selected: ReleaseManifest | undefined, generation: number | undefined;
    const assertScope = () => {
      verifyVaultMemory();
      verifyTargetPaths(settings, 0);
      const state = readTarget(settings.stateRoot, binding),
        current = admittedGeneration(settings.stateRoot, binding);
      if (
        !selected ||
        selected.slice !== 'G02' ||
        state.lifecycle !== 'protected' ||
        state.releaseId !== selected.releaseId ||
        current === null ||
        (generation !== undefined && current !== generation)
      )
        throw Error('backup_capture_recovery_unavailable');
      generation ??= current;
    };
    const current = async () => {
      verifyVaultMemory();
      verifyTargetPaths(settings, 0);
      const manifest = validateReleaseManifest(await service.verify());
      if (selected && digest(selected) !== digest(manifest)) throw Error('backup_capture_recovery_unavailable');
      selected ??= manifest;
      assertScope();
      if (!(await service.healthy())) throw Error('backup_capture_recovery_unavailable');
      assertScope();
    };
    return await withDeploymentLock(settings.stateRoot + '.operation.lock', async () => {
      await current();
      const recovered = await createVaultBackupQueue({
        targetRoot: settings.stateRoot,
        installationRoot: settings.installationRoot,
        dataRoot: settings.dataRoot,
      }).reconcileCapture(kind, operationId, assertScope);
      await current();
      return { status: recovered.status, kind, operationId, releaseId: selected!.releaseId };
    });
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Captured contents and host diagnostics never leave this owner command.
    throw Error(
      error instanceof Error && error.message === 'target_deployment_locked'
        ? 'backup_capture_recovery_busy'
        : 'backup_capture_recovery_unavailable',
    );
  }
}
