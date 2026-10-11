import { digest } from '../domain/contracts.js';
import { deploymentSettings, type DeploymentSettings } from './deployment-settings.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import { readTarget } from './target-state.js';
import { admittedGeneration } from './maintenance.js';
import { withDeploymentLock } from './deployment-lock.js';
import { targetBinding, verifyTargetPaths } from './target-host.js';
import { verifyVaultMemory } from './vault-memory.js';
import { createScheduledMaintenanceEffects } from './operations-maintenance-effects.js';
import { createBackupJobInstaller } from './backup-job-install.js';
import { createBackupJobManagerControls } from './backup-job-install-effects.js';
/** Installed owner command, after healthy G02 activation. Files are published
 * under the existing operation lock and both independent job locks. Timers
 * start only after those locks are released, while the installer lock still
 * prevents another configuration attempt. No native pause/context writes. */
export async function configureTargetBackupJobs(
  input: DeploymentSettings,
  invokedHelper: string,
): Promise<Record<string, unknown>> {
  try {
    const settings = deploymentSettings(structuredClone(input)),
      binding = targetBinding(settings),
      service = createScheduledMaintenanceEffects(settings, invokedHelper);
    let selected: ReleaseManifest | undefined, generation: number | undefined;
    const assertScope = () => {
      const state = readTarget(settings.stateRoot, binding),
        current = admittedGeneration(settings.stateRoot, binding);
      if (
        !selected ||
        selected.slice !== 'G02' ||
        state.lifecycle !== 'protected' ||
        state.releaseId !== selected.releaseId ||
        current === null ||
        (generation !== undefined && generation !== current)
      )
        throw Error('backup_job_installation_unavailable');
      generation ??= current;
    };
    const assertCurrent = async () => {
      verifyVaultMemory();
      verifyTargetPaths(settings, 0);
      const manifest = validateReleaseManifest(await service.verify());
      if (selected && digest(selected) !== digest(manifest)) throw Error('backup_job_installation_unavailable');
      selected ??= manifest;
      assertScope();
      if (!(await service.healthy())) throw Error('backup_job_installation_unavailable');
      verifyVaultMemory();
      assertScope();
    };
    return await withDeploymentLock(settings.stateRoot + '.backup-jobs-install.lock', async () => {
      await assertCurrent();
      const installer = createBackupJobInstaller(
        settings,
        selected!,
        createBackupJobManagerControls(settings, assertCurrent),
      );
      await withDeploymentLock(settings.stateRoot + '.operation.lock', () =>
        withDeploymentLock(settings.stateRoot + '.backup-schedule.lock', () =>
          withDeploymentLock(settings.stateRoot + '.backup-upload.lock', async () => {
            await assertCurrent();
            await installer.install();
            await assertCurrent();
          }),
        ),
      );
      await assertCurrent();
      return installer.activate();
    });
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Only fixed busy/unavailable status may leave this installed administration command.
    throw Error(
      error instanceof Error && error.message === 'target_deployment_locked'
        ? 'backup_job_installation_busy'
        : 'backup_job_installation_unavailable',
    );
  }
}
