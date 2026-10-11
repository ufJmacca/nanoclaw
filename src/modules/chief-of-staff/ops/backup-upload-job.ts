import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { digest } from '../domain/contracts.js';
import { BACKUP_LIMITS, type BackupKind } from './backup-policy.js';
import type { BackupDeliveryItem, BackupDeliveryObservation } from './backup-queue.js';
import { withDeploymentLock } from './deployment-lock.js';
import { admittedGeneration } from './maintenance.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import { readTarget, writeAtomic, type TargetBinding } from './target-state.js';
export type BackupUploadJobEffects = {
  verify(): Promise<ReleaseManifest>;
  healthy(): Promise<boolean>;
  inspect(kind: BackupKind): Promise<BackupDeliveryObservation>;
  reconcile(kind: BackupKind, assertCurrent: () => void): Promise<unknown>;
  mount(assertCurrent: () => void): Promise<void>;
  upload(kind: BackupKind, operationId: string, assertCurrent: () => void): Promise<unknown>;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const kinds = ['state', 'credentials'] as const;
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
function observation(value: BackupDeliveryObservation, kind: BackupKind): BackupDeliveryObservation {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !['items,lastRemoteCheckpointAt', 'items,lastAcknowledgedCaptureAt,lastRemoteCheckpointAt'].includes(
      Object.keys(value).sort().join(','),
    ) ||
    !Array.isArray(value.items) ||
    value.items.length > (kind === 'state' ? 1 : 1025) ||
    (value.lastRemoteCheckpointAt !== null && !timestamp(value.lastRemoteCheckpointAt)) ||
    (value.lastAcknowledgedCaptureAt != null && !timestamp(value.lastAcknowledgedCaptureAt))
  )
    throw Error('backup_upload_job_unavailable');
  const ids = new Set<string>();
  for (const item of value.items) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(',') !== 'bytes,createdAt,disposition,kind,operationId' ||
      item.kind !== kind ||
      !uuid.test(item.operationId) ||
      ids.has(item.operationId) ||
      !['upload', 'reconcile', 'held'].includes(item.disposition) ||
      !timestamp(item.createdAt) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 0 ||
      item.bytes > BACKUP_LIMITS[kind === 'state' ? 'staging' : 'credentials']
    )
      throw Error('backup_upload_job_unavailable');
    ids.add(item.operationId);
  }
  if (value.items.filter((item) => item.disposition === 'reconcile').length > 1)
    throw Error('backup_upload_job_unavailable');
  return structuredClone(value);
}
function backlog(value: BackupDeliveryObservation) {
  const pending = value.items.filter((item) => item.disposition !== 'held');
  return {
    pending: pending.length,
    held: value.items.length - pending.length,
    bytes: value.items.reduce((sum, item) => sum + item.bytes, 0),
    oldestPendingAt: pending.length
      ? pending.map((item) => item.createdAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0]
      : null,
    lastRemoteCheckpointAt: value.lastRemoteCheckpointAt,
    lastAcknowledgedCaptureAt: value.lastAcknowledgedCaptureAt ?? null,
  };
}
/** Independent background job: no service stop/start, native pause, capture,
 * credential refresh, model call or target operation lock. Saved status and
 * delivery observations never authorize retirement; the uploader obtains fresh
 * vault, repository, complete archive and original receipt proofs itself. */
export async function uploadBackupJob(input: {
  root: string;
  binding: TargetBinding;
  requestId: string;
  effects: BackupUploadJobEffects;
}): Promise<Record<string, unknown>> {
  try {
    const { root, binding, requestId, effects } = input;
    if (!uuid.test(requestId) || !path.isAbsolute(root) || path.resolve(root) !== root)
      throw Error('backup_upload_job_unavailable');
    return await withDeploymentLock(root + '.backup-upload.lock', async () => {
      const manifest = validateReleaseManifest(await effects.verify()),
        state = readTarget(root, binding),
        generation = admittedGeneration(root, binding),
        deadline = performance.now() + 45 * 60 * 1000;
      if (
        manifest.slice !== 'G02' ||
        state.lifecycle !== 'protected' ||
        state.releaseId !== manifest.releaseId ||
        generation === null
      )
        throw Error('backup_upload_job_unavailable');
      const assertScope = () => {
        const current = readTarget(root, binding);
        if (
          current.lifecycle !== 'protected' ||
          current.releaseId !== state.releaseId ||
          admittedGeneration(root, binding) !== generation
        )
          throw Error('backup_upload_job_unavailable');
      };
      const assertCurrent = () => {
        assertScope();
        if (performance.now() >= deadline) throw Error('backup_upload_job_unavailable');
      };
      const healthy = async () => {
        assertCurrent();
        if (digest(validateReleaseManifest(await effects.verify())) !== digest(manifest))
          throw Error('backup_upload_job_unavailable');
        assertCurrent();
        if (!(await effects.healthy())) throw Error('backup_upload_job_unavailable');
        assertCurrent();
      };
      const inspect = async () => {
        const values = {} as Record<BackupKind, BackupDeliveryObservation>;
        for (const kind of kinds) {
          assertScope();
          values[kind] = observation(await effects.inspect(kind), kind);
          assertScope();
        }
        return values;
      };
      await healthy();
      for (const kind of kinds) {
        await healthy();
        try {
          await effects.reconcile(kind, assertCurrent);
          // eslint-disable-next-line no-catch-all/no-catch-all -- An unverifiable copy remains held; separate pending work can continue only under fresh scope and healthy release checks.
        } catch {
          assertCurrent();
        }
        await healthy();
      }
      let values = await inspect(),
        uploaded = 0;
      const save = (status: string) => {
        assertScope();
        const result = {
          contract: 'cos-backup-upload-job/v1',
          status,
          requestId,
          releaseId: manifest.releaseId,
          bindingDigest: digest(binding),
          observedAt: new Date().toISOString(),
          uploaded,
          state: backlog(values.state),
          credentials: backlog(values.credentials),
        };
        writeAtomic(root, 'backup-upload-status.json', result);
        assertScope();
        return result;
      };
      const selected = kinds
        .flatMap((kind) => values[kind].items)
        .filter((item) => item.disposition !== 'held')
        .sort(
          (a: BackupDeliveryItem, b: BackupDeliveryItem) =>
            Number(b.disposition === 'reconcile') - Number(a.disposition === 'reconcile') ||
            Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
            a.kind.localeCompare(b.kind) ||
            a.operationId.localeCompare(b.operationId),
        );
      if (!selected.length)
        return save(kinds.some((kind) => values[kind].items.length) ? 'backup_upload_held' : 'backup_upload_idle');
      save('backup_upload_running');
      let failed = false;
      try {
        await healthy();
        await effects.mount(assertCurrent);
        assertCurrent();
        for (const item of selected) {
          await healthy();
          await effects.upload(item.kind, item.operationId, assertCurrent);
          assertCurrent();
          uploaded++;
        }
        // eslint-disable-next-line no-catch-all/no-catch-all -- Report only the fixed failed status; fresh scope and queue inspection must still pass, and retirement supplies its own proof.
      } catch {
        assertScope();
        failed = true;
      }
      values = await inspect();
      return save(failed ? 'backup_upload_failed' : 'backup_uploaded');
    });
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Only the fixed lock category may leave this trusted background job.
    throw Error(
      error instanceof Error && error.message === 'target_deployment_locked'
        ? 'backup_upload_locked'
        : 'backup_upload_job_unavailable',
    );
  }
}
