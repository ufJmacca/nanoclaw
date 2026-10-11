import { afterEach, expect, it, vi } from 'vitest';
import type { DeploymentSettings } from './deployment-settings.js';
const f = vi.hoisted(() => ({
  settings: vi.fn(),
  paths: vi.fn(),
  binding: vi.fn(),
  service: vi.fn(),
  job: vi.fn(),
  target: vi.fn(),
  exec: vi.fn(),
  memory: vi.fn(),
}));
vi.mock('./target-state.js', () => ({ readPrivate: f.settings }));
vi.mock('./target-host.js', () => ({ verifyTargetPaths: f.paths, targetBinding: f.binding }));
vi.mock('./operations-maintenance-effects.js', () => ({ createScheduledMaintenanceEffects: f.service }));
vi.mock('./backup-scheduled-job.js', () => ({ scheduledBackupJob: f.job }));
vi.mock('./target-helper.js', () => ({ targetCommand: f.target }));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: f.memory }));
vi.mock('node:child_process', () => ({ execFile: f.exec }));
import { backupScheduleCommand, parseBackupScheduleArguments } from './backup-schedule.js';
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
const settings: DeploymentSettings = {
  version: 1,
  target: 'pi',
  sshAlias: 'fixture',
  hostFingerprint: 'a'.repeat(64),
  databaseFingerprint: 'b'.repeat(64),
  service: 'fixture.service',
  userHome: '/home/pi',
  installationRoot: '/home/pi/app',
  dataRoot: '/home/pi/app/data',
  stateRoot: '/home/pi/state',
  releaseRoot: '/home/pi/releases',
  stagingRoot: '/home/pi/staging',
  sourceRoot: '/home/pi/sources',
  runtimeEnvironment: '/home/pi/.config/runtime',
  migrationEnvironment: '/home/pi/.config/migration',
};
it('admits only fixed capture/upload modes and one canonical settings path', () => {
  for (const job of ['capture', 'upload'])
    expect(parseBackupScheduleArguments([job, '--settings', '/home/pi/.config/target.json'])).toEqual({
      job,
      settings: '/home/pi/.config/target.json',
    });
  for (const args of [
    ['repair', '--settings', '/home/pi/target'],
    ['capture', '--settings', '/home/pi/../target'],
    ['upload', '--settings', '/home/pi/target', '--request-id', 'latest'],
    ['capture', '--password', 'private'],
    ['upload', '--settings', '/home/pi/target\n'],
  ])
    expect(() => parseBackupScheduleArguments(args)).toThrow('invalid_backup_schedule_arguments');
});
function fixture() {
  const cwd = vi.spyOn(process, 'chdir').mockImplementation(() => {});
  f.settings.mockReturnValue(settings);
  f.binding.mockReturnValue({ fixture: true });
  const verify = vi.fn(),
    healthy = vi.fn();
  f.service.mockReturnValue({ verify, healthy });
  f.exec.mockImplementation((_file, _args, _options, done) => {
    done(null, '', '');
    return {};
  });
  f.job.mockImplementation(async ({ effects }) => {
    await effects.verify();
    await effects.healthy();
    return { status: 'fixture' };
  });
  return { cwd, verify, healthy };
}
it('fixes cwd and target paths, checks memory, and exposes only the installed checkpoint/upload ports', async () => {
  const s = fixture();
  await backupScheduleCommand(['capture', '--settings', '/home/pi/.config/target.json']);
  expect(s.cwd).toHaveBeenCalledWith(settings.installationRoot);
  expect(f.paths).toHaveBeenCalledWith(settings, 0);
  expect(f.memory).toHaveBeenCalled();
  expect(s.verify).toHaveBeenCalledOnce();
  expect(s.healthy).toHaveBeenCalledOnce();
  const ports = f.job.mock.calls[0][0].effects,
    id = '01234567-89ab-4def-8123-456789abcdef';
  await ports.capture(id);
  await ports.upload(id);
  expect(f.target.mock.calls.map(([args]) => args)).toEqual([
    ['scheduled-backup', '--settings', '/home/pi/.config/target.json', '--request-id', id],
    ['upload-backups', '--settings', '/home/pi/.config/target.json', '--request-id', id],
  ]);
  expect(Object.keys(ports).sort()).toEqual(['capture', 'dispatchUpload', 'healthy', 'upload', 'verify']);
});
it('dispatches only the fixed user upload unit, without waiting for the NAS or inheriting credential environment', async () => {
  fixture();
  await backupScheduleCommand(['capture', '--settings', '/home/pi/.config/target.json']);
  await f.job.mock.calls[0][0].effects.dispatchUpload();
  const [file, args, options] = f.exec.mock.calls[0];
  expect(file).toBe('/usr/bin/systemctl');
  expect(args).toEqual(['--user', 'start', '--no-block', 'nanoclaw-cos-backup-upload.service']);
  expect(options.timeout).toBe(5000);
  expect(options.maxBuffer).toBe(4096);
  expect(Object.keys(options.env).sort()).toEqual([
    'DBUS_SESSION_BUS_ADDRESS',
    'HOME',
    'LANG',
    'LC_ALL',
    'PATH',
    'XDG_RUNTIME_DIR',
  ]);
  expect(options.env.XDG_RUNTIME_DIR).toBe('/run/user/' + process.getuid?.());
});
it('refuses unprotected memory before starting any scheduled job', async () => {
  fixture();
  f.memory.mockImplementation(() => {
    throw Error('vault_memory_unprotected');
  });
  await expect(backupScheduleCommand(['upload', '--settings', '/home/pi/.config/target.json'])).rejects.toThrow(
    'vault_memory_unprotected',
  );
  expect(f.job).not.toHaveBeenCalled();
  expect(f.exec).not.toHaveBeenCalled();
});
