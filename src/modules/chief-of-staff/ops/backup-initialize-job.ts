import { performance } from 'node:perf_hooks';
import { digest } from '../domain/contracts.js';
import { withDeploymentLock } from './deployment-lock.js';
import { admittedGeneration } from './maintenance.js';
import { readTarget, type TargetBinding } from './target-state.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import type { DeploymentSettings } from './deployment-settings.js';
import { createBackupUploadJobEffects } from './backup-upload-job-effects.js';
import { initializeVaultBackups } from './backup-initialize.js';
export type BackupInitializationEffects = {
  verify(): Promise<ReleaseManifest>;
  healthy(): Promise<boolean>;
  mount(assertCurrent: () => void): Promise<void>;
  initialize(
    manifest: ReleaseManifest,
    operationId: string,
    assertCurrent: () => void,
    check: () => Promise<void>,
  ): Promise<Record<string, unknown>>;
};
/** Owner-only independent job. It takes the upload/retention lock, never the
 * checkpoint/maintenance lock; no service interruption or native pause occurs. */
export async function initializeBackupJob(input: {
  root: string;
  binding: TargetBinding;
  requestId: string;
  effects: BackupInitializationEffects;
}): Promise<Record<string, unknown>> {
  try {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.requestId))
      throw Error('initialization_request_required');
    return await withDeploymentLock(input.root + '.backup-upload.lock', async () => {
      const manifest = validateReleaseManifest(await input.effects.verify()),
        state = readTarget(input.root, input.binding),
        generation = admittedGeneration(input.root, input.binding),
        deadline = performance.now() + 30 * 60 * 1000;
      if (
        manifest.slice !== 'G02' ||
        !manifest.vaultArtifact ||
        state.lifecycle !== 'protected' ||
        state.releaseId !== manifest.releaseId ||
        generation === null
      )
        throw Error('initialization_admission_required');
      const assertCurrent = () => {
        const selected = readTarget(input.root, input.binding);
        if (
          performance.now() >= deadline ||
          selected.lifecycle !== 'protected' ||
          selected.releaseId !== manifest.releaseId ||
          admittedGeneration(input.root, input.binding) !== generation
        )
          throw Error('initialization_admission_changed');
      };
      const check = async () => {
        assertCurrent();
        if (digest(validateReleaseManifest(await input.effects.verify())) !== digest(manifest))
          throw Error('initialization_release_changed');
        assertCurrent();
        if (!(await input.effects.healthy())) throw Error('initialization_service_unhealthy');
        assertCurrent();
      };
      await check();
      await input.effects.mount(assertCurrent);
      await check();
      const result = await input.effects.initialize(manifest, input.requestId, assertCurrent, check);
      await check();
      if (
        !result ||
        Object.keys(result).sort().join(',') !==
          'bindingDigest,contract,operationId,repositoryId,repositoryVersion,status' ||
        result.contract !== 'cos-backup-repository-initialization-result/v1' ||
        result.repositoryVersion !== 2 ||
        !['backup_repository_initialized', 'backup_repository_bound'].includes(String(result.status)) ||
        ['bindingDigest', 'repositoryId'].some(
          (key) => typeof result[key] !== 'string' || !/^[a-f0-9]{64}$/.test(result[key] as string),
        ) ||
        typeof result.operationId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(result.operationId)
      )
        throw Error('initialization_receipt_conflict');
      return Object.freeze({ ...result, requestId: input.requestId, releaseId: manifest.releaseId });
    });
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Fixed job/lock status only; no storage, credential or utility diagnostics leave this boundary.
    throw Error(
      error instanceof Error && error.message === 'target_deployment_locked'
        ? 'backup_initialization_locked'
        : 'backup_repository_initialization_unavailable',
    );
  }
}
/** Default installed ports carry no credential, mount or scope override. */
export function createBackupInitializationEffects(
  settings: DeploymentSettings,
  invokedHelper: string,
): BackupInitializationEffects {
  const upload = createBackupUploadJobEffects(settings, invokedHelper),
    roots = {
      targetRoot: settings.stateRoot,
      installationRoot: settings.installationRoot,
      dataRoot: settings.dataRoot,
    };
  return {
    verify: () => upload.verify(),
    healthy: () => upload.healthy(),
    mount: (guard) => upload.mount(guard),
    initialize: (manifest, operationId, assertCurrent, check) =>
      initializeVaultBackups({ roots, manifest, operationId, assertCurrent, check }),
  };
}
