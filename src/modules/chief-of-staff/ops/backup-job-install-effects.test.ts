import { afterEach, expect, it, vi } from 'vitest';
import type { DeploymentSettings } from './deployment-settings.js';
const f = vi.hoisted(() => {
  const exec = vi.fn();
  Object.defineProperty(exec, Symbol.for('nodejs.util.promisify.custom'), {
    value: (file: string, args: string[], options: Record<string, unknown>) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        exec(file, args, options, (error: Error | null, stdout: string, stderr: string) =>
          error ? reject(error) : resolve({ stdout, stderr }),
        );
      }),
  });
  return { exec };
});
vi.mock('node:child_process', () => ({ execFile: f.exec }));
import { createBackupJobManagerControls, backupJobManagerObservation } from './backup-job-install-effects.js';
afterEach(() => vi.resetAllMocks());
const settings = {
  userHome: '/home/pi',
  installationRoot: '/home/pi/app',
  stateRoot: '/home/pi/state',
} as DeploymentSettings;
const names = [
  'nanoclaw-cos-backup-capture.service',
  'nanoclaw-cos-backup-capture.timer',
  'nanoclaw-cos-backup-upload.service',
  'nanoclaw-cos-backup-upload.timer',
];
function observation(loaded = false) {
  return names
    .map(
      (name) =>
        `${name.endsWith('.service') ? 'MainPID=0\n' : ''}Id=${name}\nLoadState=${loaded ? 'loaded' : 'not-found'}\nActiveState=inactive\nSubState=dead\nFragmentPath=${loaded ? '/home/pi/.config/systemd/user/' + name : ''}\nDropInPaths=\nUnitFileState=${loaded ? 'disabled' : ''}\n`,
    )
    .join('\n');
}
it('reads the actual not-found Pi format, including timers without MainPID', () => {
  expect(backupJobManagerObservation(settings, observation())).toEqual({
    owned: true,
    jobsIdle: true,
    timersActive: false,
    timersRunning: false,
    definitionsLoaded: false,
  });
  expect(backupJobManagerObservation(settings, observation(true))).toEqual({
    owned: true,
    jobsIdle: true,
    timersActive: false,
    timersRunning: false,
    definitionsLoaded: true,
  });
});
it('refuses unknown names, duplicate fields, missing rows, foreign fragments and drop-ins', () => {
  for (const text of [
    observation().replace(names[0], 'foreign.service'),
    observation() + observation(),
    observation().split('\n\n').slice(1).join('\n\n'),
    observation().replace('LoadState=not-found', 'LoadState=not-found\nLoadState=loaded'),
  ])
    expect(() => backupJobManagerObservation(settings, text)).toThrow('backup_job_manager_unavailable');
  expect(
    backupJobManagerObservation(
      settings,
      observation(true).replace('/home/pi/.config/systemd/user/', '/etc/systemd/user/'),
    ).owned,
  ).toBe(false);
  expect(
    backupJobManagerObservation(settings, observation(true).replace('DropInPaths=', 'DropInPaths=/etc/foreign.conf'))
      .owned,
  ).toBe(false);
});
it('reports active backup jobs and requires both timers to be enabled and active', () => {
  expect(backupJobManagerObservation(settings, observation(true).replace('MainPID=0', 'MainPID=123')).jobsIdle).toBe(
    false,
  );
  const active = names
    .map(
      (name) =>
        `${name.endsWith('.service') ? 'MainPID=0\n' : ''}Id=${name}\nLoadState=loaded\nActiveState=${name.endsWith('.timer') ? 'active' : 'inactive'}\nSubState=${name.endsWith('.timer') ? 'waiting' : 'dead'}\nFragmentPath=/home/pi/.config/systemd/user/${name}\nDropInPaths=\nUnitFileState=enabled\n`,
    )
    .join('\n');
  expect(backupJobManagerObservation(settings, active).timersActive).toBe(true);
  const partial = active.replace('ActiveState=active', 'ActiveState=inactive');
  expect(backupJobManagerObservation(settings, partial)).toMatchObject({ timersActive: false, timersRunning: true });
  expect(
    backupJobManagerObservation(settings, active.replace('UnitFileState=enabled', 'UnitFileState=disabled')).owned,
  ).toBe(true);
});
it('uses only bounded fixed user-manager commands and an independent environment', async () => {
  f.exec.mockImplementation((_file, _args, _options, done) => {
    done(null, observation(), '');
    return {};
  });
  const current = vi.fn(async () => {}),
    controls = createBackupJobManagerControls(settings, current);
  await controls.inspectManager();
  await controls.stopTimers();
  await controls.reload();
  await controls.enableTimers();
  await controls.startTimers();
  const args = f.exec.mock.calls.map((call) => call[1]);
  expect(args.slice(1)).toEqual([
    ['--user', 'stop', names[1], names[3]],
    ['--user', 'daemon-reload'],
    ['--user', 'enable', '--no-reload', names[1], names[3]],
    ['--user', 'start', names[1], names[3]],
  ]);
  for (const [file, _args, options] of f.exec.mock.calls) {
    expect(file).toBe('/usr/bin/systemctl');
    expect(options.timeout).toBe(30000);
    expect(options.maxBuffer).toBe(16384);
    expect(Object.keys(options.env).sort()).toEqual([
      'DBUS_SESSION_BUS_ADDRESS',
      'HOME',
      'LANG',
      'LC_ALL',
      'PATH',
      'XDG_RUNTIME_DIR',
    ]);
  }
  expect(current).toHaveBeenCalledTimes(10);
});
it('rejects arbitrary compiler file selections and hides manager errors', async () => {
  f.exec.mockImplementation((_file, _args, _options, done) => {
    done(Error('PRIVATE_MANAGER_ERROR'));
    return {};
  });
  const controls = createBackupJobManagerControls(settings, async () => {});
  await expect(controls.compile(['/etc/foreign.service'])).rejects.toThrow('backup_job_manager_unavailable');
  expect(f.exec).not.toHaveBeenCalled();
  await expect(controls.reload()).rejects.toThrow(/^backup_job_manager_unavailable$/);
});
