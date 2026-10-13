import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DeploymentSettings } from './deployment-settings.js';
import type { BackupJobInstallControls, BackupJobManager } from './backup-job-install.js';
const execute = promisify(execFile);
export const backupJobNames = Object.freeze([
  'nanoclaw-cos-backup-capture.service',
  'nanoclaw-cos-backup-capture.timer',
  'nanoclaw-cos-backup-upload.service',
  'nanoclaw-cos-backup-upload.timer',
]);
const timers = backupJobNames.filter((name) => name.endsWith('.timer'));
/** Readonly fixed-unit observations. Missing units are acceptable only as
 * absence; loaded definitions must have the exact owned fragment and no overrides. */
export function backupJobManagerObservation(
  settings: Pick<DeploymentSettings, 'userHome'>,
  text: string,
): BackupJobManager {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 16384) throw Error('invalid_manager_observation');
    const sections = text.trim().split(/\n\s*\n/),
      rows = new Map<string, Record<string, string>>();
    if (sections.length !== 4) throw Error('invalid_manager_observation');
    const allowed = [
      'Id',
      'LoadState',
      'ActiveState',
      'SubState',
      'MainPID',
      'FragmentPath',
      'DropInPaths',
      'UnitFileState',
    ];
    for (const section of sections) {
      const row: Record<string, string> = {};
      for (const line of section.split('\n')) {
        const match = /^([A-Za-z]+)=(.*)$/.exec(line);
        if (!match || !allowed.includes(match[1]) || Object.hasOwn(row, match[1]) || match[2].length > 2048)
          throw Error('invalid_manager_observation');
        row[match[1]] = match[2];
      }
      if (
        !backupJobNames.includes(row.Id) ||
        rows.has(row.Id) ||
        allowed.filter((key) => key !== 'MainPID').some((key) => !Object.hasOwn(row, key)) ||
        (row.Id.endsWith('.service') && !/^(0|[1-9][0-9]{0,9})$/.test(row.MainPID ?? '')) ||
        (row.Id.endsWith('.timer') && row.MainPID !== undefined && row.MainPID !== '0') ||
        !['loaded', 'not-found'].includes(row.LoadState) ||
        !['inactive', 'active', 'failed', 'activating', 'deactivating', 'reloading'].includes(row.ActiveState)
      )
        throw Error('invalid_manager_observation');
      rows.set(row.Id, row);
    }
    const values = [...rows.values()];
    const owned = values.every(
      (row) =>
        row.DropInPaths === '' &&
        (row.LoadState === 'not-found'
          ? row.FragmentPath === '' && row.UnitFileState === '' && row.ActiveState === 'inactive'
          : row.FragmentPath === path.join(settings.userHome, '.config/systemd/user', row.Id) &&
            ['enabled', 'disabled', 'static', 'linked', 'linked-runtime'].includes(row.UnitFileState)),
    );
    return {
      owned,
      jobsIdle: values
        .filter((row) => row.Id.endsWith('.service'))
        .every((row) => row.MainPID === '0' && ['inactive', 'failed'].includes(row.ActiveState)),
      timersActive: timers.every((name) => {
        const row = rows.get(name)!;
        return (
          row.LoadState === 'loaded' &&
          row.UnitFileState === 'enabled' &&
          row.ActiveState === 'active' &&
          ['waiting', 'elapsed'].includes(row.SubState)
        );
      }),
      timersRunning: timers.some((name) => !['inactive', 'failed'].includes(rows.get(name)!.ActiveState)),
      definitionsLoaded: values.every((row) => row.LoadState === 'loaded'),
    };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private manager paths and diagnostics are not installation output.
    throw Error('backup_job_manager_unavailable');
  }
}
/** Fixed owner-manager operations, with no native service, root manager,
 * arbitrary units, inherited credential environment or caller-selected command. */
export function createBackupJobManagerControls(
  settings: DeploymentSettings,
  assertCurrent: () => Promise<void>,
): BackupJobInstallControls {
  const uid = process.getuid?.();
  if (!uid) throw Error('backup_job_manager_unavailable');
  const env = {
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    HOME: settings.userHome,
    XDG_RUNTIME_DIR: '/run/user/' + uid,
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/' + uid + '/bus',
  };
  const run = async (file: string, args: string[]) => {
    try {
      await assertCurrent();
      const { stdout } = await execute(file, args, {
        cwd: settings.installationRoot,
        env,
        timeout: 30000,
        maxBuffer: 16384,
      });
      await assertCurrent();
      return stdout;
    } catch {
      // eslint-disable-next-line preserve-caught-error -- No private command output or system-manager errors leave this trusted adapter.
      throw Error('backup_job_manager_unavailable');
    }
  };
  const fixed = (args: string[]) => async () => {
    await run('/usr/bin/systemctl', ['--user', ...args]);
  };
  return {
    assertCurrent,
    inspectManager: async () =>
      backupJobManagerObservation(
        settings,
        await run('/usr/bin/systemctl', [
          '--user',
          'show',
          ...backupJobNames,
          '--property=Id,LoadState,ActiveState,SubState,MainPID,FragmentPath,DropInPaths,UnitFileState',
        ]),
      ),
    async compile(files) {
      const expected = backupJobNames.map((name) => path.join(settings.userHome, '.config/systemd/user', name));
      if (!Array.isArray(files) || JSON.stringify(files) !== JSON.stringify(expected))
        throw Error('backup_job_manager_unavailable');
      await run('/usr/bin/systemd-analyze', ['--user', 'verify', '--man=no', ...expected]);
    },
    stopTimers: fixed(['stop', ...timers]),
    reload: fixed(['daemon-reload']),
    enableTimers: fixed(['enable', '--no-reload', ...timers]),
    startTimers: fixed(['start', ...timers]),
  };
}
