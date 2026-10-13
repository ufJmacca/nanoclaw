import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { digest } from '../domain/contracts.js';
import { initializeTarget, protectTarget, readTarget, writeAtomic } from './target-state.js';
import { withDeploymentLock } from './deployment-lock.js';
import { initializeBackupJob, type BackupInitializationEffects } from './backup-initialize-job.js';
import { initializeBackupRepair } from './backup-initialization-repair.js';
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-init-job-'));
  temporary.push(base);
  fs.chmodSync(base, 0o700);
  const root = base + '/state',
    manifest = fixtureVaultRelease('G02'),
    requestId = randomUUID();
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    installationRoot: base + '/app',
    dataRoot: base + '/app/data',
  };
  const initial = initializeTarget(root, binding);
  writeAtomic(root, 'state.json', { ...initial, releaseId: manifest.releaseId, maintenance: false });
  const protectedState = protectTarget(root, binding);
  writeAtomic(root, 'maintenance.json', {
    version: 1,
    bindingDigest: digest(binding),
    nonce: randomUUID(),
    owner: 'fixture',
    purpose: 'deployment',
    generation: protectedState.generation,
    phase: 'complete',
    reopen: true,
  });
  writeAtomic(root, 'state.json', {
    ...protectedState,
    maintenance: false,
    maintenanceHistory: true,
    generation: protectedState.generation + 1,
  });
  const effects = {
    verify: vi.fn(async () => manifest),
    healthy: vi.fn(async () => true),
    mount: vi.fn<BackupInitializationEffects['mount']>(async (guard) => guard()),
    initialize: vi.fn<BackupInitializationEffects['initialize']>(async (_manifest, id, guard, check) => {
      guard();
      await check();
      return {
        contract: 'cos-backup-repository-initialization-result/v1',
        status: 'backup_repository_initialized',
        operationId: id,
        bindingDigest: 'd'.repeat(64),
        repositoryId: 'e'.repeat(64),
        repositoryVersion: 2,
      };
    }),
  };
  return { root, binding, requestId, effects, manifest };
}
it('initializes while a checkpoint lock is held and preserves target admission and owner state', async () => {
  const f = fixture(),
    before = fs.readFileSync(f.root + '/state.json'),
    maintenance = fs.readFileSync(f.root + '/maintenance.json');
  const result = await withDeploymentLock(f.root + '.operation.lock', () => initializeBackupJob(f));
  expect(result.status).toBe('backup_repository_initialized');
  expect(f.effects.mount).toHaveBeenCalledOnce();
  expect(f.effects.initialize).toHaveBeenCalledOnce();
  expect(fs.readFileSync(f.root + '/state.json')).toEqual(before);
  expect(fs.readFileSync(f.root + '/maintenance.json')).toEqual(maintenance);
});
it('shares the upload and retention lock and refuses another initializer while it is held', async () => {
  const f = fixture();
  await withDeploymentLock(f.root + '.backup-upload.lock', async () => {
    await expect(initializeBackupJob(f)).rejects.toThrow('backup_initialization_locked');
    expect(f.effects.mount).not.toHaveBeenCalled();
    expect(f.effects.initialize).not.toHaveBeenCalled();
  });
  expect((await initializeBackupJob(f)).status).toBe('backup_repository_initialized');
});
it.each(['unhealthy', 'maintenance', 'wrong-release', 'unprotected', 'unverified-manifest'] as const)(
  'refuses %s before mounting or creating NAS data',
  async (reason) => {
    const f = fixture(),
      state = readTarget(f.root, f.binding);
    if (reason === 'unhealthy') f.effects.healthy.mockResolvedValue(false);
    if (reason === 'maintenance')
      writeAtomic(f.root, 'state.json', { ...state, maintenance: true, maintenanceId: randomUUID() });
    if (reason === 'wrong-release') writeAtomic(f.root, 'state.json', { ...state, releaseId: 'release-foreign' });
    if (reason === 'unprotected') writeAtomic(f.root, 'state.json', { ...state, lifecycle: 'unbound' });
    if (reason === 'unverified-manifest')
      f.effects.verify.mockResolvedValue({
        ...f.manifest,
        checks: { ...f.manifest.checks, backup_mount: { ...f.manifest.checks.backup_mount, status: 'failed' } },
      } as never);
    await expect(initializeBackupJob(f)).rejects.toThrow('backup_repository_initialization_unavailable');
    expect(f.effects.mount).not.toHaveBeenCalled();
    expect(f.effects.initialize).not.toHaveBeenCalled();
  },
);
it('withdrawn admission during the NAS wait cannot create a repository', async () => {
  const f = fixture();
  f.effects.mount.mockImplementation(async () => {
    const state = readTarget(f.root, f.binding);
    writeAtomic(f.root, 'state.json', { ...state, generation: state.generation + 1 });
  });
  await expect(initializeBackupJob(f)).rejects.toThrow('backup_repository_initialization_unavailable');
  expect(f.effects.initialize).not.toHaveBeenCalled();
});
it('an invalid repository acknowledgement cannot be reported as successful initialization', async () => {
  const f = fixture();
  f.effects.initialize.mockResolvedValue({ status: 'backup_repository_initialized' });
  await expect(initializeBackupJob(f)).rejects.toThrow('backup_repository_initialization_unavailable');
});

it('repairs initialization with separate helper provenance while preserving admission and an occupied checkpoint', async () => {
  const f = fixture(),
    helper = fixtureVaultRelease('G02');
  helper.releaseId = 'release-repair';
  helper.source = { ...helper.source, commit: '2'.repeat(40), tree: '3'.repeat(40) };
  const repairSeal = {
    ...helper.vaultArtifact!.seal,
    sourceCommit: helper.source.commit,
    sourceTree: helper.source.tree,
  };
  helper.vaultArtifact = { digest: digest(repairSeal), seal: repairSeal };
  for (const check of Object.values(helper.checks)) check.sourceCommit = helper.source.commit;
  helper.previousReleaseIds = [f.manifest.releaseId];
  const before = fs.readFileSync(f.root + '/state.json');
  writeAtomic(f.root, 'pending-checkpoint.json', { operationId: 'retained', bytes: 2121728 });
  const pending = fs.readFileSync(f.root + '/pending-checkpoint.json'),
    effects = { ...f.effects, verifyRepair: vi.fn(async () => ({ runtime: f.manifest, helper })) };
  const result = await initializeBackupRepair({ ...f, effects });
  expect(result.status).toBe('backup_repository_initialized');
  expect(result.releaseId).toBe(f.manifest.releaseId);
  expect(result.runtimeSource).toEqual(f.manifest.source);
  expect(result.helperSource).toEqual(helper.source);
  expect(result.helperReleaseId).toBe(helper.releaseId);
  expect(result.activation).toBe('not_performed');
  expect(fs.readFileSync(f.root + '/state.json')).toEqual(before);
  expect(fs.readFileSync(f.root + '/pending-checkpoint.json')).toEqual(pending);
  expect(f.effects.initialize).toHaveBeenCalledOnce();
});
it('cannot initialize when the staged repair proof changes during the NAS mount wait', async () => {
  const f = fixture(),
    helper = fixtureVaultRelease('G02');
  helper.releaseId = 'release-repair';
  helper.source = { ...helper.source, commit: '2'.repeat(40), tree: '3'.repeat(40) };
  const repairSeal = {
    ...helper.vaultArtifact!.seal,
    sourceCommit: helper.source.commit,
    sourceTree: helper.source.tree,
  };
  helper.vaultArtifact = { digest: digest(repairSeal), seal: repairSeal };
  for (const check of Object.values(helper.checks)) check.sourceCommit = helper.source.commit;
  helper.previousReleaseIds = [f.manifest.releaseId];
  const effects = { ...f.effects, verifyRepair: vi.fn(async () => ({ runtime: f.manifest, helper })) };
  f.effects.mount.mockImplementation(async () => {
    effects.verifyRepair.mockResolvedValue({
      runtime: f.manifest,
      helper: { ...helper, releaseId: 'release-replacement' },
    });
  });
  await expect(initializeBackupRepair({ ...f, effects })).rejects.toThrow('backup_initialization_repair_unavailable');
  expect(f.effects.initialize).not.toHaveBeenCalled();
});
