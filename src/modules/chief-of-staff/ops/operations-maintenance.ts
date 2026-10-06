import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../domain/contracts.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import { readTarget, readPrivate, writeAtomic, type TargetBinding } from './target-state.js';
import {
  beginMaintenance,
  confirmQuiescence,
  assertMaintenanceLease,
  finishMaintenance,
  admittedGeneration,
  type MaintenanceLease,
} from './maintenance.js';

export type OperationsMaintenanceEffects = {
  /** Recorded tested payload and paused native CoS identity, without requiring old DB credentials. */
  verify(): Promise<ReleaseManifest>;
  workersIdle(): Promise<boolean>;
  stopNative(): Promise<void>;
  nativeStopped(): Promise<boolean>;
  databaseCompatible(): Promise<boolean>;
  startNative(): Promise<void>;
  /** New process/source/native owner, injected service credentials, current DB/schema and paused CoS. */
  healthy(): Promise<boolean>;
};
type MaintenanceRecord = {
  version: 1;
  requestId: string;
  bindingDigest: string;
  manifestDigest: string;
  releaseId: string;
  phase: 'closing' | 'native_stopped' | 'held' | 'restarting' | 'released';
  lease: MaintenanceLease | null;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const unverified = (): never => {
  throw new Error('operations_maintenance_unverified');
};
function directory(root: string) {
  if (!fs.lstatSync(root, { throwIfNoEntry: false })) fs.mkdirSync(root, { mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    fs.realpathSync(root) !== root
  )
    unverified();
}
/** Caller holds the Pi OS operation lock. This never grants model/account authority or restores data. */
export async function operationsMaintenance(input: {
  root: string;
  binding: TargetBinding;
  requestId: string;
  phase: 'hold' | 'release';
  effects: OperationsMaintenanceEffects;
}): Promise<Record<string, unknown>> {
  const { root, binding, requestId, phase, effects } = input;
  if (!uuid.test(requestId) || !['hold', 'release'].includes(phase)) unverified();
  const manifest = validateReleaseManifest(await effects.verify()),
    state = readTarget(root, binding);
  if (manifest.slice !== 'S11' || state.releaseId !== manifest.releaseId) unverified();
  const receipts = path.join(root, 'operations-maintenance');
  directory(receipts);
  const file = path.join(receipts, requestId + '.json'),
    owner = 'operations-' + requestId;
  let record: MaintenanceRecord;
  if (fs.lstatSync(file, { throwIfNoEntry: false })) {
    record = readPrivate<MaintenanceRecord>(file);
    if (
      !record ||
      Object.keys(record).length !== 7 ||
      Object.keys(record).some(
        (key) =>
          !['version', 'requestId', 'bindingDigest', 'manifestDigest', 'releaseId', 'phase', 'lease'].includes(key),
      ) ||
      record.version !== 1 ||
      record.requestId !== requestId ||
      record.bindingDigest !== digest(binding) ||
      record.manifestDigest !== digest(manifest) ||
      record.releaseId !== manifest.releaseId ||
      !['closing', 'native_stopped', 'held', 'restarting', 'released'].includes(record.phase) ||
      (!record.lease && record.phase !== 'closing') ||
      (record.lease &&
        (Object.keys(record.lease).length !== 4 ||
          record.lease.owner !== owner ||
          record.lease.purpose !== 'deployment' ||
          !uuid.test(record.lease.nonce) ||
          !Number.isSafeInteger(record.lease.generation) ||
          record.lease.generation < 1))
    )
      unverified();
  } else {
    if (phase !== 'hold') unverified();
    record = {
      version: 1,
      requestId,
      bindingDigest: digest(binding),
      manifestDigest: digest(manifest),
      releaseId: manifest.releaseId,
      phase: 'closing',
      lease: null,
    };
    writeAtomic(receipts, requestId + '.json', record);
  }
  const save = () => writeAtomic(receipts, requestId + '.json', record);
  const current = async () => {
    if (
      digest(validateReleaseManifest(await effects.verify())) !== record.manifestDigest ||
      readTarget(root, binding).releaseId !== record.releaseId
    )
      unverified();
  };
  const result = (status: string) => ({
    status,
    requestId,
    releaseId: record.releaseId,
    lifecycle: readTarget(root, binding).lifecycle,
    admissionRestored: status === 'released',
    cosResumed: false,
    accountActivation: 'not_granted_by_maintenance',
  });
  if (record.phase === 'released') {
    if (phase !== 'release' || admittedGeneration(root, binding) === null || !(await effects.healthy())) unverified();
    return result('released');
  }
  if (phase === 'hold') {
    if (record.phase === 'restarting') unverified();
    if (!(await effects.workersIdle())) throw new Error('operations_workers_active');
    const lease = beginMaintenance(root, binding, owner, 'deployment');
    if (record.lease && digest(record.lease) !== digest(lease)) unverified();
    record.lease = lease;
    save();
    if (record.phase === 'closing') {
      await current();
      if (!(await effects.workersIdle())) throw new Error('operations_workers_active');
      await effects.stopNative();
      if (!(await effects.nativeStopped())) unverified();
      record.phase = 'native_stopped';
      save();
    }
    await current();
    if (!(await effects.nativeStopped())) unverified();
    if (!(await effects.databaseCompatible())) return result('native_stopped_database_unverified');
    await confirmQuiescence(root, binding, lease, async () => {
      await current();
      return {
        activeCoordinators: (await effects.nativeStopped()) ? 0 : 1,
        activeDatabaseOperations: (await effects.databaseCompatible()) ? 0 : 1,
      };
    });
    record.phase = 'held';
    save();
    return result('held');
  }
  if (!record.lease || !['held', 'restarting'].includes(record.phase)) unverified();
  const releaseLease = record.lease;
  if (!releaseLease) return unverified();
  // A lost finish reply is reconciled from the exact completed target receipt, never a new lease.
  const now = readTarget(root, binding);
  if (!now.maintenanceId) {
    const completion = readPrivate<MaintenanceLease & { phase: string; reopen?: boolean; bindingDigest: string }>(
      path.join(root, 'maintenance.json'),
    );
    if (
      completion.phase !== 'complete' ||
      completion.reopen !== true ||
      completion.bindingDigest !== digest(binding) ||
      completion.nonce !== releaseLease.nonce ||
      completion.owner !== owner ||
      completion.purpose !== 'deployment' ||
      completion.generation !== releaseLease.generation ||
      admittedGeneration(root, binding) !== releaseLease.generation + 1 ||
      !(await effects.healthy())
    )
      unverified();
    record.phase = 'released';
    save();
    return result('released');
  }
  assertMaintenanceLease(root, binding, releaseLease);
  await current();
  if (!(await effects.databaseCompatible())) unverified();
  if (record.phase === 'held') {
    if (!(await effects.nativeStopped())) unverified();
    record.phase = 'restarting';
    save();
    await effects.startNative();
  } else if (!(await effects.healthy())) {
    // Service-manager start is idempotent: reconcile an interrupted request against the same release.
    await effects.startNative();
  }
  if (!(await effects.healthy())) unverified();
  await finishMaintenance(root, binding, releaseLease, async () => {
    await current();
    return effects.healthy();
  });
  record.phase = 'released';
  save();
  return result('released');
}
