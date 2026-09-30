import path from 'node:path';
import { digest } from '../domain/contracts.js';
import { readPrivate, readTarget, writeAtomic, withTargetLock, type TargetBinding } from './target-state.js';
import { confirmQuiescence, finishMaintenance, maintenanceLeaseForOwner } from './maintenance.js';
import type { DeploymentEffects, DeploymentReceipt } from './deployment.js';

/** Caller holds the deployment OS lock. Close the old lease without ever reopening admission. */
export async function recoverFailedDeployment(request: {
  root: string;
  binding: TargetBinding;
  replacement: DeploymentReceipt;
  effects: DeploymentEffects;
}): Promise<void> {
  const { root, binding, replacement, effects } = request;
  const from = replacement.recoveryFrom;
  if (
    !from ||
    from === replacement.releaseId ||
    !/^release-[a-zA-Z0-9_-]{1,120}$/.test(from) ||
    !effects.prepareRecovery
  )
    throw new Error('deployment_recovery_denied');
  const directory = path.join(root, 'releases', from);
  const prior = readPrivate<DeploymentReceipt>(path.join(directory, 'deployment.json'));
  const prefix = ['source', 'artifacts', 'quiesce', 'backup', 'migrate', 'activate'];
  if (
    prior.version !== 1 ||
    prior.releaseId !== from ||
    prior.bindingDigest !== digest(binding) ||
    !/^[a-f0-9]{64}$/.test(prior.manifestDigest ?? '') ||
    !prior.lease ||
    prior.lease.owner !== from ||
    prior.lease.purpose !== 'deployment' ||
    !Array.isArray(prior.completed) ||
    ![5, 6].includes(prior.completed.length) ||
    prior.completed.some((phase, index) => phase !== prefix[index]) ||
    prior.pending !== (prior.completed.length === 5 ? 'activate' : 'health') ||
    !['health_failed', 'superseded'].includes(prior.status) ||
    (prior.status === 'superseded' && prior.supersededBy !== replacement.releaseId) ||
    (prior.status === 'health_failed' && prior.supersededBy !== undefined) ||
    (prior.previousReleaseId !== null && !/^release-[a-zA-Z0-9_-]{1,120}$/.test(prior.previousReleaseId ?? ''))
  )
    throw new Error('deployment_recovery_denied');
  const state = readTarget(root, binding);
  if (
    !state.maintenance ||
    (state.recoveryOwner !== undefined &&
      state.recoveryOwner !== replacement.releaseId &&
      !(prior.status === 'health_failed' && state.recoveryOwner === prior.releaseId)) ||
    (prior.status === 'superseded' && state.recoveryOwner !== replacement.releaseId) ||
    state.releaseId !== replacement.previousReleaseId ||
    ![prior.releaseId, prior.previousReleaseId].includes(state.releaseId)
  )
    throw new Error('deployment_recovery_denied');
  if (state.maintenanceId === prior.lease.nonce) {
    if (prior.status === 'health_failed') {
      await confirmQuiescence(root, binding, prior.lease, () => effects.prepareRecovery!(prior));
      withTargetLock(root, () => {
        const current = readTarget(root, binding);
        if (
          current.maintenanceId !== prior.lease!.nonce ||
          current.generation !== prior.lease!.generation ||
          (current.recoveryOwner !== undefined &&
            ![replacement.releaseId, prior.releaseId].includes(current.recoveryOwner))
        )
          throw new Error('deployment_recovery_denied');
        writeAtomic(root, 'state.json', { ...current, recoveryOwner: replacement.releaseId });
      });
      // Intent precedes lease completion; the old candidate can never resume after this write.
      prior.status = 'superseded';
      prior.supersededBy = replacement.releaseId;
      prior.updatedAt = new Date().toISOString();
      writeAtomic(directory, 'deployment.json', prior);
    }
    await finishMaintenance(
      root,
      binding,
      prior.lease,
      async () => {
        const result = await effects.prepareRecovery!(prior);
        return result.activeCoordinators === 0 && result.activeDatabaseOperations === 0;
      },
      false,
    );
    return;
  }
  // Reconcile a lost reply after old lease completion or new lease creation.
  if (prior.status !== 'superseded' || state.recoveryOwner !== replacement.releaseId)
    throw new Error('deployment_recovery_denied');
  if (state.maintenanceId === null) {
    if (state.generation !== prior.lease.generation + 1) throw new Error('deployment_recovery_denied');
    return;
  }
  const successor = maintenanceLeaseForOwner(root, binding, replacement.releaseId);
  if (successor.generation !== prior.lease.generation + 2) throw new Error('deployment_recovery_denied');
}
