import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../domain/contracts.js';
import { readPrivate, readTarget, type TargetBinding } from './target-state.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import { validateProgrammeProtection } from './programme-protection.js';
import { admittedGeneration } from './maintenance.js';
import { operationsMaintenance, type OperationsMaintenanceEffects } from './operations-maintenance.js';

/** Caller owns the Pi OS lock. Completion releases only its own service barrier, never data protection or CoS pause. */
export async function completeProtectedRelease(input: {
  root: string;
  binding: TargetBinding;
  manifest: ReleaseManifest;
  effects: OperationsMaintenanceEffects;
}): Promise<Record<string, unknown>> {
  const { root, binding, effects } = input,
    manifest = validateReleaseManifest(input.manifest),
    state = readTarget(root, binding);
  let completionDigest: string;
  try {
    const proof = validateProgrammeProtection(readPrivate(path.join(root, 'programme-protection.json'))),
      seal = readPrivate<{ completionDigest?: string }>(path.join(root, 'protected.json'));
    completionDigest = digest(proof);
    if (
      state.lifecycle !== 'protected' ||
      state.releaseId !== manifest.releaseId ||
      proof.bindingDigest !== digest(binding) ||
      digest(proof.releaseManifest) !== digest(manifest) ||
      seal.completionDigest !== completionDigest
    )
      throw new Error('protected_release_unverified');
    // This verifies the recorded all-seven release, immutable payload and paused native owner.
    if (digest(await effects.verify()) !== digest(manifest)) throw new Error('protected_release_unverified');
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private protection records and artifact diagnostics must not enter public failure output.
    throw new Error('protected_release_unverified');
  }
  const result = () => ({
    status: 'healthy',
    releaseId: manifest.releaseId,
    sourceCommit: manifest.source.commit,
    sourceTree: manifest.source.tree,
    lifecycle: 'protected',
    completionDigest,
    cosResumed: false,
    accountActivation: 'not_granted_by_protected_release',
  });
  if (admittedGeneration(root, binding) !== null) {
    if (!(await effects.healthy())) throw new Error('protected_release_unverified');
    return result();
  }
  const hash = digest({ purpose: 'cos-protected-release/v1', completionDigest, binding: digest(binding) }),
    requestId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
    recordFile = path.join(root, 'operations-maintenance', requestId + '.json');
  const phase = fs.lstatSync(recordFile, { throwIfNoEntry: false })
    ? readPrivate<{ phase: string }>(recordFile).phase
    : undefined;
  const maintenance = { root, binding, requestId, effects };
  if (!phase || !['held', 'restarting', 'released'].includes(phase)) {
    const held = await operationsMaintenance({ ...maintenance, phase: 'hold' });
    if (held.status !== 'held') throw new Error('protected_release_unverified');
  }
  const released = await operationsMaintenance({ ...maintenance, phase: 'release' }),
    current = readTarget(root, binding);
  if (
    released.status !== 'released' ||
    released.cosResumed !== false ||
    current.lifecycle !== 'protected' ||
    current.releaseId !== manifest.releaseId ||
    admittedGeneration(root, binding) === null
  )
    throw new Error('protected_release_unverified');
  return result();
}
