import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { digest } from '../domain/contracts.js';
import { initializeTarget, protectTarget, readPrivate, readTarget, writeAtomic } from './target-state.js';
import { scheduledBackupJob } from './backup-scheduled-job.js';
import { checkpointMaintenance } from './checkpoint-maintenance.js';
import { withDeploymentLock } from './deployment-lock.js';
import { admittedGeneration, maintenanceLeaseForOwner } from './maintenance.js';
import { BackupQueue } from './backup-queue.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(slice: 'G02' | 'G03' | 'G04' = 'G02') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-backup-schedule-'));
  roots.push(base);
  fs.chmodSync(base, 0o700);
  const root = base + '/state',
    manifest = fixtureVaultRelease(slice);
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    installationRoot: base + '/app',
    dataRoot: base + '/app/data',
  };
  const initial = initializeTarget(root, binding);
  writeAtomic(root, 'state.json', { ...initial, releaseId: manifest.releaseId, maintenance: false });
  const state = protectTarget(root, binding);
  writeAtomic(root, 'maintenance.json', {
    version: 1,
    bindingDigest: digest(binding),
    nonce: randomUUID(),
    owner: 'fixture-release',
    purpose: 'deployment',
    generation: state.generation,
    phase: 'complete',
    reopen: true,
  });
  writeAtomic(root, 'state.json', {
    ...state,
    maintenance: false,
    maintenanceHistory: true,
    generation: state.generation + 1,
  });
  const events: string[] = [];
  const effects = {
    verify: vi.fn(async () => manifest),
    healthy: vi.fn(async () => true),
    capture: vi.fn(async (requestId: string): Promise<Record<string, unknown>> => {
      events.push('capture');
      return {
        status: 'backup_queued',
        requestId,
        releaseId: manifest.releaseId,
        admissionRestored: true,
        remoteCheckpoint: false,
      };
    }),
    upload: vi.fn(async (requestId: string) => {
      events.push('upload');
      return { status: 'backup_upload_idle', requestId };
    }),
    dispatchUpload: vi.fn(async () => {
      events.push('dispatch');
    }),
  };
  const invoke = (job: 'capture' | 'upload' = 'capture') => scheduledBackupJob({ root, binding, job, effects });
  return { root, manifest, binding, effects, invoke, events };
}
it.each(['G02', 'G03', 'G04'] as const)(
  '%s reconciles the same maintenance lease after interrupted stop, captures once and dispatches after restart',
  async (slice) => {
    const f = fixture(slice);
    fs.mkdirSync(f.root + '/queue-area', { mode: 0o700 });
    const queue = new BackupQueue('a'.repeat(64), async (_kind, callback) => callback(f.root + '/queue-area'));
    const ports = {
      verify: f.effects.verify,
      healthy: f.effects.healthy,
      workersIdle: async () => true,
      nativeStopped: async () => true,
      databaseCompatible: async () => true,
      stopNative: vi.fn(async () => {
        f.events.push('stop');
      }),
      startNative: vi.fn(async () => {
        f.events.push('restart');
      }),
      inspect: () => queue.inspect('state'),
      capture: vi.fn(async (lease: { nonce: string }) => {
        f.events.push('capture');
        await queue.capture(
          'state',
          lease.nonce,
          async (sink) => sink.write('fixture.json', Buffer.from('synthetic')),
          65536,
        );
        return {
          status: 'queued' as const,
          queueOperationId: lease.nonce,
          snapshotDigest: digest((await queue.inspect('state'))[0]),
        };
      }),
      verifyCapture: async (lease: { nonce: string }) =>
        queue.withPending('state', lease.nonce, async (_data, receipt) => ({
          status: 'queued' as const,
          queueOperationId: lease.nonce,
          snapshotDigest: digest(receipt),
        })),
    };
    ports.stopNative.mockRejectedValueOnce(Error('interrupted stop'));
    f.effects.capture.mockImplementation((requestId) =>
      withDeploymentLock(f.root + '.operation.lock', () =>
        checkpointMaintenance({ root: f.root, binding: f.binding, requestId, effects: ports }),
      ),
    );
    await expect(f.invoke()).rejects.toThrow('backup_schedule_unavailable');
    const marker = readPrivate<{ requestId: string }>(f.root + '/backup-scheduled-request.json'),
      held = maintenanceLeaseForOwner(f.root, f.binding, 'release-backup-' + marker.requestId, 'deployment');
    expect(held.owner).toBe('release-backup-' + marker.requestId);
    expect(f.effects.dispatchUpload).not.toHaveBeenCalled();
    await expect(f.invoke()).resolves.toMatchObject({
      checkpointStatus: 'backup_queued',
      requestId: marker.requestId,
      uploadDispatched: true,
    });
    expect(ports.capture).toHaveBeenCalledOnce();
    expect(ports.capture.mock.calls[0][0].nonce).toBe(held.nonce);
    expect(f.events).toEqual(['stop', 'capture', 'restart', 'dispatch']);
    expect(admittedGeneration(f.root, f.binding)).not.toBeNull();
    expect((await queue.pending('state')).map((item) => item.operationId)).toEqual([held.nonce]);
  },
);
it('durably selects a checkpoint ID before capture and dispatches upload only after healthy admission', async () => {
  const f = fixture();
  f.effects.capture.mockImplementationOnce(async (requestId) => {
    expect(readPrivate(f.root + '/backup-scheduled-request.json')).toMatchObject({ phase: 'pending', requestId });
    expect(f.effects.dispatchUpload).not.toHaveBeenCalled();
    return {
      status: 'backup_queued',
      requestId,
      releaseId: f.manifest.releaseId,
      admissionRestored: true,
      remoteCheckpoint: false,
    };
  });
  const result = await f.invoke();
  expect(result).toMatchObject({
    status: 'backup_schedule_complete',
    checkpointStatus: 'backup_queued',
    uploadDispatched: true,
    remoteCheckpoint: false,
  });
  expect(readPrivate(f.root + '/backup-scheduled-request.json')).toMatchObject({
    phase: 'complete',
    requestId: result.requestId,
  });
  expect(f.effects.healthy).toHaveBeenCalled();
  expect(f.effects.upload).not.toHaveBeenCalled();
});
it('reuses an interrupted checkpoint ID instead of creating a second interruption', async () => {
  const f = fixture();
  f.effects.capture.mockRejectedValueOnce(Error('interrupted'));
  await expect(f.invoke()).rejects.toThrow('backup_schedule_unavailable');
  const pending = readPrivate<{ requestId: string }>(f.root + '/backup-scheduled-request.json');
  await f.invoke();
  expect(f.effects.capture.mock.calls.map(([id]) => id)).toEqual([pending.requestId, pending.requestId]);
  expect(f.effects.dispatchUpload).toHaveBeenCalledOnce();
});
it('starts a new scheduled ID only after the previous checkpoint is durably complete', async () => {
  const f = fixture();
  const first = await f.invoke(),
    next = await f.invoke();
  expect(first.requestId).not.toBe(next.requestId);
  expect(f.effects.capture).toHaveBeenCalledTimes(2);
});
it('keeps a completed local checkpoint when the independent upload dispatch fails', async () => {
  const f = fixture();
  f.effects.dispatchUpload.mockRejectedValueOnce(Error('PRIVATE_TRANSPORT'));
  const result = await f.invoke();
  expect(result).toMatchObject({
    status: 'backup_schedule_complete',
    uploadDispatched: false,
    remoteCheckpoint: false,
  });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(readPrivate(f.root + '/backup-scheduled-request.json')).toMatchObject({ phase: 'complete' });
});
it('hourly uploads use new job IDs, with no checkpoint, marker or dispatch capability', async () => {
  const f = fixture();
  await f.invoke('upload');
  await f.invoke('upload');
  expect(f.effects.upload).toHaveBeenCalledTimes(2);
  expect(f.effects.upload.mock.calls[0][0]).not.toBe(f.effects.upload.mock.calls[1][0]);
  expect(f.effects.capture).not.toHaveBeenCalled();
  expect(f.effects.dispatchUpload).not.toHaveBeenCalled();
  expect(fs.existsSync(f.root + '/backup-scheduled-request.json')).toBe(false);
});
it.each(['unhealthy', 'admission_closed', 'wrong_reply', 'changed_release'] as const)(
  'keeps the pending marker and does not dispatch on %s',
  async (reason) => {
    const f = fixture();
    if (reason === 'unhealthy') f.effects.healthy.mockResolvedValue(false);
    if (reason === 'wrong_reply')
      f.effects.capture.mockImplementationOnce(async () => ({
        status: 'backup_queued',
        requestId: randomUUID(),
        releaseId: f.manifest.releaseId,
        admissionRestored: true,
        remoteCheckpoint: false,
      }));
    if (reason === 'admission_closed' || reason === 'changed_release')
      f.effects.capture.mockImplementationOnce(async (requestId) => {
        writeAtomic(f.root, 'state.json', {
          ...readTarget(f.root, f.binding),
          ...(reason === 'admission_closed' ? { maintenance: true } : { releaseId: 'release-other' }),
        });
        return {
          status: 'backup_queued',
          requestId,
          releaseId: f.manifest.releaseId,
          admissionRestored: true,
          remoteCheckpoint: false,
        };
      });
    await expect(f.invoke()).rejects.toThrow('backup_schedule_unavailable');
    expect(readPrivate(f.root + '/backup-scheduled-request.json')).toMatchObject({ phase: 'pending' });
    expect(f.effects.dispatchUpload).not.toHaveBeenCalled();
  },
);
it('rejects unknown marker fields, unsafe files and an old release marker without overwriting evidence', async () => {
  const f = fixture();
  f.effects.capture.mockRejectedValueOnce(Error('interrupted'));
  await expect(f.invoke()).rejects.toThrow();
  const file = f.root + '/backup-scheduled-request.json',
    original = fs.readFileSync(file);
  const value = JSON.parse(original.toString());
  for (const replacement of [
    { ...value, authority: true },
    { ...value, releaseId: 'release-other' },
  ]) {
    writeAtomic(f.root, 'backup-scheduled-request.json', replacement);
    const before = fs.readFileSync(file);
    await expect(f.invoke()).rejects.toThrow('backup_schedule_unavailable');
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  }
  fs.writeFileSync(file, original);
  fs.chmodSync(file, 0o644);
  await expect(f.invoke()).rejects.toThrow('backup_schedule_unavailable');
  expect(fs.readFileSync(file).equals(original)).toBe(true);
  expect(f.effects.capture).toHaveBeenCalledOnce();
});
