import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DeploymentSettings } from './deployment-settings.js';
import type { BackupUploadJobEffects } from './backup-upload-job.js';
import { createScheduledMaintenanceEffects } from './operations-maintenance-effects.js';
import { createVaultBackupQueue } from './backup-queue.js';
import { uploadVaultBackup, maintainVaultBackups } from './backup-upload.js';
import { verifyVaultMemory } from './vault-memory.js';
import { verifyTargetPaths } from './target-host.js';
const execute = promisify(execFile);
/** Installed background ports verify the service, recover owned incomplete
 * copies and use the fixed root mount helper. Repository initialization, mount
 * recovery, primary credentials, maintenance and native start/stop are excluded. */
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
      const guard = () => {
        assertCurrent();
        verifyVaultMemory();
        verifyTargetPaths(settings, 0);
      };
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
  };
}
