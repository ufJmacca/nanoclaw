import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { digest } from '../domain/contracts.js';
import { initializeTarget, protectTarget, readTarget, writeAtomic } from './target-state.js';
import { withDeploymentLock } from './deployment-lock.js';
import { BackupQueue } from './backup-queue.js';
const f = vi.hoisted(() => ({ memory: vi.fn(), paths: vi.fn(), verify: vi.fn(), healthy: vi.fn(), queue: vi.fn() }));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: f.memory }));
vi.mock('./target-host.js', async (original) => ({
  ...(await original<typeof import('./target-host.js')>()),
  verifyTargetPaths: f.paths,
}));
vi.mock('./operations-maintenance-effects.js', () => ({
  createScheduledMaintenanceEffects: () => ({ verify: f.verify, healthy: f.healthy }),
}));
vi.mock('./backup-queue.js', async (original) => ({
  ...(await original<typeof import('./backup-queue.js')>()),
  createVaultBackupQueue: f.queue,
}));
import { reconcileTargetBackupCapture } from './backup-capture-reconcile.js';
const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture(slice: 'G02' | 'G03' | 'G04' | 'G05' | 'G06' = 'G02') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-capture-command-'));
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
    },
    binding = {
      hostFingerprint: settings.hostFingerprint,
      databaseFingerprint: settings.databaseFingerprint,
      service: settings.service,
      installationRoot: settings.installationRoot,
      dataRoot: settings.dataRoot,
    },
    manifest = fixtureVaultRelease(slice),
    id = randomUUID();
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
  fs.mkdirSync(home + '/vault', { mode: 0o700 });
  const queue = new BackupQueue('a'.repeat(64), async (_, operation) => operation(home + '/vault'));
  await expect(
    queue.capture(
      'state',
      id,
      async (sink) => {
        sink.write('fixture.json', Buffer.from('SYNTHETIC'));
        throw Error('capture failed');
      },
      65536,
    ),
  ).rejects.toThrow('backup_queue_unavailable');
  f.queue.mockReturnValue(queue);
  f.verify.mockResolvedValue(manifest);
  f.healthy.mockResolvedValue(true);
  return {
    settings,
    binding,
    manifest,
    queue,
    id,
    slot: home + '/vault/backup-queue/full',
    invoke: () => reconcileTargetBackupCapture(settings, '/fixture/target-helper.js', 'state', id),
  };
}
it.each(['G02', 'G03', 'G04', 'G05', 'G06'] as const)(
  '%s owner command retires a known incomplete copy under current admission and supports stable replay',
  async (slice) => {
    const x = await fixture(slice);
    expect(await x.invoke()).toEqual({
      status: 'capture_retired',
      kind: 'state',
      operationId: x.id,
      releaseId: x.manifest.releaseId,
    });
    expect(fs.existsSync(x.slot)).toBe(false);
    expect(await x.invoke()).toMatchObject({ status: 'capture_retired' });
    expect(f.paths).toHaveBeenCalledWith(x.settings, 0);
    expect(f.healthy).toHaveBeenCalled();
  },
);
it('the owner command does not steal the operation lock', async () => {
  const x = await fixture();
  await withDeploymentLock(x.settings.stateRoot + '.operation.lock', async () => {
    await expect(x.invoke()).rejects.toThrow('backup_capture_recovery_busy');
  });
  expect(fs.existsSync(x.slot + '/data/fixture.json')).toBe(true);
});
it.each(['G01', 'unhealthy', 'memory', 'maintenance', 'changed-after-verify', 'changed-copy'] as const)(
  'preserves a copy when %s prevents recovery',
  async (reason) => {
    const x = await fixture();
    if (reason === 'G01') f.verify.mockResolvedValue(fixtureVaultRelease('G01'));
    if (reason === 'unhealthy') f.healthy.mockResolvedValue(false);
    if (reason === 'memory')
      f.memory.mockImplementation(() => {
        throw Error('PRIVATE_MEMORY_FAILURE');
      });
    const close = () =>
      writeAtomic(x.settings.stateRoot, 'state.json', {
        ...readTarget(x.settings.stateRoot, x.binding),
        maintenance: true,
      });
    if (reason === 'maintenance') close();
    if (reason === 'changed-after-verify')
      f.verify.mockImplementationOnce(async () => {
        close();
        return x.manifest;
      });
    if (reason === 'changed-copy') fs.writeFileSync(x.slot + '/data/fixture.json', 'CHANGED');
    await expect(x.invoke()).rejects.toThrow(/^backup_capture_recovery_unavailable$/);
    expect(fs.existsSync(x.slot + '/data/fixture.json')).toBe(true);
  },
);
