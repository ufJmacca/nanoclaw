import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { fixtureRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { digest } from '../domain/contracts.js';
import { deployRelease, type DeploymentEffects } from './deployment.js';
import { initializeTarget, readTarget, protectTarget, readPrivate } from './target-state.js';
import { admittedGeneration, beginMaintenance } from './maintenance.js';
import { protectCompletedProgramme, type ProgrammeProtection } from './programme-protection.js';
import type { OperationsMaintenanceEffects } from './operations-maintenance.js';
import { completeProtectedRelease } from './protected-release.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-protected-release-'));
  roots.push(parent);
  const root = path.join(parent, 'state');
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    installationRoot: '/fixture/app',
    dataRoot: '/fixture/app/data',
  };
  const manifest = fixtureRelease('S11');
  initializeTarget(root, binding);
  const deployment: DeploymentEffects = {
    verify: vi.fn(async () => {}),
    source: vi.fn(async () => {}),
    artifacts: vi.fn(async () => {}),
    quiesce: vi.fn(async () => ({ activeCoordinators: 0, activeDatabaseOperations: 0 })),
    backup: vi.fn(async () => {}),
    migrate: vi.fn(async () => {}),
    activate: vi.fn(async () => {}),
    health: vi.fn(async () => true),
    reconcile: vi.fn(async () => 'retry_safe' as const),
    rollback: vi.fn(async () => false),
  };
  await deployRelease({ root, binding, manifest, effects: deployment });
  const proof: ProgrammeProtection = {
    format: 'cos-programme-protection/v1',
    bindingDigest: digest(binding),
    releaseManifest: manifest,
    reviews: Array.from({ length: 11 }, (_, n) => ({
      url: 'https://github.com/ufJmacca/nanoclaw/pull/' + (54 + n),
      commit: n === 10 ? manifest.source.commit : digest('slice-' + n).slice(0, 40),
      slices: ['S' + String(n + 1).padStart(2, '0')],
      alignments: n === 0 ? ['S01-codex-subscription-runtime'] : [],
      mergedAt: '2026-10-06T00:00:00Z',
      mergedBy: 'fixture-owner',
      ancestorOf: manifest.source.commit,
    })),
  };
  let stopped = false;
  const effects: OperationsMaintenanceEffects = {
    verify: vi.fn(async () => manifest),
    workersIdle: vi.fn(async () => true),
    stopNative: vi.fn(async () => {
      stopped = true;
    }),
    nativeStopped: vi.fn(async () => stopped),
    databaseCompatible: vi.fn(async () => true),
    startNative: vi.fn(async () => {
      stopped = false;
    }),
    healthy: vi.fn(async () => !stopped),
  };
  return { root, binding, manifest, proof, effects, deployment };
}

it('completes the sealed current release through owned maintenance without replaying data migration or enabling CoS', async () => {
  const f = await fixture();
  protectCompletedProgramme(f.root, f.binding, f.proof);
  expect(admittedGeneration(f.root, f.binding)).toBeNull();
  await expect(deployRelease({ ...f, effects: f.deployment })).rejects.toThrow('deployed_release_unhealthy');
  await expect(completeProtectedRelease(f)).resolves.toMatchObject({
    status: 'healthy',
    lifecycle: 'protected',
    releaseId: f.manifest.releaseId,
    sourceCommit: f.manifest.source.commit,
    cosResumed: false,
  });
  expect(readTarget(f.root, f.binding)).toMatchObject({ lifecycle: 'protected', maintenance: false });
  expect(admittedGeneration(f.root, f.binding)).not.toBeNull();
  expect(f.effects.stopNative).toHaveBeenCalledTimes(1);
  expect(f.effects.startNative).toHaveBeenCalledTimes(1);
  expect(f.deployment.backup).toHaveBeenCalledTimes(1);
  expect(f.deployment.migrate).toHaveBeenCalledTimes(1);
  await expect(completeProtectedRelease(f)).resolves.toMatchObject({ status: 'healthy' });
  expect(f.effects.stopNative).toHaveBeenCalledTimes(1);
  expect(() => beginMaintenance(f.root, f.binding, 'disposable', 'runtime-disposable')).toThrow('protected_target');
});

it('retains protection and the same maintenance identity after an unverified restart until a healthy retry', async () => {
  const f = await fixture();
  protectCompletedProgramme(f.root, f.binding, f.proof);
  vi.mocked(f.effects.healthy).mockResolvedValue(false);
  await expect(completeProtectedRelease(f)).rejects.toThrow('operations_maintenance_unverified');
  const first = readTarget(f.root, f.binding);
  expect(first).toMatchObject({ lifecycle: 'protected', maintenance: true });
  expect(admittedGeneration(f.root, f.binding)).toBeNull();
  const files = fs.readdirSync(path.join(f.root, 'operations-maintenance'));
  expect(files).toHaveLength(1);
  const record = readPrivate<{ requestId: string; phase: string }>(
    path.join(f.root, 'operations-maintenance', files[0]),
  );
  expect(record.phase).toBe('restarting');
  vi.mocked(f.effects.healthy).mockResolvedValue(true);
  await expect(completeProtectedRelease(f)).resolves.toMatchObject({ status: 'healthy' });
  expect(fs.readdirSync(path.join(f.root, 'operations-maintenance'))).toEqual(files);
  expect(f.effects.stopNative).toHaveBeenCalledTimes(1);
  expect(readTarget(f.root, f.binding).lifecycle).toBe('protected');
});

it('cannot release another operation or an interrupted deployment repair lease', async () => {
  const f = await fixture();
  protectCompletedProgramme(f.root, f.binding, f.proof);
  const other = beginMaintenance(f.root, f.binding, f.manifest.releaseId, 'deployment');
  await expect(completeProtectedRelease(f)).rejects.toThrow('maintenance_owned');
  expect(readTarget(f.root, f.binding).maintenanceId).toBe(other.nonce);
  expect(f.effects.stopNative).not.toHaveBeenCalled();
});

it('keeps the native service stopped and the protected latch closed until database compatibility is verified', async () => {
  const f = await fixture();
  protectCompletedProgramme(f.root, f.binding, f.proof);
  vi.mocked(f.effects.databaseCompatible).mockResolvedValue(false);
  await expect(completeProtectedRelease(f)).rejects.toThrow('protected_release_unverified');
  expect(admittedGeneration(f.root, f.binding)).toBeNull();
  expect(f.effects.stopNative).toHaveBeenCalledTimes(1);
  expect(f.effects.startNative).not.toHaveBeenCalled();
  vi.mocked(f.effects.databaseCompatible).mockResolvedValue(true);
  await expect(completeProtectedRelease(f)).resolves.toMatchObject({ status: 'healthy', cosResumed: false });
  expect(f.effects.stopNative).toHaveBeenCalledTimes(1);
  expect(fs.readdirSync(path.join(f.root, 'operations-maintenance'))).toHaveLength(1);
});

it('refuses to stop an installed native service while an ordinary worker is active', async () => {
  const f = await fixture();
  protectCompletedProgramme(f.root, f.binding, f.proof);
  vi.mocked(f.effects.workersIdle).mockResolvedValue(false);
  await expect(completeProtectedRelease(f)).rejects.toThrow('operations_workers_active');
  expect(f.effects.stopNative).not.toHaveBeenCalled();
  expect(f.effects.startNative).not.toHaveBeenCalled();
  expect(admittedGeneration(f.root, f.binding)).toBeNull();
});

it.each(['missing-completion', 'different-final-release', 'failed-artifact-verification'] as const)(
  'does not alter admission or service for %s',
  async (failure) => {
    const f = await fixture();
    if (failure === 'missing-completion') protectTarget(f.root, f.binding);
    else
      protectCompletedProgramme(
        f.root,
        f.binding,
        failure === 'different-final-release'
          ? { ...f.proof, releaseManifest: { ...f.manifest, releaseId: 'release-other-final' } }
          : f.proof,
      );
    if (failure === 'failed-artifact-verification')
      vi.mocked(f.effects.verify).mockRejectedValue(new Error('changed payload'));
    await expect(completeProtectedRelease(f)).rejects.toThrow();
    expect(admittedGeneration(f.root, f.binding)).toBeNull();
    expect(f.effects.stopNative).not.toHaveBeenCalled();
    expect(f.effects.startNative).not.toHaveBeenCalled();
  },
);
