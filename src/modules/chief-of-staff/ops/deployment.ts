import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../domain/contracts.js';
import { readPrivate, readTarget, writeAtomic, withTargetLock, type TargetBinding } from './target-state.js';
import {
  beginMaintenance,
  confirmQuiescence,
  assertMaintenanceLease,
  finishMaintenance,
  admittedGeneration,
  type MaintenanceLease,
} from './maintenance.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';

const phases = ['source', 'artifacts', 'quiesce', 'backup', 'migrate', 'activate', 'health'] as const;
export type DeploymentPhase = (typeof phases)[number];
export type DeploymentEffects = {
  /** Read-only platform, binding, credentials, exact artifact and service checks on every invocation. */
  verify(): Promise<void>;
  source(): Promise<void>;
  artifacts(): Promise<void>;
  quiesce(): Promise<{ activeCoordinators: number; activeDatabaseOperations: number }>;
  backup(): Promise<void>;
  migrate(): Promise<void>;
  activate(): Promise<void>;
  health(): Promise<boolean>;
  /** Inspect a phase with an uncertain outcome before repeating any effect. */
  reconcile(phase: DeploymentPhase): Promise<'done' | 'retry_safe' | 'blocked'>;
  /** Must prove schema compatibility and restored service health; never restore the native DB. */
  rollback(previousReleaseId: string | null): Promise<boolean>;
};
export type DeploymentReceipt = {
  version: 1;
  releaseId: string;
  manifestDigest: string;
  bindingDigest: string;
  previousReleaseId: string | null;
  completed: DeploymentPhase[];
  pending: DeploymentPhase | null;
  status: 'in_progress' | 'failed' | 'health_failed' | 'rolled_back' | 'reopening' | 'healthy';
  lease: MaintenanceLease | null;
  updatedAt: string;
};
function receiptDirectory(root: string, releaseId: string): string {
  for (const directory of [path.join(root, 'releases'), path.join(root, 'releases', releaseId)]) {
    if (!fs.lstatSync(directory, { throwIfNoEntry: false })) fs.mkdirSync(directory, { mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (
      !stat.isDirectory() ||
      fs.realpathSync(directory) !== directory ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700
    )
      throw new Error('unsafe_deployment_receipt');
  }
  return path.join(root, 'releases', releaseId);
}
/** Caller holds the Pi OS deployment lock for the entire operation, including reconciliation. */
export async function deployRelease(request: {
  root: string;
  binding: TargetBinding;
  manifest: ReleaseManifest;
  effects: DeploymentEffects;
}): Promise<DeploymentReceipt> {
  const { root, binding, effects } = request,
    manifest = validateReleaseManifest(request.manifest);
  try {
    await effects.verify();
  } catch (error) {
    throw new Error('deployment_verification_failed', { cause: error });
  }
  let state = readTarget(root, binding);
  const directory = receiptDirectory(root, manifest.releaseId),
    file = path.join(directory, 'deployment.json');
  let record: DeploymentReceipt;
  if (fs.lstatSync(file, { throwIfNoEntry: false })) {
    record = readPrivate<DeploymentReceipt>(file);
    if (
      record.version !== 1 ||
      record.releaseId !== manifest.releaseId ||
      record.manifestDigest !== digest(manifest) ||
      record.bindingDigest !== digest(binding) ||
      !Array.isArray(record.completed) ||
      record.completed.length > phases.length ||
      record.completed.some((phase, index) => phases[index] !== phase) ||
      (record.pending !== null && record.pending !== phases[record.completed.length]) ||
      !['in_progress', 'failed', 'health_failed', 'rolled_back', 'reopening', 'healthy'].includes(record.status) ||
      (record.previousReleaseId !== null && !manifest.previousReleaseIds.includes(record.previousReleaseId))
    )
      throw new Error('deployment_receipt_conflict');
  } else {
    if (state.releaseId && !manifest.previousReleaseIds.includes(state.releaseId))
      throw new Error('previous_release_not_compatible');
    record = {
      version: 1,
      releaseId: manifest.releaseId,
      manifestDigest: digest(manifest),
      bindingDigest: digest(binding),
      previousReleaseId: state.releaseId,
      completed: [],
      pending: null,
      status: 'in_progress',
      lease: null,
      updatedAt: new Date().toISOString(),
    };
  }
  const save = () => {
    record.updatedAt = new Date().toISOString();
    writeAtomic(directory, 'deployment.json', record);
  };
  if (record.status === 'healthy') {
    if (
      state.releaseId !== manifest.releaseId ||
      admittedGeneration(root, binding) === null ||
      !(await effects.health())
    )
      throw new Error('deployed_release_unhealthy');
    return record;
  }
  if (record.status === 'rolled_back') {
    if (state.releaseId !== record.previousReleaseId || !state.maintenance)
      throw new Error('deployment_receipt_conflict');
    if (state.maintenanceId) {
      if (!record.lease) throw new Error('deployment_receipt_conflict');
      await finishMaintenance(root, binding, record.lease, () => effects.rollback(record.previousReleaseId), false);
    }
    throw new Error('deployment_rolled_back');
  }
  if (record.status === 'reopening') {
    if (
      state.releaseId !== manifest.releaseId ||
      record.completed.length !== phases.length ||
      !(await effects.health())
    )
      throw new Error('deployment_reconciliation_required');
    if (admittedGeneration(root, binding) === null) {
      if (!record.lease) throw new Error('deployment_receipt_conflict');
      await finishMaintenance(root, binding, record.lease, async () => true);
    }
    record.status = 'healthy';
    save();
    return record;
  }
  // Every resumed mutation must still own the same durable lease. A different operation cannot inherit it.
  if (record.lease) {
    const resumed = beginMaintenance(root, binding, manifest.releaseId, 'deployment');
    if (digest(resumed) !== digest(record.lease)) throw new Error('deployment_receipt_conflict');
  }
  const rollback = async (): Promise<never> => {
    record.status = 'health_failed';
    save();
    if (!record.lease) throw new Error('deployment_receipt_conflict');
    assertMaintenanceLease(root, binding, record.lease);
    if (await effects.rollback(record.previousReleaseId).catch(() => false)) {
      withTargetLock(root, () => {
        const current = assertMaintenanceLease(root, binding, record.lease!);
        writeAtomic(root, 'state.json', { ...current, releaseId: record.previousReleaseId });
      });
      record.status = 'rolled_back';
      save();
      await finishMaintenance(root, binding, record.lease, async () => true, false);
      throw new Error('deployment_rolled_back');
    }
    throw new Error('deployment_health_failed');
  };
  if (record.status === 'health_failed') return rollback();
  save();
  for (const phase of phases.slice(record.completed.length)) {
    if (phase === 'quiesce' && !record.lease) {
      record.lease = beginMaintenance(root, binding, manifest.releaseId, 'deployment');
      save();
    }
    let reconciled = false;
    if (record.pending) {
      const outcome = await effects.reconcile(phase);
      if (outcome === 'blocked') throw new Error('deployment_reconciliation_required');
      reconciled = outcome === 'done';
    }
    record.pending = phase;
    record.status = 'in_progress';
    save();
    try {
      if (['backup', 'migrate', 'activate', 'health'].includes(phase)) {
        if (!record.lease) throw new Error('deployment_receipt_conflict');
        assertMaintenanceLease(root, binding, record.lease);
      }
      // Quiescence and health are observations and always refreshed, even after a lost reply.
      if (phase === 'quiesce') await confirmQuiescence(root, binding, record.lease!, effects.quiesce);
      else if (phase === 'health') {
        if (!(await effects.health().catch(() => false))) return rollback();
      } else if (!reconciled) await effects[phase]();
      if (phase === 'activate')
        withTargetLock(root, () => {
          const current = assertMaintenanceLease(root, binding, record.lease!);
          writeAtomic(root, 'state.json', { ...current, releaseId: manifest.releaseId });
        });
      record.completed.push(phase);
      record.pending = null;
      save();
    } catch (error) {
      // Migration has completed before activation. A failed service start must attempt
      // compatible recovery rather than leave ordinary NanoClaw stopped indefinitely.
      if (phase === 'activate') return rollback();
      record.status = 'failed';
      save();
      throw new Error('deployment_incomplete', { cause: error });
    }
  }
  record.status = 'reopening';
  save();
  await finishMaintenance(root, binding, record.lease!, async () => true);
  state = readTarget(root, binding);
  if (state.releaseId !== manifest.releaseId || admittedGeneration(root, binding) === null)
    throw new Error('deployment_reconciliation_required');
  record.status = 'healthy';
  save();
  return record;
}
