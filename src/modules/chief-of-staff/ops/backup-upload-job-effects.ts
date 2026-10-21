import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DeploymentSettings } from './deployment-settings.js';
import type { BackupUploadJobEffects } from './backup-upload-job.js';
import { createScheduledMaintenanceEffects } from './operations-maintenance-effects.js';
import { createVaultBackupQueue } from './backup-queue.js';
import { uploadVaultBackup, maintainVaultBackups, uploadVaultCredentialCapture } from './backup-upload.js';
import { recordScheduledCredentialRecoveryPage } from './credential-recovery-page.js';
import { verifyVaultMemory } from './vault-memory.js';
import { verifyTargetPaths } from './target-host.js';
const execute = promisify(execFile);
/** Installed background ports verify the service and use fixed local/repository
 * wrappers. G04 adds bounded local configuration/denial journaling and direct
 * primary capture; it never refreshes tokens, initializes/repairs a repository,
 * invokes a model, pauses native work or starts/stops the runtime service. */
export function createBackupUploadJobEffects(
  settings: DeploymentSettings,
  invokedHelper: string,
): BackupUploadJobEffects {
  const service = createScheduledMaintenanceEffects(settings, invokedHelper),
    roots = {
      targetRoot: settings.stateRoot,
      installationRoot: settings.installationRoot,
      dataRoot: settings.dataRoot,
    };
  const guardFor = (assertCurrent: () => void) => () => {
    assertCurrent();
    verifyVaultMemory();
    verifyTargetPaths(settings, 0);
  };
  return {
    async verify() {
      verifyVaultMemory();
      return service.verify();
    },
    healthy: () => service.healthy(),
    async inspect(kind) {
      verifyVaultMemory();
      return createVaultBackupQueue(roots).inspectDelivery(kind);
    },
    async reconcile(kind, assertCurrent) {
      const guard = guardFor(assertCurrent);
      guard();
      await createVaultBackupQueue(roots).reconcileIncompleteCapture(kind, guard);
      guard();
    },
    async mount(assertCurrent) {
      try {
        assertCurrent();
        verifyVaultMemory();
        await execute('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', 'start', 'nanoclaw-cos-backup-mount.service'], {
          cwd: '/',
          timeout: 35000,
          maxBuffer: 4096,
          env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
        });
        assertCurrent();
        verifyVaultMemory();
      } catch {
        // eslint-disable-next-line preserve-caught-error -- Root service diagnostics and private NAS state are not job output.
        throw Error('backup_upload_mount_unavailable');
      }
    },
    upload: (kind, operationId, assertCurrent) => uploadVaultBackup(roots, kind, operationId, assertCurrent),
    maintain: (assertCurrent) => maintainVaultBackups(roots, assertCurrent),
    async journalCredentials(scope, assertCurrent) {
      const guard = guardFor(assertCurrent);
      guard();
      const page = await recordScheduledCredentialRecoveryPage(roots, { ...scope, assertAuthority: guard });
      guard();
      return page;
    },
    async captureCredentials(cycleAt, assertCurrent) {
      const guard = guardFor(assertCurrent);
      guard();
      const capture = await uploadVaultCredentialCapture(roots, cycleAt, guard);
      guard();
      return capture;
    },
  };
}
