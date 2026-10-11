import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deploymentSettings } from './deployment-settings.js';
import { readPrivate } from './target-state.js';
import { scheduledBackupJob } from './backup-scheduled-job.js';
import { verifyVaultMemory } from './vault-memory.js';
const execute = promisify(execFile);
export function parseBackupScheduleArguments(args: string[]): { job: 'capture' | 'upload'; settings: string } {
  if (
    args.length !== 3 ||
    !['capture', 'upload'].includes(args[0]) ||
    args[1] !== '--settings' ||
    !/^\/[a-zA-Z0-9_./-]{1,299}$/.test(args[2]) ||
    path.resolve(args[2]) !== args[2]
  )
    throw Error('invalid_backup_schedule_arguments');
  return { job: args[0] as 'capture' | 'upload', settings: args[2] };
}
export async function backupScheduleCommand(args: string[]): Promise<Record<string, unknown>> {
  const request = parseBackupScheduleArguments(args),
    settings = deploymentSettings(readPrivate(request.settings));
  process.chdir(settings.installationRoot);
  verifyVaultMemory();
  const { targetBinding, verifyTargetPaths } = await import('./target-host.js');
  const { createScheduledMaintenanceEffects } = await import('./operations-maintenance-effects.js');
  const { targetCommand } = await import('./target-helper.js');
  verifyTargetPaths(settings, 0);
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || !uid || uid < 1) throw Error('backup_schedule_unavailable');
  const service = createScheduledMaintenanceEffects(
    settings,
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'target-helper.js'),
  );
  return scheduledBackupJob({
    root: settings.stateRoot,
    binding: targetBinding(settings),
    job: request.job,
    effects: {
      verify: () => service.verify(),
      healthy: () => service.healthy(),
      capture: (requestId) =>
        targetCommand(['scheduled-backup', '--settings', request.settings, '--request-id', requestId]),
      upload: (requestId) =>
        targetCommand(['upload-backups', '--settings', request.settings, '--request-id', requestId]),
      async dispatchUpload() {
        await execute('/usr/bin/systemctl', ['--user', 'start', '--no-block', 'nanoclaw-cos-backup-upload.service'], {
          cwd: settings.installationRoot,
          timeout: 5000,
          maxBuffer: 4096,
          env: {
            PATH: '/usr/bin:/bin',
            LANG: 'C',
            LC_ALL: 'C',
            HOME: settings.userHome,
            XDG_RUNTIME_DIR: '/run/user/' + uid,
            DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/' + uid + '/bus',
          },
        });
      },
    },
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.env.NANOCLAW_LOG_STDERR = 'true';
  backupScheduleCommand(process.argv.slice(2))
    .then((result) => {
      console.log(JSON.stringify(result));
      if (result.status === 'backup_upload_failed' || result.checkpointStatus === 'backup_failed') process.exitCode = 1;
    })
    .catch((error) => {
      const safe = ['invalid_backup_schedule_arguments', 'backup_schedule_unavailable', 'backup_schedule_locked'];
      console.error(
        JSON.stringify({
          status: 'unavailable',
          code: error instanceof Error && safe.includes(error.message) ? error.message : 'backup_schedule_unavailable',
        }),
      );
      process.exitCode = 1;
    });
}
