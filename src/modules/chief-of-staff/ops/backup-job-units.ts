import path from 'node:path';
import { deploymentSettings, type DeploymentSettings } from './deployment-settings.js';
export type BackupJobUnit = Readonly<{ name: string; contents: string }>;
/** Fixed user-manager definitions, independent of the main chat unit and root
 * mount unit. The entry clears inherited environment; selected database access
 * is read privately by the trusted installed helper. Installation and manager
 * activation require their separate current release/target proofs. */
export function backupJobUnits(input: {
  settings: DeploymentSettings;
  settingsPath: string;
  releaseId: string;
}): readonly BackupJobUnit[] {
  try {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'releaseId,settings,settingsPath'
    )
      throw Error('invalid_backup_units');
    const settings = deploymentSettings(input.settings);
    if (
      typeof input.settingsPath !== 'string' ||
      !/^\/[a-zA-Z0-9_./-]{1,299}$/.test(input.settingsPath) ||
      path.resolve(input.settingsPath) !== input.settingsPath ||
      !input.settingsPath.startsWith(settings.userHome + '/.config/') ||
      [settings.runtimeEnvironment, settings.migrationEnvironment].includes(input.settingsPath) ||
      typeof input.releaseId !== 'string' ||
      !/^release-[a-zA-Z0-9_-]{1,120}$/.test(input.releaseId)
    )
      throw Error('invalid_backup_units');
    const payload = path.join(settings.releaseRoot, input.releaseId, 'payload'),
      entry = `${payload}/node/bin/node ${payload}/dist/modules/chief-of-staff/ops/backup-schedule.js`;
    const units: BackupJobUnit[] = [];
    for (const job of ['capture', 'upload'] as const) {
      const name = 'nanoclaw-cos-backup-' + job;
      units.push(
        Object.freeze({
          name: name + '.service',
          contents: `[Unit]\nDescription=NanoClaw CoS ${job === 'capture' ? 'consistent local checkpoint' : 'independent encrypted backup upload'}\n\n[Service]\nType=oneshot\nWorkingDirectory=${settings.installationRoot}\nExecStart=/usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C TZ=Australia/Sydney ${entry} ${job} --settings ${input.settingsPath}\nTimeoutStartSec=${job === 'capture' ? '30min' : '50min'}\nTimeoutStopSec=10s\nKillMode=control-group\nLimitCORE=0\nMemorySwapMax=0\nUMask=0077\nStandardOutput=null\nStandardError=null\n`,
        }),
      );
      units.push(
        Object.freeze({
          name: name + '.timer',
          contents: `[Unit]\nDescription=NanoClaw CoS ${job === 'capture' ? '03:30 Sydney checkpoint' : 'hourly backup upload'}\n\n[Timer]\nOnCalendar=*-*-* ${job === 'capture' ? '03:30:00' : '*:00:00'} Australia/Sydney\nPersistent=true\nAccuracySec=1s\nRandomizedDelaySec=0\nUnit=${name}.service\n\n[Install]\nWantedBy=timers.target\n`,
        }),
      );
    }
    return Object.freeze(units);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Caller-selected paths and unit injection diagnostics remain private.
    throw Error('backup_job_units_unavailable');
  }
}
