import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../domain/contracts.js';
import { validateReleaseManifest } from './release-manifest.js';
import { readPrivate, readTarget, writeAtomic, type TargetBinding } from './target-state.js';
import {
  admittedGeneration,
  assertMaintenanceLease,
  beginMaintenance,
  confirmQuiescence,
  finishMaintenance,
  type MaintenanceLease,
} from './maintenance.js';
import type { OperationsMaintenanceEffects } from './operations-maintenance.js';

type Slot = { operationId: string; state: 'pending' | 'capturing' | 'failed' };
type Capture = { status: 'queued' | 'skipped_pending'; queueOperationId: string; snapshotDigest?: string };
export type CheckpointMaintenanceEffects = OperationsMaintenanceEffects & {
  inspect(): Promise<Slot[]>;
  capture(lease: MaintenanceLease): Promise<Capture>;
  verifyCapture(lease: MaintenanceLease, snapshotDigest?: string): Promise<Capture>;
};
type CheckpointRecord = {
  version: 1;
  requestId: string;
  bindingDigest: string;
  manifestDigest: string;
  releaseId: string;
  phase: 'closing' | 'native_stopped' | 'held' | 'capturing' | 'restarting' | 'complete';
  lease: MaintenanceLease | null;
  outcome: 'queued' | 'failed' | null;
  snapshotDigest: string | null;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha256 = /^[a-f0-9]{64}$/;
const unverified = (): never => {
  throw Error('checkpoint_maintenance_unverified');
};
/** Caller holds the installed operation lock. This holds target admission, never
 * writes the owner's native pause or context, and has no NAS/upload effect.
 */
export async function checkpointMaintenance(input: {
  root: string;
  binding: TargetBinding;
  requestId: string;
  effects: CheckpointMaintenanceEffects;
}): Promise<Record<string, unknown>> {
  const { root, binding, requestId, effects } = input;
  if (!uuid.test(requestId)) unverified();
  const manifest = validateReleaseManifest(await effects.verify()),
    state = readTarget(root, binding),
    owner = 'release-backup-' + requestId;
  if (
    !['G02', 'G03'].includes(manifest.slice) ||
    state.lifecycle !== 'protected' ||
    state.releaseId !== manifest.releaseId
  )
    unverified();
  const directory = path.join(root, 'backup-checkpoints'),
    file = path.join(directory, requestId + '.json');
  let record: CheckpointRecord | undefined;
  const directoryStat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    directoryStat &&
    (!directoryStat.isDirectory() ||
      directoryStat.uid !== process.getuid?.() ||
      (directoryStat.mode & 0o7777) !== 0o700 ||
      fs.realpathSync(directory) !== directory)
  )
    unverified();
  if (directoryStat && fs.lstatSync(file, { throwIfNoEntry: false })) {
    record = readPrivate<CheckpointRecord>(file);
    if (
      !record ||
      Object.keys(record).sort().join(',') !==
        'bindingDigest,lease,manifestDigest,outcome,phase,releaseId,requestId,snapshotDigest,version' ||
      record.version !== 1 ||
      record.requestId !== requestId ||
      record.bindingDigest !== digest(binding) ||
      record.manifestDigest !== digest(manifest) ||
      record.releaseId !== manifest.releaseId ||
      !['closing', 'native_stopped', 'held', 'capturing', 'restarting', 'complete'].includes(record.phase) ||
      ![null, 'queued', 'failed'].includes(record.outcome) ||
      (record.snapshotDigest !== null && !sha256.test(record.snapshotDigest)) ||
      (record.outcome === 'queued') !== (record.snapshotDigest !== null) ||
      (!record.lease && record.phase !== 'closing') ||
      ['restarting', 'complete'].includes(record.phase) !== (record.outcome !== null) ||
      (record.lease &&
        (Object.keys(record.lease).sort().join(',') !== 'generation,nonce,owner,purpose' ||
          record.lease.owner !== owner ||
          record.lease.purpose !== 'deployment' ||
          !uuid.test(record.lease.nonce) ||
          !Number.isSafeInteger(record.lease.generation) ||
          record.lease.generation < 1))
    )
      unverified();
  }
  if (!record) {
    // Queue admission precedes a new interruption. Recovery of this recorded
    // interruption depends on live maintenance and health, never queue readability.
    const slots = await effects.inspect();
    if (
      !Array.isArray(slots) ||
      slots.length > 1 ||
      slots.some((slot) => !uuid.test(slot.operationId) || !['pending', 'capturing', 'failed'].includes(slot.state))
    )
      unverified();
    if (slots.length)
      return {
        status: 'backup_skipped_pending',
        pendingState: slots[0].state,
        admissionRestored: false,
        interrupted: false,
        remoteCheckpoint: false,
      };
    if (admittedGeneration(root, binding) === null) throw Error('checkpoint_admission_closed');
    if (!directoryStat) fs.mkdirSync(directory, { mode: 0o700 });
    record = {
      version: 1,
      requestId,
      bindingDigest: digest(binding),
      manifestDigest: digest(manifest),
      releaseId: manifest.releaseId,
      phase: 'closing',
      lease: null,
      outcome: null,
      snapshotDigest: null,
    };
    writeAtomic(directory, requestId + '.json', record);
  }
  const currentRecord = record,
    save = () => writeAtomic(directory, requestId + '.json', currentRecord);
  const current = async () => {
    const observedManifest = validateReleaseManifest(await effects.verify()),
      now = readTarget(root, binding);
    if (
      digest(observedManifest) !== currentRecord.manifestDigest ||
      now.lifecycle !== 'protected' ||
      now.releaseId !== currentRecord.releaseId
    )
      unverified();
  };
  const result = () => ({
    status: currentRecord.outcome === 'queued' ? 'backup_queued' : 'backup_failed',
    requestId,
    releaseId: currentRecord.releaseId,
    queueOperationId: currentRecord.lease!.nonce,
    snapshotDigest: currentRecord.snapshotDigest,
    admissionRestored: true,
    remoteCheckpoint: false,
  });
  const completed = async () => {
    const completion = readPrivate<MaintenanceLease & { phase: string; reopen?: boolean; bindingDigest: string }>(
      path.join(root, 'maintenance.json'),
    );
    if (
      !currentRecord.lease ||
      completion.phase !== 'complete' ||
      completion.reopen !== true ||
      completion.bindingDigest !== digest(binding) ||
      completion.nonce !== currentRecord.lease.nonce ||
      completion.owner !== owner ||
      completion.purpose !== 'deployment' ||
      completion.generation !== currentRecord.lease.generation ||
      admittedGeneration(root, binding) !== currentRecord.lease.generation + 1 ||
      !(await effects.healthy())
    )
      unverified();
    await current();
  };
  if (currentRecord.phase === 'complete') {
    await completed();
    return result();
  }
  if (currentRecord.phase === 'restarting' && !readTarget(root, binding).maintenanceId) {
    await completed();
    currentRecord.phase = 'complete';
    save();
    return result();
  }
  if (['closing', 'native_stopped'].includes(currentRecord.phase)) {
    await current();
    if (!readTarget(root, binding).maintenanceId && admittedGeneration(root, binding) === null)
      throw Error('checkpoint_admission_closed');
    if (!(await effects.workersIdle())) throw Error('checkpoint_workers_active');
    const lease = beginMaintenance(root, binding, owner, 'deployment');
    if (currentRecord.lease && digest(currentRecord.lease) !== digest(lease)) unverified();
    currentRecord.lease = lease;
    save();
    if (currentRecord.phase === 'closing') {
      await current();
      if (!(await effects.workersIdle())) throw Error('checkpoint_workers_active');
      await effects.stopNative();
      if (!(await effects.nativeStopped())) unverified();
      currentRecord.phase = 'native_stopped';
      save();
    }
    if (!(await effects.databaseCompatible())) unverified();
    await confirmQuiescence(root, binding, lease, async () => {
      await current();
      return {
        activeCoordinators: (await effects.nativeStopped()) ? 0 : 1,
        activeDatabaseOperations: (await effects.databaseCompatible()) ? 0 : 1,
      };
    });
    currentRecord.phase = 'held';
    save();
  }
  if (!currentRecord.lease) unverified();
  const lease = currentRecord.lease!;
  assertMaintenanceLease(root, binding, lease);
  await current();
  if (['held', 'capturing'].includes(currentRecord.phase)) {
    const fresh = currentRecord.phase === 'held';
    currentRecord.phase = 'capturing';
    save();
    try {
      let expected: string | undefined;
      if (fresh) {
        try {
          const captured = await effects.capture(lease);
          if (
            captured.status !== 'queued' ||
            captured.queueOperationId !== lease.nonce ||
            !captured.snapshotDigest ||
            !sha256.test(captured.snapshotDigest)
          )
            unverified();
          expected = captured.snapshotDigest;
          // eslint-disable-next-line no-catch-all/no-catch-all -- Capture diagnostics stay private; only fresh owned queue readback can establish a lost acknowledgement.
        } catch {
          const pending = await effects.inspect();
          if (pending.length !== 1 || pending[0].operationId !== lease.nonce || pending[0].state !== 'pending')
            unverified();
        }
      } else {
        const pending = await effects.inspect();
        if (pending.length !== 1 || pending[0].operationId !== lease.nonce || pending[0].state !== 'pending')
          unverified();
      }
      await current();
      assertMaintenanceLease(root, binding, lease);
      const verified = await effects.verifyCapture(lease, expected);
      if (
        verified.status !== 'queued' ||
        verified.queueOperationId !== lease.nonce ||
        !verified.snapshotDigest ||
        !sha256.test(verified.snapshotDigest) ||
        (expected !== undefined && expected !== verified.snapshotDigest)
      )
        unverified();
      await current();
      assertMaintenanceLease(root, binding, lease);
      currentRecord.outcome = 'queued';
      currentRecord.snapshotDigest = verified.snapshotDigest!;
      // eslint-disable-next-line no-catch-all/no-catch-all -- Capture failure stays private; compatible healthy service admission is recovered under fresh authority.
    } catch {
      currentRecord.outcome = 'failed';
      currentRecord.snapshotDigest = null;
    }
    await current();
    assertMaintenanceLease(root, binding, lease);
    currentRecord.phase = 'restarting';
    save();
    await effects.startNative();
  } else if (currentRecord.phase === 'restarting' && !(await effects.healthy())) {
    await current();
    assertMaintenanceLease(root, binding, lease);
    await effects.startNative();
  }
  await current();
  if (!(await effects.databaseCompatible()) || !(await effects.healthy())) unverified();
  await finishMaintenance(root, binding, lease, async () => {
    await current();
    return effects.healthy();
  });
  currentRecord.phase = 'complete';
  save();
  return result();
}
