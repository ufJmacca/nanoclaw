import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import {
  readTarget,
  readPrivate,
  writeAtomic,
  withTargetLock,
  acquireTargetLock,
  type TargetBinding,
  type TargetState,
} from './target-state.js';
export type MaintenanceLease = {
  nonce: string;
  owner: string;
  generation: number;
  purpose: 'runtime-disposable' | 'deployment';
};
type Receipt = MaintenanceLease & {
  version: 1;
  bindingDigest: string;
  phase: 'closing' | 'quiescent' | 'complete';
  reopen?: boolean;
};
function receipt(root: string, binding: TargetBinding): Receipt {
  const value = readPrivate<Receipt>(path.join(root, 'maintenance.json'));
  if (
    !value ||
    value.version !== 1 ||
    value.bindingDigest !== digest(binding) ||
    !/^[a-f0-9-]{36}$/.test(value.nonce) ||
    !/^[a-zA-Z0-9_-]{1,160}$/.test(value.owner) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !['runtime-disposable', 'deployment'].includes(value.purpose) ||
    !['closing', 'quiescent', 'complete'].includes(value.phase) ||
    (value.reopen !== undefined && typeof value.reopen !== 'boolean')
  )
    throw new Error('maintenance_history_conflict');
  return value;
}
function leaseFrom(value: Receipt): MaintenanceLease {
  return { nonce: value.nonce, owner: value.owner, generation: value.generation, purpose: value.purpose };
}
function owned(root: string, binding: TargetBinding, lease: MaintenanceLease): { state: TargetState; record: Receipt } {
  const state = readTarget(root, binding);
  if (!state.maintenance || state.maintenanceId !== lease.nonce || state.generation !== lease.generation)
    throw new Error('stale_maintenance_lease');
  const record = receipt(root, binding);
  if (digest(leaseFrom(record)) !== digest(lease)) throw new Error('stale_maintenance_lease');
  if (lease.purpose === 'runtime-disposable' && state.lifecycle !== 'implementation_disposable')
    throw new Error('protected_target');
  return { state, record };
}
/** Persist the Pi latch first. A lost reply can only resume this exact owner/purpose. Never expires open. */
export function beginMaintenance(
  root: string,
  binding: TargetBinding,
  owner: string,
  purpose: MaintenanceLease['purpose'],
): MaintenanceLease {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(owner) || !['runtime-disposable', 'deployment'].includes(purpose))
    throw new Error('invalid_maintenance_request');
  return withTargetLock(root, () => {
    const state = readTarget(root, binding);
    if (purpose === 'runtime-disposable' && state.lifecycle !== 'implementation_disposable')
      throw new Error('protected_target');
    if (state.maintenanceId) {
      const existing = receipt(root, binding);
      if (existing.nonce !== state.maintenanceId || existing.generation !== state.generation)
        throw new Error('maintenance_history_conflict');
      if (existing.owner !== owner || existing.purpose !== purpose) throw new Error('maintenance_owned');
      return leaseFrom(existing);
    }
    if (state.maintenanceHistory || fs.lstatSync(path.join(root, 'maintenance.json'), { throwIfNoEntry: false })) {
      const previous = receipt(root, binding);
      if (previous.phase !== 'complete' || previous.generation >= state.generation)
        throw new Error('maintenance_history_conflict');
    }
    const next: Receipt = {
      version: 1,
      nonce: randomUUID(),
      owner,
      purpose,
      generation: state.generation + 1,
      bindingDigest: digest(binding),
      phase: 'closing',
    };
    writeAtomic(root, 'state.json', {
      ...state,
      maintenance: true,
      maintenanceHistory: true,
      maintenanceId: next.nonce,
      generation: next.generation,
    });
    writeAtomic(root, 'maintenance.json', next);
    return leaseFrom(next);
  });
}
export function assertMaintenanceLease(root: string, binding: TargetBinding, lease: MaintenanceLease): TargetState {
  const { state, record } = owned(root, binding, lease);
  if (record.phase !== 'quiescent') throw new Error('target_not_quiescent');
  return state;
}
export async function confirmQuiescence(
  root: string,
  binding: TargetBinding,
  lease: MaintenanceLease,
  quiesce: () => Promise<{ activeCoordinators: number; activeDatabaseOperations: number }>,
): Promise<void> {
  const release = acquireTargetLock(root);
  try {
    const { record } = owned(root, binding, lease);
    if (record.phase === 'complete') throw new Error('stale_maintenance_lease');
    const result = await quiesce();
    if (result.activeCoordinators !== 0 || result.activeDatabaseOperations !== 0)
      throw new Error('target_not_quiescent');
    owned(root, binding, lease);
    writeAtomic(root, 'maintenance.json', { ...record, phase: 'quiescent' });
  } finally {
    release();
  }
}
/** Reopen only after the same owner verifies schema compatibility and all pending results. */
export async function finishMaintenance(
  root: string,
  binding: TargetBinding,
  lease: MaintenanceLease,
  reconcile: () => Promise<boolean>,
  reopen = true,
): Promise<void> {
  const release = acquireTargetLock(root);
  try {
    const { state, record } = owned(root, binding, lease);
    if (!['quiescent', 'complete'].includes(record.phase)) throw new Error('target_not_quiescent');
    if (record.phase === 'complete' && (record.reopen ?? true) !== reopen) throw new Error('reconciliation_required');
    if (!(await reconcile())) throw new Error('reconciliation_required');
    owned(root, binding, lease);
    // Completion first; an interrupted final state write retains closed admission.
    writeAtomic(root, 'maintenance.json', { ...record, phase: 'complete', reopen });
    writeAtomic(root, 'state.json', {
      ...state,
      maintenance: !reopen,
      maintenanceId: null,
      generation: state.generation + 1,
    });
  } finally {
    release();
  }
}

/** Every runtime admission reads Pi-owned state, including the completion receipt. */
export function admittedGeneration(root: string, binding: TargetBinding): number | null {
  const state = readTarget(root, binding);
  if (state.maintenance || state.maintenanceId) return null;
  if (!state.maintenanceHistory) throw new Error('maintenance_history_missing');
  const record = receipt(root, binding);
  if (record.phase !== 'complete' || record.reopen === false || record.generation + 1 !== state.generation)
    throw new Error('maintenance_history_conflict');
  return state.generation;
}

/** Read only by the trusted target helper/admin process; never exported to a worker. */
export function activeMaintenanceLease(root: string, binding: TargetBinding): MaintenanceLease {
  const lease = leaseFrom(receipt(root, binding));
  assertMaintenanceLease(root, binding, lease);
  return lease;
}

/** Read-only ownership check usable while the short target-state lock is already held. */
export function maintenanceLeaseForOwner(root: string, binding: TargetBinding, owner: string): MaintenanceLease {
  const lease = leaseFrom(receipt(root, binding));
  owned(root, binding, lease);
  if (lease.owner !== owner || lease.purpose !== 'deployment') throw new Error('maintenance_owned');
  return lease;
}
