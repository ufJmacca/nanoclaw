import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { rollbackRelease } from './rollback.js';
import { initializeTarget, readTarget, writeAtomic } from './target-state.js';
import { fixtureRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { beginMaintenance, confirmQuiescence } from './maintenance.js';
import { digest } from '../domain/contracts.js';
import type { DeploymentEffects } from './deployment.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-manual-rollback-'));
  roots.push(root);
  const stateRoot = path.join(root, 'state');
  const binding = {
    hostFingerprint: '1'.repeat(64),
    databaseFingerprint: '2'.repeat(64),
    service: 'nano.service',
    installationRoot: '/fixture/nano',
    dataRoot: '/fixture/nano/data',
  };
  const manifest = fixtureRelease();
  manifest.previousReleaseIds = ['release-prior'];
  const state = initializeTarget(stateRoot, binding);
  writeAtomic(stateRoot, 'state.json', { ...state, releaseId: manifest.releaseId });
  const effects: DeploymentEffects = {
    verify: vi.fn(async () => {}),
    source: vi.fn(),
    artifacts: vi.fn(),
    quiesce: vi.fn(async () => ({ activeCoordinators: 0, activeDatabaseOperations: 0 })),
    backup: vi.fn(),
    migrate: vi.fn(),
    activate: vi.fn(),
    health: vi.fn(async () => true),
    reconcile: vi.fn(async () => 'done' as const),
    rollback: vi.fn(async () => true),
  };
  return { root: stateRoot, binding, manifest, effects, previousReleaseId: 'release-prior' };
}
it('records compatible restoration without restoring data or repeating a completed rollback', async () => {
  const f = fixture();
  await expect(rollbackRelease(f)).resolves.toMatchObject({
    status: 'rolled_back',
    releaseId: 'release-prior',
    maintenance: true,
  });
  expect(readTarget(f.root, f.binding)).toMatchObject({
    releaseId: 'release-prior',
    maintenance: true,
    maintenanceId: null,
  });
  expect(f.effects.migrate).not.toHaveBeenCalled();
  expect(f.effects.backup).not.toHaveBeenCalled();
  await rollbackRelease(f);
  expect(f.effects.rollback).toHaveBeenCalledOnce();
});
it('refuses an undeclared prior release and retains the maintenance lease if recovery cannot be proven', async () => {
  const f = fixture();
  await expect(rollbackRelease({ ...f, previousReleaseId: 'release-unknown' })).rejects.toThrow(
    'rollback_not_compatible',
  );
  expect(f.effects.quiesce).not.toHaveBeenCalled();
  f.effects.rollback = vi.fn(async () => false);
  await expect(rollbackRelease(f)).rejects.toThrow('rollback_unverified');
  expect(readTarget(f.root, f.binding)).toMatchObject({ releaseId: f.manifest.releaseId, maintenance: true });
  expect(readTarget(f.root, f.binding).maintenanceId).not.toBeNull();
});
it('reconciles a lost reply after restoring the prior pointer while the same maintenance lease is still held', async () => {
  const f = fixture();
  const lease = beginMaintenance(f.root, f.binding, f.manifest.releaseId, 'deployment');
  await confirmQuiescence(f.root, f.binding, lease, f.effects.quiesce);
  writeAtomic(f.root, 'state.json', { ...readTarget(f.root, f.binding), releaseId: f.previousReleaseId });
  fs.mkdirSync(path.join(f.root, 'rollbacks'), { mode: 0o700 });
  writeAtomic(path.join(f.root, 'rollbacks'), f.manifest.releaseId + '.json', {
    version: 1,
    fromReleaseId: f.manifest.releaseId,
    releaseId: f.previousReleaseId,
    manifestDigest: digest(f.manifest),
    bindingDigest: digest(f.binding),
    phase: 'pending',
    lease,
  });
  await expect(rollbackRelease(f)).resolves.toMatchObject({ status: 'rolled_back' });
  expect(f.effects.rollback).toHaveBeenCalledWith(f.previousReleaseId);
});
