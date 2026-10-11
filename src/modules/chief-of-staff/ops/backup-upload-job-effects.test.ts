import { afterEach, expect, it, vi } from 'vitest';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import type { DeploymentSettings } from './deployment-settings.js';
const f = vi.hoisted(() => ({
  memory: vi.fn(),
  verify: vi.fn(),
  healthy: vi.fn(),
  inspect: vi.fn(),
  reconcile: vi.fn(),
  paths: vi.fn(),
  upload: vi.fn(),
  exec: vi.fn(),
}));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: f.memory }));
vi.mock('./operations-maintenance-effects.js', () => ({
  createScheduledMaintenanceEffects: () => ({ verify: f.verify, healthy: f.healthy }),
}));
vi.mock('./backup-queue.js', () => ({
  createVaultBackupQueue: () => ({ inspectDelivery: f.inspect, reconcileIncompleteCapture: f.reconcile }),
}));
vi.mock('./target-host.js', () => ({ verifyTargetPaths: f.paths }));
vi.mock('./backup-upload.js', () => ({ uploadVaultBackup: f.upload }));
vi.mock('node:child_process', () => ({ execFile: f.exec }));
import { createBackupUploadJobEffects } from './backup-upload-job-effects.js';
afterEach(() => vi.resetAllMocks());
const settings = {
  stateRoot: '/home/pi/state',
  installationRoot: '/home/pi/app',
  dataRoot: '/home/pi/app/data',
} as DeploymentSettings;
function fixture() {
  f.exec.mockImplementation((_file, _args, _options, done) => {
    done(null, '', '');
    return {};
  });
  f.verify.mockResolvedValue(fixtureVaultRelease('G02'));
  f.healthy.mockResolvedValue(true);
  f.inspect.mockResolvedValue({ items: [], lastRemoteCheckpointAt: null });
  return createBackupUploadJobEffects(settings, '/fixture/target-helper.js');
}
it('uses guarded local recovery without invoking the NAS or a credential producer', async () => {
  const effects = fixture(),
    guard = vi.fn();
  f.reconcile.mockImplementation(async (_kind, assertCurrent) => {
    assertCurrent();
    assertCurrent();
  });
  await effects.reconcile('credentials', guard);
  expect(f.reconcile).toHaveBeenCalledWith('credentials', expect.any(Function));
  expect(guard).toHaveBeenCalledTimes(4);
  expect(f.memory).toHaveBeenCalledTimes(4);
  expect(f.paths).toHaveBeenCalledWith(settings, 0);
  expect(f.exec).not.toHaveBeenCalled();
  expect(f.upload).not.toHaveBeenCalled();
});
it('uses only the fixed root mount service with bounded private output and an independent environment', async () => {
  const effects = fixture(),
    guard = vi.fn();
  await effects.mount(guard);
  const [file, args, options] = f.exec.mock.calls[0];
  expect(file).toBe('/usr/bin/sudo');
  expect(args).toEqual(['-n', '/usr/bin/systemctl', 'start', 'nanoclaw-cos-backup-mount.service']);
  expect(options).toMatchObject({
    cwd: '/',
    timeout: 35000,
    maxBuffer: 4096,
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  expect(Object.keys(options.env).sort()).toEqual(['LANG', 'LC_ALL', 'PATH']);
  expect(guard).toHaveBeenCalledTimes(2);
  expect(f.memory).toHaveBeenCalledTimes(2);
});
it('refuses a closed caller before starting root work and after an awaited mount', async () => {
  const effects = fixture();
  await expect(
    effects.mount(() => {
      throw Error('closed');
    }),
  ).rejects.toThrow('backup_upload_mount_unavailable');
  expect(f.exec).not.toHaveBeenCalled();
  let closed = false;
  f.exec.mockImplementation((_file, _args, _options, done) => {
    closed = true;
    done(null, '', '');
    return {};
  });
  await expect(
    effects.mount(() => {
      if (closed) throw Error('closed');
    }),
  ).rejects.toThrow('backup_upload_mount_unavailable');
});
it('redacts mount diagnostics and never falls back to another mount or initialization', async () => {
  const effects = fixture();
  f.exec.mockImplementation((_file, _args, _options, done) => {
    done(Error('PRIVATE_CREDENTIAL'));
    return {};
  });
  await expect(effects.mount(() => {})).rejects.toThrow(/^backup_upload_mount_unavailable$/);
  expect(f.exec).toHaveBeenCalledOnce();
});
it('uses the actual local queue and forwards the caller guard into the trusted uploader', async () => {
  const effects = fixture(),
    guard = vi.fn(),
    id = '01234567-89ab-4def-8123-456789abcdef';
  await effects.verify();
  await effects.healthy();
  await effects.inspect('credentials');
  await effects.upload('credentials', id, guard);
  expect(f.inspect).toHaveBeenCalledWith('credentials');
  expect(f.upload).toHaveBeenCalledWith(
    { targetRoot: settings.stateRoot, installationRoot: settings.installationRoot, dataRoot: settings.dataRoot },
    'credentials',
    id,
    guard,
  );
  expect(f.verify).toHaveBeenCalledOnce();
  expect(f.healthy).toHaveBeenCalledOnce();
});
