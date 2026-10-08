import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { fixtureRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { initializeTarget, readTarget, readPrivate, protectTarget, writeAtomic } from './target-state.js';
import { activeMaintenanceLease, admittedGeneration, beginMaintenance } from './maintenance.js';
import { operationsMaintenance, type OperationsMaintenanceEffects } from './operations-maintenance.js';
import { runtimeServiceEnvironmentMatches } from './operations-maintenance-effects.js';
import { digest } from '../domain/contracts.js';
import { requiredReleaseChecks, type ReleaseManifest } from './release-manifest.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const binding = {
  hostFingerprint: 'a'.repeat(64),
  databaseFingerprint: 'b'.repeat(64),
  service: 'fixture.service',
  installationRoot: '/home/pi/nano',
  dataRoot: '/home/pi/nano/data',
};
function fixture(slice: 'S11' | 'G01' = 'S11') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-owner-maintenance-'));
  roots.push(base);
  const root = path.join(base, 'target');
  const manifest = fixtureRelease(slice),
    requestId = randomUUID();
  if (slice === 'G01') {
    const seal = {
      contract: 'cos-vault-root-artifact/v1' as const,
      sourceCommit: manifest.source.commit,
      sourceTree: manifest.source.tree,
      runtime: { name: 'node' as const, version: '22.23.2', architecture: 'arm64' as const },
      files: {
        'gateway.mjs': { bytes: 100, sha256: '4'.repeat(64) },
        node: { bytes: 122159120, sha256: '5'.repeat(64) },
      },
    };
    manifest.vaultArtifact = { digest: digest(seal), seal };
    manifest.previousReleaseIds = ['release-reviewed-s11'];
    manifest.checks = Object.fromEntries(
      requiredReleaseChecks(slice).map((name) => [
        name,
        {
          status: 'passed',
          at: '2026-10-08T00:00:00Z',
          sourceCommit: manifest.source.commit,
          imageIds:
            name === 'protected_state' || name.includes('image')
              ? manifest.images.map(({ id }) => id)
              : name.startsWith('vault_')
                ? [manifest.images[0]!.id]
                : [],
        },
      ]),
    ) as ReleaseManifest['checks'];
  }
  const original = initializeTarget(root, binding);
  writeAtomic(root, 'state.json', { ...original, releaseId: manifest.releaseId });
  const effects = {
    verify: vi.fn(async () => manifest),
    workersIdle: vi.fn(async () => true),
    stopNative: vi.fn(async () => {}),
    nativeStopped: vi.fn(async () => true),
    databaseCompatible: vi.fn(async () => true),
    startNative: vi.fn(async () => {}),
    healthy: vi.fn(async () => true),
  } satisfies OperationsMaintenanceEffects;
  return { root, manifest, requestId, effects };
}
it('uses a fresh G01 request ID on the protected installed release and restores only checked admission', async () => {
  const f = fixture('G01');
  protectTarget(f.root, binding);
  await expect(operationsMaintenance({ ...f, binding, phase: 'hold' })).resolves.toMatchObject({ status: 'held' });
  expect(activeMaintenanceLease(f.root, binding).owner).toBe('operations-' + f.requestId);
  await expect(operationsMaintenance({ ...f, binding, phase: 'release' })).resolves.toMatchObject({
    status: 'released',
    cosResumed: false,
  });
  const requestId = randomUUID();
  await expect(operationsMaintenance({ ...f, requestId, binding, phase: 'hold' })).resolves.toMatchObject({
    status: 'held',
  });
  expect(activeMaintenanceLease(f.root, binding).owner).toBe('operations-' + requestId);
});
it('denies G01 maintenance on an unprotected target before stopping any service', async () => {
  const f = fixture('G01');
  await expect(operationsMaintenance({ ...f, binding, phase: 'hold' })).rejects.toThrow(
    'operations_maintenance_unverified',
  );
  expect(f.effects.stopNative).not.toHaveBeenCalled();
});
it('S11-PG03 holds a stable data-preserving lease, closes the old service and restarts only after new access is checked', async () => {
  const f = fixture();
  protectTarget(f.root, binding);
  const invoke = (phase: 'hold' | 'release') => operationsMaintenance({ ...f, binding, phase });
  await expect(invoke('hold')).resolves.toMatchObject({ status: 'held', admissionRestored: false });
  const lease = activeMaintenanceLease(f.root, binding);
  await expect(invoke('hold')).resolves.toMatchObject({ status: 'held' });
  expect(activeMaintenanceLease(f.root, binding)).toEqual(lease);
  expect(f.effects.stopNative).toHaveBeenCalledOnce();
  f.effects.databaseCompatible.mockResolvedValue(false);
  await expect(invoke('release')).rejects.toThrow('operations_maintenance_unverified');
  expect(f.effects.startNative).not.toHaveBeenCalled();
  expect(admittedGeneration(f.root, binding)).toBeNull();
  f.effects.databaseCompatible.mockResolvedValue(true);
  await expect(invoke('release')).resolves.toMatchObject({ status: 'released', cosResumed: false });
  await expect(invoke('release')).resolves.toMatchObject({ status: 'released' });
  expect(f.effects.startNative).toHaveBeenCalledOnce();
  expect(readTarget(f.root, binding).lifecycle).toBe('protected');
  expect(admittedGeneration(f.root, binding)).not.toBeNull();
});
it('a failed old credential check can stop the local service without claiming a database backup barrier', async () => {
  const f = fixture();
  f.effects.databaseCompatible.mockResolvedValue(false);
  await expect(operationsMaintenance({ ...f, binding, phase: 'hold' })).resolves.toMatchObject({
    status: 'native_stopped_database_unverified',
    admissionRestored: false,
  });
  expect(() => activeMaintenanceLease(f.root, binding)).toThrow('target_not_quiescent');
  expect(admittedGeneration(f.root, binding)).toBeNull();
  expect(f.effects.stopNative).toHaveBeenCalledOnce();
  f.effects.databaseCompatible.mockResolvedValue(true);
  await expect(operationsMaintenance({ ...f, binding, phase: 'hold' })).resolves.toMatchObject({ status: 'held' });
  expect(f.effects.stopNative).toHaveBeenCalledOnce();
});
it('active ordinary workers, foreign leases and source changes cannot be adopted or stopped by owner maintenance', async () => {
  const f = fixture();
  f.effects.workersIdle.mockResolvedValue(false);
  await expect(operationsMaintenance({ ...f, binding, phase: 'hold' })).rejects.toThrow('operations_workers_active');
  expect(f.effects.stopNative).not.toHaveBeenCalled();
  f.effects.workersIdle.mockResolvedValue(true);
  beginMaintenance(f.root, binding, 'release-other', 'deployment');
  await expect(operationsMaintenance({ ...f, binding, phase: 'hold' })).rejects.toThrow('maintenance_owned');
  expect(f.effects.stopNative).not.toHaveBeenCalled();
});
it('failed restart health retains the exact closed lease and retry reconciles the same service rather than replaying a new release', async () => {
  const f = fixture();
  await operationsMaintenance({ ...f, binding, phase: 'hold' });
  const lease = activeMaintenanceLease(f.root, binding);
  f.effects.healthy.mockResolvedValue(false);
  await expect(operationsMaintenance({ ...f, binding, phase: 'release' })).rejects.toThrow(
    'operations_maintenance_unverified',
  );
  expect(activeMaintenanceLease(f.root, binding)).toEqual(lease);
  expect(admittedGeneration(f.root, binding)).toBeNull();
  f.effects.healthy.mockResolvedValue(true);
  await expect(operationsMaintenance({ ...f, binding, phase: 'release' })).resolves.toMatchObject({
    status: 'released',
  });
  expect(f.effects.startNative).toHaveBeenCalledOnce();
});
it('credential reinjection verifies only the selected service profile and refuses stale, duplicate or migration/test credentials', () => {
  const selected = { COS_PGUSER: 'fixture-runtime', COS_PGPASSWORD: 'fixture-new' };
  expect(
    runtimeServiceEnvironmentMatches(
      selected,
      Buffer.from('PATH=/usr/bin\0COS_PGUSER=fixture-runtime\0COS_PGPASSWORD=fixture-new\0'),
    ),
  ).toBe(true);
  for (const environment of [
    'COS_PGUSER=fixture-runtime\0COS_PGPASSWORD=fixture-old\0',
    'COS_PGUSER=fixture-runtime\0COS_PGPASSWORD=fixture-new\0COS_PGPASSWORD=fixture-new\0',
    'COS_PGUSER=fixture-runtime\0COS_PGPASSWORD=fixture-new\0COS_TEST_PGPASSWORD=fixture-test\0',
    'COS_PGUSER=fixture-runtime\0COS_PGPASSWORD=fixture-new\0COS_PG_MIGRATION_PASSWORD=fixture-admin\0',
  ])
    expect(runtimeServiceEnvironmentMatches(selected, Buffer.from(environment))).toBe(false);
  expect(runtimeServiceEnvironmentMatches({}, Buffer.from(''))).toBe(false);
  expect(runtimeServiceEnvironmentMatches({ ...selected, OPENAI_API_KEY: 'fixture' }, Buffer.from(''))).toBe(false);
});
it('a lost maintenance completion reply reconciles only its original receipt and a changed release remains closed', async () => {
  const f = fixture();
  await operationsMaintenance({ ...f, binding, phase: 'hold' });
  await operationsMaintenance({ ...f, binding, phase: 'release' });
  const directory = path.join(f.root, 'operations-maintenance');
  const record = readPrivate<Record<string, unknown>>(path.join(directory, f.requestId + '.json'));
  writeAtomic(directory, f.requestId + '.json', { ...record, phase: 'restarting' });
  await expect(operationsMaintenance({ ...f, binding, phase: 'release' })).resolves.toMatchObject({
    status: 'released',
  });
  expect(f.effects.startNative).toHaveBeenCalledOnce();
  const next = fixture();
  await operationsMaintenance({ ...next, binding, phase: 'hold' });
  writeAtomic(next.root, 'state.json', { ...readTarget(next.root, binding), releaseId: 'release-other' });
  await expect(operationsMaintenance({ ...next, binding, phase: 'release' })).rejects.toThrow(
    'operations_maintenance_unverified',
  );
  expect(next.effects.startNative).not.toHaveBeenCalled();
  expect(admittedGeneration(next.root, binding)).toBeNull();
});
