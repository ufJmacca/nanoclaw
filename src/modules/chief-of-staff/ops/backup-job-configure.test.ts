import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { digest } from '../domain/contracts.js';
import { initializeTarget, protectTarget, readTarget, writeAtomic } from './target-state.js';
import { withDeploymentLock } from './deployment-lock.js';
const f = vi.hoisted(() => ({
  memory: vi.fn(),
  paths: vi.fn(),
  verify: vi.fn(),
  healthy: vi.fn(),
  installer: vi.fn(),
  manager: vi.fn(),
  install: vi.fn(),
  activate: vi.fn(),
}));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: f.memory }));
vi.mock('./target-host.js', async (original) => ({
  ...(await original<typeof import('./target-host.js')>()),
  verifyTargetPaths: f.paths,
}));
vi.mock('./operations-maintenance-effects.js', () => ({
  createScheduledMaintenanceEffects: () => ({ verify: f.verify, healthy: f.healthy }),
}));
vi.mock('./backup-job-install.js', () => ({ createBackupJobInstaller: f.installer }));
vi.mock('./backup-job-install-effects.js', () => ({ createBackupJobManagerControls: f.manager }));
import { configureTargetBackupJobs } from './backup-job-configure.js';
const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(slice: 'G02' | 'G03' | 'G04' | 'G05' = 'G02') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-job-configure-'));
  roots.push(home);
  fs.chmodSync(home, 0o700);
  const settings = {
    version: 1 as const,
    target: 'pi' as const,
    sshAlias: 'fixture',
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    userHome: home,
    installationRoot: home + '/app',
    dataRoot: home + '/app/data',
    stateRoot: home + '/state',
    releaseRoot: home + '/releases',
    stagingRoot: home + '/staging',
    sourceRoot: home + '/sources',
    runtimeEnvironment: home + '/.config/runtime',
    migrationEnvironment: home + '/.config/migration',
  };
  const binding = {
      hostFingerprint: settings.hostFingerprint,
      databaseFingerprint: settings.databaseFingerprint,
      service: settings.service,
      installationRoot: settings.installationRoot,
      dataRoot: settings.dataRoot,
    },
    manifest = fixtureVaultRelease(slice);
  const initial = initializeTarget(settings.stateRoot, binding);
  writeAtomic(settings.stateRoot, 'state.json', { ...initial, releaseId: manifest.releaseId, maintenance: false });
  const state = protectTarget(settings.stateRoot, binding);
  writeAtomic(settings.stateRoot, 'maintenance.json', {
    version: 1,
    bindingDigest: digest(binding),
    nonce: randomUUID(),
    owner: 'fixture-release',
    purpose: 'deployment',
    generation: state.generation,
    phase: 'complete',
    reopen: true,
  });
  writeAtomic(settings.stateRoot, 'state.json', {
    ...state,
    maintenance: false,
    maintenanceHistory: true,
    generation: state.generation + 1,
  });
  f.verify.mockResolvedValue(manifest);
  f.healthy.mockResolvedValue(true);
  f.manager.mockImplementation((_settings, assertCurrent) => ({ assertCurrent }));
  f.installer.mockReturnValue({ install: f.install, activate: f.activate });
  f.activate.mockResolvedValue({ status: 'backup_jobs_active' });
  return {
    settings,
    manifest,
    binding,
    invoke: () => configureTargetBackupJobs(settings, '/fixture/target-helper.js'),
  };
}
it.each(['G02', 'G03', 'G04', 'G05'] as const)(
  '%s holds real operation/job locks during publication and releases them before activation',
  async (slice) => {
    const fxt = fixture(slice),
      root = fxt.settings.stateRoot;
    f.install.mockImplementation(async () => {
      for (const suffix of ['.operation.lock', '.backup-schedule.lock', '.backup-upload.lock'])
        await expect(withDeploymentLock(root + suffix, async () => {})).rejects.toThrow('target_deployment_locked');
    });
    f.activate.mockImplementation(async () => {
      for (const suffix of ['.operation.lock', '.backup-schedule.lock', '.backup-upload.lock'])
        await expect(withDeploymentLock(root + suffix, async () => 42)).resolves.toBe(42);
      return { status: 'backup_jobs_active' };
    });
    await expect(fxt.invoke()).resolves.toMatchObject({ status: 'backup_jobs_active' });
    expect(f.memory).toHaveBeenCalled();
    expect(f.paths).toHaveBeenCalledWith(fxt.settings, 0);
  },
);
it('never waits behind a running uploader or publishes while a schedule owns its lock', async () => {
  const fxt = fixture();
  for (const suffix of ['.backup-upload.lock', '.backup-schedule.lock'])
    await withDeploymentLock(fxt.settings.stateRoot + suffix, async () => {
      await expect(fxt.invoke()).rejects.toThrow('backup_job_installation_busy');
    });
  expect(f.install).not.toHaveBeenCalled();
  expect(f.activate).not.toHaveBeenCalled();
});
it.each(['G01', 'unhealthy', 'memory', 'maintenance', 'changed'] as const)(
  'refuses %s without activation or new authority',
  async (reason) => {
    const fxt = fixture();
    if (reason === 'G01') f.verify.mockResolvedValue(fixtureVaultRelease('G01'));
    if (reason === 'unhealthy') f.healthy.mockResolvedValue(false);
    if (reason === 'memory')
      f.memory.mockImplementation(() => {
        throw Error('unprotected');
      });
    if (reason === 'maintenance')
      writeAtomic(fxt.settings.stateRoot, 'state.json', {
        ...readTarget(fxt.settings.stateRoot, fxt.binding),
        maintenance: true,
      });
    if (reason === 'changed')
      f.install.mockImplementation(async () => {
        writeAtomic(fxt.settings.stateRoot, 'state.json', {
          ...readTarget(fxt.settings.stateRoot, fxt.binding),
          releaseId: 'release-other',
        });
      });
    await expect(fxt.invoke()).rejects.toThrow('backup_job_installation_unavailable');
    expect(f.activate).not.toHaveBeenCalled();
  },
);
