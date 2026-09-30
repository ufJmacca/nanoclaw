import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeTarget, readTarget, protectTarget, type TargetBinding } from './target-state.js';
import {
  beginMaintenance,
  confirmQuiescence,
  finishMaintenance,
  assertMaintenanceLease,
  admittedGeneration,
} from './maintenance.js';
let root: string, parent: string;
const binding: TargetBinding = {
  hostFingerprint: 'a'.repeat(64),
  databaseFingerprint: 'b'.repeat(64),
  service: 'fixture.service',
  installationRoot: '/fixture',
  dataRoot: '/fixture/data',
};
beforeEach(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-maintenance-'));
  root = path.join(parent, 'state');
  initializeTarget(root, binding);
});
afterEach(() => fs.rmSync(parent, { recursive: true, force: true }));
describe('S01-PG02 durable target maintenance fencing', () => {
  it('finishes a recovered rollback lease while keeping admission closed for the next deployment', async () => {
    const lease = beginMaintenance(root, binding, 'release-old', 'deployment');
    await confirmQuiescence(root, binding, lease, async () => ({ activeCoordinators: 0, activeDatabaseOperations: 0 }));
    await finishMaintenance(root, binding, lease, async () => true, false);
    expect(readTarget(root, binding)).toMatchObject({ maintenance: true, maintenanceId: null });
    expect(admittedGeneration(root, binding)).toBeNull();
    expect(beginMaintenance(root, binding, 'release-new', 'deployment').generation).toBeGreaterThan(lease.generation);
  });
  it('persists closed admission before quiescing and returns one stable lease after an interrupted reply', async () => {
    const lease = beginMaintenance(root, binding, 'test-fixture-1', 'runtime-disposable');
    expect(readTarget(root, binding)).toMatchObject({ maintenance: true, generation: lease.generation });
    expect(beginMaintenance(root, binding, 'test-fixture-1', 'runtime-disposable')).toEqual(lease);
    expect(() => assertMaintenanceLease(root, binding, lease)).toThrow('target_not_quiescent');
    await confirmQuiescence(root, binding, lease, async () => ({ activeCoordinators: 0, activeDatabaseOperations: 0 }));
    expect(assertMaintenanceLease(root, binding, lease)).toMatchObject({ maintenance: true });
  });
  it('refuses another owner and does not clear a failed or uncertain quiescence latch', async () => {
    const lease = beginMaintenance(root, binding, 'test-fixture-1', 'runtime-disposable');
    expect(() => beginMaintenance(root, binding, 'different-owner', 'deployment')).toThrow('maintenance_owned');
    await expect(
      confirmQuiescence(root, binding, lease, async () => ({ activeCoordinators: 1, activeDatabaseOperations: 0 })),
    ).rejects.toThrow('target_not_quiescent');
    expect(readTarget(root, binding).maintenance).toBe(true);
    expect(() => assertMaintenanceLease(root, binding, lease)).toThrow();
  });
  it('requires fresh schema/reconciliation verification before reopening and fences a stale lease', async () => {
    const lease = beginMaintenance(root, binding, 'test-fixture-1', 'runtime-disposable');
    await confirmQuiescence(root, binding, lease, async () => ({ activeCoordinators: 0, activeDatabaseOperations: 0 }));
    await expect(finishMaintenance(root, binding, lease, async () => false)).rejects.toThrow('reconciliation_required');
    expect(readTarget(root, binding).maintenance).toBe(true);
    await finishMaintenance(root, binding, lease, async () => true);
    expect(readTarget(root, binding).maintenance).toBe(false);
    expect(() => assertMaintenanceLease(root, binding, lease)).toThrow('stale_maintenance_lease');
    const next = beginMaintenance(root, binding, 'test-fixture-2', 'runtime-disposable');
    expect(next.generation).toBeGreaterThan(lease.generation);
    const reconcile = vi.fn().mockResolvedValue(true);
    await expect(finishMaintenance(root, binding, lease, reconcile)).rejects.toThrow('stale_maintenance_lease');
    expect(reconcile).not.toHaveBeenCalled();
  });
  it('rejects runtime disposal after protection but permits data-preserving deployment maintenance', () => {
    protectTarget(root, binding);
    expect(() => beginMaintenance(root, binding, 'test-fixture-1', 'runtime-disposable')).toThrow('protected_target');
    expect(beginMaintenance(root, binding, 'release-fixture', 'deployment').purpose).toBe('deployment');
  });
  it('never treats missing or manually replaced lease history as authority to reopen', async () => {
    const lease = beginMaintenance(root, binding, 'test-fixture-1', 'runtime-disposable');
    fs.unlinkSync(path.join(root, 'maintenance.json'));
    await expect(finishMaintenance(root, binding, lease, async () => true)).rejects.toThrow();
    expect(() => beginMaintenance(root, binding, 'test-fixture-2', 'runtime-disposable')).toThrow();
    expect(readTarget(root, binding).maintenance).toBe(true);
  });
});

it('does not admit runtime work after completion history is lost', async () => {
  const lease = beginMaintenance(root, binding, 'test-fixture-1', 'runtime-disposable');
  expect(admittedGeneration(root, binding)).toBeNull();
  await confirmQuiescence(root, binding, lease, async () => ({ activeCoordinators: 0, activeDatabaseOperations: 0 }));
  await finishMaintenance(root, binding, lease, async () => true);
  expect(admittedGeneration(root, binding)).toBeGreaterThan(lease.generation);
  fs.unlinkSync(path.join(root, 'maintenance.json'));
  expect(() => admittedGeneration(root, binding)).toThrow();
  expect(() => beginMaintenance(root, binding, 'test-fixture-2', 'runtime-disposable')).toThrow();
});
