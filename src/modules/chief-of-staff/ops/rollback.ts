import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../domain/contracts.js';
import { readPrivate, readTarget, writeAtomic, withTargetLock, type TargetBinding } from './target-state.js';
import {
  beginMaintenance,
  confirmQuiescence,
  assertMaintenanceLease,
  finishMaintenance,
  type MaintenanceLease,
} from './maintenance.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import type { DeploymentEffects } from './deployment.js';

/** Explicit rollback restores a recorded code/image pair and leaves CoS admission closed. Caller holds the OS lock. */
export async function rollbackRelease(request: {
  root: string;
  binding: TargetBinding;
  manifest: ReleaseManifest;
  effects: DeploymentEffects;
  previousReleaseId: string;
}) {
  const { root, binding, effects, previousReleaseId } = request,
    manifest = validateReleaseManifest(request.manifest);
  if (!manifest.previousReleaseIds.includes(previousReleaseId)) throw new Error('rollback_not_compatible');
  await effects.verify();
  const directory = path.join(root, 'rollbacks');
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })) fs.mkdirSync(directory, { mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    fs.realpathSync(directory) !== directory ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('unsafe_rollback_receipt');
  const name = manifest.releaseId + '.json',
    file = path.join(directory, name);
  const identity = {
    version: 1,
    fromReleaseId: manifest.releaseId,
    releaseId: previousReleaseId,
    manifestDigest: digest(manifest),
    bindingDigest: digest(binding),
  };
  type Record = typeof identity & { phase: 'pending' | 'restored' | 'complete'; lease: MaintenanceLease | null };
  let record: Record = fs.existsSync(file) ? readPrivate<Record>(file) : { ...identity, phase: 'pending', lease: null };
  if (
    Object.entries(identity).some(([key, value]) => record[key as keyof Record] !== value) ||
    !['pending', 'restored', 'complete'].includes(record.phase)
  )
    throw new Error('rollback_receipt_conflict');
  const result = () => ({
    status: 'rolled_back',
    fromReleaseId: manifest.releaseId,
    releaseId: previousReleaseId,
    maintenance: true,
  });
  const state = readTarget(root, binding);
  if (record.phase === 'complete') {
    if (state.releaseId !== previousReleaseId || !state.maintenance || state.maintenanceId)
      throw new Error('rollback_receipt_conflict');
    return result();
  }
  if (record.phase === 'restored') {
    if (state.releaseId !== previousReleaseId || !state.maintenance || !record.lease)
      throw new Error('rollback_receipt_conflict');
    if (state.maintenanceId) await finishMaintenance(root, binding, record.lease, async () => true, false);
    record.phase = 'complete';
    writeAtomic(directory, name, record);
    return result();
  }
  if (
    state.releaseId !== manifest.releaseId &&
    !(
      state.releaseId === previousReleaseId &&
      record.lease &&
      state.maintenanceId === record.lease.nonce &&
      state.generation === record.lease.generation
    )
  )
    throw new Error('rollback_source_changed');
  writeAtomic(directory, name, record);
  const lease = beginMaintenance(root, binding, manifest.releaseId, 'deployment');
  if (record.lease && digest(record.lease) !== digest(lease)) throw new Error('rollback_receipt_conflict');
  record = { ...record, lease };
  writeAtomic(directory, name, record);
  await confirmQuiescence(root, binding, lease, effects.quiesce);
  if (!(await effects.rollback(previousReleaseId).catch(() => false))) throw new Error('rollback_unverified');
  withTargetLock(root, () => {
    const current = assertMaintenanceLease(root, binding, lease);
    writeAtomic(root, 'state.json', { ...current, releaseId: previousReleaseId });
  });
  record.phase = 'restored';
  writeAtomic(directory, name, record);
  await finishMaintenance(root, binding, lease, async () => true, false);
  record.phase = 'complete';
  writeAtomic(directory, name, record);
  return result();
}
