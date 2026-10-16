import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { withDeploymentLock } from './deployment-lock.js';
import { admittedGeneration } from './maintenance.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import { readPrivate, readTarget, writeAtomic, type TargetBinding } from './target-state.js';
export type BackupScheduleEffects = {
  verify(): Promise<ReleaseManifest>;
  healthy(): Promise<boolean>;
  capture(requestId: string): Promise<Record<string, unknown>>;
  upload(requestId: string): Promise<Record<string, unknown>>;
  dispatchUpload(): Promise<void>;
};
type ScheduledRequest = {
  contract: 'cos-backup-scheduled-request/v1';
  requestId: string;
  bindingDigest: string;
  manifestDigest: string;
  releaseId: string;
  phase: 'pending' | 'complete';
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
/** A pending marker selects an existing request only. The checkpoint helper
 * must independently verify its recorded operation, live maintenance ownership,
 * installed release and restart health; this marker never reopens admission. */
export async function scheduledBackupJob(input: {
  root: string;
  binding: TargetBinding;
  job: 'capture' | 'upload';
  effects: BackupScheduleEffects;
}): Promise<Record<string, unknown>> {
  try {
    const { root, binding, job, effects } = input;
    if (!['capture', 'upload'].includes(job)) throw Error('backup_schedule_unavailable');
    if (job === 'upload') return await effects.upload(randomUUID());
    return await withDeploymentLock(root + '.backup-schedule.lock', async () => {
      const manifest = validateReleaseManifest(await effects.verify()),
        file = path.join(root, 'backup-scheduled-request.json');
      const assertScope = (reopened: boolean) => {
        const state = readTarget(root, binding);
        if (
          !['G02', 'G03', 'G04'].includes(manifest.slice) ||
          state.lifecycle !== 'protected' ||
          state.releaseId !== manifest.releaseId ||
          (reopened && admittedGeneration(root, binding) === null)
        )
          throw Error('backup_schedule_unavailable');
      };
      const current = async () => {
        assertScope(true);
        if (digest(validateReleaseManifest(await effects.verify())) !== digest(manifest))
          throw Error('backup_schedule_unavailable');
        assertScope(true);
        if (!(await effects.healthy())) throw Error('backup_schedule_unavailable');
        assertScope(true);
      };
      assertScope(false);
      const readMarker = (): ScheduledRequest => {
        const stat = fs.lstatSync(file),
          rootStat = fs.statSync(root);
        if (
          !stat.isFile() ||
          stat.uid !== process.getuid?.() ||
          stat.dev !== rootStat.dev ||
          stat.nlink !== 1 ||
          (stat.mode & 0o7777) !== 0o600 ||
          stat.size < 1 ||
          stat.size > 16384
        )
          throw Error('backup_schedule_unavailable');
        const value = readPrivate<ScheduledRequest>(file, 16384);
        if (
          !value ||
          Object.keys(value).sort().join(',') !== 'bindingDigest,contract,manifestDigest,phase,releaseId,requestId' ||
          value.contract !== 'cos-backup-scheduled-request/v1' ||
          !uuid.test(value.requestId) ||
          value.bindingDigest !== digest(binding) ||
          value.manifestDigest !== digest(manifest) ||
          value.releaseId !== manifest.releaseId ||
          !['pending', 'complete'].includes(value.phase)
        )
          throw Error('backup_schedule_unavailable');
        return value;
      };
      let marker = fs.lstatSync(file, { throwIfNoEntry: false }) ? readMarker() : undefined;
      if (!marker || marker.phase === 'complete') {
        marker = {
          contract: 'cos-backup-scheduled-request/v1',
          requestId: randomUUID(),
          bindingDigest: digest(binding),
          manifestDigest: digest(manifest),
          releaseId: manifest.releaseId,
          phase: 'pending',
        };
        writeAtomic(root, 'backup-scheduled-request.json', marker);
      }
      const selected = marker;
      assertScope(false);
      const reply = await effects.capture(selected.requestId);
      assertScope(false);
      const status = reply?.status;
      if (
        reply?.remoteCheckpoint !== false ||
        !['backup_queued', 'backup_failed', 'backup_skipped_pending'].includes(status as string) ||
        (status === 'backup_skipped_pending'
          ? reply.interrupted !== false || !['pending', 'capturing', 'failed'].includes(reply.pendingState as string)
          : reply.requestId !== selected.requestId ||
            reply.releaseId !== selected.releaseId ||
            reply.admissionRestored !== true)
      )
        throw Error('backup_schedule_unavailable');
      await current();
      if (digest(readMarker()) !== digest(selected)) throw Error('backup_schedule_unavailable');
      selected.phase = 'complete';
      writeAtomic(root, 'backup-scheduled-request.json', selected);
      assertScope(true);
      let uploadDispatched = false;
      try {
        await effects.dispatchUpload();
        uploadDispatched = true;
        // eslint-disable-next-line no-catch-all/no-catch-all -- Local capture completion survives a fixed independent dispatch failure; the hourly timer retries delivery.
      } catch {
        assertScope(true);
      }
      assertScope(true);
      return {
        status: 'backup_schedule_complete',
        requestId: selected.requestId,
        releaseId: selected.releaseId,
        checkpointStatus: status,
        pendingState: status === 'backup_skipped_pending' ? reply.pendingState : null,
        uploadDispatched,
        remoteCheckpoint: false,
      };
    });
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Only fixed busy/unavailable categories may leave the scheduled administration helper.
    throw Error(
      error instanceof Error && error.message === 'target_deployment_locked'
        ? 'backup_schedule_locked'
        : 'backup_schedule_unavailable',
    );
  }
}
