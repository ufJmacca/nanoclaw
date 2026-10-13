import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../domain/contracts.js';
import { readPrivate, readTarget, type TargetBinding } from './target-state.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import { artifactHash } from './release-artifacts.js';
import { payloadDigest } from './payload.js';
import { verifyRetainedAdminHelper } from './retained-admin-helper.js';
import type { DeploymentSettings } from './deployment-settings.js';
import {
  initializeBackupJob,
  createBackupInitializationEffects,
  type BackupInitializationEffects,
} from './backup-initialize-job.js';
import { targetBinding } from './target-host.js';
import { verifyVaultMemory } from './vault-memory.js';

/** Verify a prepared, fully tested G02 repair against a separately verified
 * healthy G02 runtime. Provenance alone grants no effects: initialization and
 * upload callers retain their separate admission and repository authority. */
export async function verifyBackupInitializationRepair(
  settings: { releaseRoot: string; stagingRoot: string; sourceRoot: string; stateRoot: string },
  binding: TargetBinding,
  invoked: string,
): Promise<{ runtime: ReleaseManifest; helper: ReleaseManifest }> {
  try {
    const state = readTarget(settings.stateRoot, binding),
      payload = path.resolve(path.dirname(invoked), '../../../..'),
      archive = path.dirname(payload);
    if (
      state.lifecycle !== 'protected' ||
      state.maintenance !== false ||
      !state.releaseId ||
      path.dirname(archive) !== settings.releaseRoot ||
      invoked !== path.join(payload, 'dist/modules/chief-of-staff/ops/target-helper.js') ||
      fs.realpathSync(invoked) !== invoked
    )
      throw Error('repair_scope_conflict');
    const helper = validateReleaseManifest(readPrivate(path.join(archive, 'release.json'))),
      stage = path.join(settings.stagingRoot, helper.releaseId);
    for (const directory of [archive, stage]) {
      const stat = fs.lstatSync(directory);
      if (
        !stat.isDirectory() ||
        fs.realpathSync(directory) !== directory ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o7777) !== 0o700
      )
        throw Error('repair_directory_conflict');
    }
    const prepared = readPrivate<Record<string, unknown>>(path.join(stage, 'prepared.json')),
      source = readPrivate<Record<string, unknown>>(path.join(stage, 'source.json')),
      hash = await artifactHash(path.join(archive, 'release.json'), 262144);
    if (
      helper.slice !== 'G02' ||
      helper.releaseId !== path.basename(archive) ||
      helper.releaseId === state.releaseId ||
      !helper.previousReleaseIds.includes(state.releaseId) ||
      Object.keys(prepared).sort().join(',') !==
        'archiveHash,hostPayloadDigest,manifestHash,payload,releaseId,status' ||
      prepared.status !== 'prepared' ||
      prepared.releaseId !== helper.releaseId ||
      prepared.payload !== payload ||
      prepared.hostPayloadDigest !== helper.hostPayloadDigest ||
      prepared.manifestHash !== hash ||
      !/^[a-f0-9]{64}$/.test(String(prepared.archiveHash)) ||
      (await artifactHash(path.join(stage, 'release.json'), 262144)) !== hash ||
      Object.keys(source).sort().join(',') !== 'checkout,commit,contract,repository,tree,verifiedAt' ||
      source.contract !== helper.source.syncContract ||
      source.repository !== helper.source.repository ||
      source.commit !== helper.source.commit ||
      source.tree !== helper.source.tree ||
      source.checkout !== path.join(settings.sourceRoot, helper.releaseId) ||
      typeof source.verifiedAt !== 'string' ||
      !Number.isFinite(Date.parse(source.verifiedAt)) ||
      (await payloadDigest(payload)) !== helper.hostPayloadDigest
    )
      throw Error('repair_preparation_conflict');
    const runtime = await verifyRetainedAdminHelper(
      settings,
      binding,
      path.join(settings.releaseRoot, state.releaseId, 'payload/dist/modules/chief-of-staff/ops/target-helper.js'),
    );
    if (
      runtime.slice !== 'G02' ||
      runtime.releaseId !== state.releaseId ||
      digest(runtime.postgres) !== digest(helper.postgres) ||
      digest(runtime.sqlite) !== digest(helper.sqlite) ||
      digest(runtime.migrations) !== digest(helper.migrations) ||
      digest(runtime.backupArtifact) !== digest(helper.backupArtifact) ||
      digest(readTarget(settings.stateRoot, binding)) !== digest(state)
    )
      throw Error('repair_runtime_conflict');
    return { runtime, helper };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private staged/installed provenance and paths do not leave the repair boundary.
    throw Error('backup_initialization_repair_unverified');
  }
}

export type BackupInitializationRepairEffects = Omit<BackupInitializationEffects, 'verify'> & {
  verifyRepair(): Promise<{ runtime: ReleaseManifest; helper: ReleaseManifest }>;
};
/** Preserve the ordinary initialization admission, upload lock and stable ID.
 * Every asynchronous boundary revalidates both sources. Only the installed
 * runtime manifest binds vault credentials and repository identity. */
export async function initializeBackupRepair(input: {
  root: string;
  binding: TargetBinding;
  requestId: string;
  effects: BackupInitializationRepairEffects;
}): Promise<Record<string, unknown>> {
  let expected: { runtime: ReleaseManifest; helper: ReleaseManifest } | undefined;
  try {
    const result = await initializeBackupJob({
      ...input,
      effects: {
        ...input.effects,
        async verify() {
          const proof = await input.effects.verifyRepair(),
            runtime = validateReleaseManifest(proof.runtime),
            helper = validateReleaseManifest(proof.helper);
          if (
            runtime.slice !== 'G02' ||
            helper.slice !== 'G02' ||
            runtime.releaseId === helper.releaseId ||
            !helper.previousReleaseIds.includes(runtime.releaseId) ||
            digest(runtime.postgres) !== digest(helper.postgres) ||
            digest(runtime.sqlite) !== digest(helper.sqlite) ||
            digest(runtime.migrations) !== digest(helper.migrations) ||
            digest(runtime.backupArtifact) !== digest(helper.backupArtifact)
          )
            throw Error('repair_proof_conflict');
          if (expected && digest(expected) !== digest({ runtime, helper })) throw Error('repair_proof_changed');
          expected ??= structuredClone({ runtime, helper });
          return runtime;
        },
      },
    });
    if (!expected) throw Error('repair_proof_required');
    return Object.freeze({
      ...result,
      runtimeSource: expected.runtime.source,
      helperReleaseId: expected.helper.releaseId,
      helperSource: expected.helper.source,
      activation: 'not_performed',
    });
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Only the existing public lock status is retained; private repair diagnostics remain hidden.
    throw Error(
      error instanceof Error && error.message === 'backup_initialization_locked'
        ? 'backup_initialization_locked'
        : 'backup_initialization_repair_unavailable',
    );
  }
}
/** Fixed production composition. Staged code never becomes the active host,
 * and the installed root gateway, credentials and utility remain bound to the
 * verified runtime. There is no caller-supplied source, path or capability. */
export function createBackupInitializationRepairEffects(
  settings: DeploymentSettings,
  invokedHelper: string,
): BackupInitializationRepairEffects {
  let installed: BackupInitializationEffects | undefined;
  const current = () => {
    if (!installed) throw Error('repair_verification_required');
    return installed;
  };
  return {
    async verifyRepair() {
      verifyVaultMemory();
      const proof = await verifyBackupInitializationRepair(settings, targetBinding(settings), invokedHelper);
      installed = createBackupInitializationEffects(
        settings,
        path.join(
          settings.releaseRoot,
          proof.runtime.releaseId,
          'payload/dist/modules/chief-of-staff/ops/target-helper.js',
        ),
      );
      if (digest(await installed.verify()) !== digest(proof.runtime)) throw Error('repair_runtime_changed');
      verifyVaultMemory();
      return proof;
    },
    healthy: () => current().healthy(),
    mount: (guard) => current().mount(guard),
    initialize: (manifest, operationId, guard, check) => current().initialize(manifest, operationId, guard, check),
  };
}
