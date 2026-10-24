import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { digest } from '../domain/contracts.js';
import { initializeTarget, protectTarget, readPrivate, readTarget, writeAtomic } from './target-state.js';
import { withDeploymentLock } from './deployment-lock.js';
import type { BackupKind } from './backup-policy.js';
import type { BackupDeliveryItem, BackupDeliveryObservation } from './backup-queue.js';
import { BackupQueue } from './backup-queue.js';
import { uploadBackupJob } from './backup-upload-job.js';
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture(slice: 'G02' | 'G03' | 'G04' | 'G05' = 'G02') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-upload-job-'));
  fs.chmodSync(base, 0o700);
  cleanup.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = base + '/target',
    manifest = fixtureVaultRelease(slice),
    requestId = randomUUID();
  manifest.slice = slice;
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    installationRoot: base + '/app',
    dataRoot: base + '/app/data',
  };
  const state = initializeTarget(root, binding);
  writeAtomic(root, 'state.json', { ...state, releaseId: manifest.releaseId, maintenance: false });
  const protectedState = protectTarget(root, binding);
  writeAtomic(root, 'maintenance.json', {
    version: 1,
    bindingDigest: digest(binding),
    nonce: randomUUID(),
    owner: 'fixture-release',
    purpose: 'deployment',
    generation: protectedState.generation,
    phase: 'complete',
    reopen: true,
  });
  writeAtomic(root, 'state.json', {
    ...protectedState,
    maintenance: false,
    maintenanceHistory: true,
    generation: protectedState.generation + 1,
  });
  const native = new Database(base + '/native.sqlite');
  cleanup.push(() => native.close());
  native.exec(
    "CREATE TABLE state(paused INTEGER,context TEXT,used INTEGER); INSERT INTO state VALUES(0,'main-context',3); CREATE TABLE messages(body TEXT); INSERT INTO messages VALUES('ordinary-message');",
  );
  const queues: Record<BackupKind, BackupDeliveryObservation> = {
    state: { items: [], lastRemoteCheckpointAt: null },
    credentials: { items: [], lastRemoteCheckpointAt: null },
  };
  const events: string[] = [];
  const effects = {
    verify: vi.fn(async () => manifest),
    healthy: vi.fn(async () => true),
    inspect: vi.fn(async (kind: BackupKind) => structuredClone(queues[kind])),
    reconcile: vi.fn(async (_kind: BackupKind, assertCurrent: () => void) => {
      assertCurrent();
    }),
    mount: vi.fn(async (assertCurrent: () => void) => {
      assertCurrent();
      events.push('mount');
    }),
    upload: vi.fn(async (kind: BackupKind, id: string, assertCurrent: () => void) => {
      assertCurrent();
      events.push(kind + ':' + id);
      queues[kind].items = queues[kind].items.filter((item) => item.operationId !== id);
      queues[kind].lastRemoteCheckpointAt = '2026-10-11T00:00:00Z';
    }),
    maintain: vi.fn(async (assertCurrent: () => void) => {
      assertCurrent();
      return {
        contract: 'cos-backup-repository-maintenance/v1' as const,
        status: 'backup_repository_maintained' as const,
        repositoryId: 'c'.repeat(64),
        ownerDigest: 'd'.repeat(64),
        state: { retained: 1, removed: 0 },
        credentials: { retained: 1, removed: 0 },
        integrity: 'verified' as const,
      };
    }),
    journalCredentials: vi.fn(async (_scope: { releaseId: string; generation: number }, assertCurrent: () => void) => {
      assertCurrent();
      events.push('journal');
      return {
        contract: 'cos-credential-recovery-page/v1' as const,
        ownerDigest: 'd'.repeat(64),
        status: 'recorded' as const,
        recorded: 0,
        next_after: null,
        open_checks: 0,
      };
    }),
    captureCredentials: vi.fn(async (_cycleAt: string, assertCurrent: () => void) => {
      assertCurrent();
      events.push('complete');
      return {
        contract: 'cos-backup-remote-checkpoint/v1' as const,
        repositoryId: 'c'.repeat(64),
        ownerDigest: 'd'.repeat(64),
        kind: 'credentials' as const,
        operationId: randomUUID(),
        snapshotId: 'e'.repeat(64),
        snapshotAt: new Date().toISOString(),
        archiveBytes: 16384,
        archiveSha256: 'f'.repeat(64),
        reconciled: false,
        verifiedAt: new Date().toISOString(),
      };
    }),
  };
  const add = (
    kind: BackupKind,
    disposition: BackupDeliveryItem['disposition'] = 'upload',
    createdAt = '2026-10-10T00:00:00Z',
  ) => {
    const item: BackupDeliveryItem = { kind, operationId: randomUUID(), disposition, createdAt, bytes: 5 };
    queues[kind].items.push(item);
    return item.operationId;
  };
  const invoke = (mode?: 'deliver' | 'maintain') => uploadBackupJob({ root, binding, requestId, effects, mode });
  return { root, binding, manifest, queues, effects, events, native, requestId, add, invoke };
}
it.each(['G04', 'G05'] as const)(
  '%s drains existing work, journals a bounded page, delivers newly queued changes, then verifies a complete capture',
  async (slice) => {
    const f = fixture(slice),
      first = f.add('credentials');
    let next!: string;
    f.effects.journalCredentials.mockImplementation(async (_scope, guard) => {
      guard();
      f.events.push('journal');
      next = f.add('credentials');
      return {
        contract: 'cos-credential-recovery-page/v1',
        ownerDigest: 'd'.repeat(64),
        status: 'recorded',
        recorded: 1,
        next_after: null,
        open_checks: 0,
      };
    });
    const before = f.native.prepare('SELECT * FROM state').get();
    const result = await f.invoke();
    expect(f.events).toEqual(['mount', 'credentials:' + first, 'journal', 'credentials:' + next, 'complete']);
    expect(result).toMatchObject({
      contract: 'cos-backup-upload-job/v2',
      status: 'backup_uploaded',
      uploaded: 3,
      credentialJournal: { status: 'recorded', recorded: 1 },
      completeCredentials: { status: 'verified', lastSnapshotAt: expect.any(String) },
    });
    expect(f.effects.maintain).toHaveBeenCalledOnce();
    expect(f.native.prepare('SELECT * FROM state').get()).toEqual(before);
    expect(f.native.prepare('SELECT body FROM messages').get()).toEqual({ body: 'ordinary-message' });
  },
);
it('G04 creates a current complete capture even when both legacy queues are empty', async () => {
  const f = fixture('G04');
  expect(await f.invoke()).toMatchObject({
    status: 'backup_uploaded',
    uploaded: 1,
    completeCredentials: { status: 'verified' },
  });
  expect(f.events).toEqual(['mount', 'journal', 'complete']);
});
it('G04 queues local journal work during a NAS outage while preserving the last verified complete capture age', async () => {
  const f = fixture('G04');
  await f.invoke();
  const previous = readPrivate<Record<string, unknown>>(f.root + '/backup-upload-status.json');
  f.effects.mount.mockRejectedValue(Error('PRIVATE_NAS_OUTAGE'));
  f.effects.journalCredentials.mockImplementation(async (_scope, guard) => {
    guard();
    f.events.push('journal');
    f.add('credentials');
    return {
      contract: 'cos-credential-recovery-page/v1',
      ownerDigest: 'd'.repeat(64),
      status: 'recorded',
      recorded: 1,
      next_after: null,
      open_checks: 0,
    };
  });
  const result = await f.invoke();
  expect(result).toMatchObject({
    status: 'backup_upload_failed',
    credentialJournal: { status: 'recorded', recorded: 1 },
    credentials: { pending: 1 },
    completeCredentials: {
      status: 'not_attempted',
      lastSnapshotAt: (previous.completeCredentials as Record<string, unknown>).lastSnapshotAt,
    },
  });
  expect(f.effects.captureCredentials).toHaveBeenCalledOnce();
});
it('G04 drains pending uploads before a full local journal can deny new page work', async () => {
  const f = fixture('G04'),
    first = f.add('credentials');
  f.effects.journalCredentials.mockImplementation(async () => {
    f.events.push('journal');
    throw Error('PRIVATE_QUEUE_FULL');
  });
  expect(await f.invoke()).toMatchObject({
    status: 'backup_uploaded_journal_held',
    uploaded: 2,
    credentialJournal: { status: 'failed', recorded: null },
    completeCredentials: { status: 'verified' },
  });
  expect(f.events).toEqual(['mount', 'credentials:' + first, 'journal', 'complete']);
});
it('G04 does not prune after complete-capture failure and retains prior success times', async () => {
  const f = fixture('G04');
  await f.invoke();
  f.effects.captureCredentials.mockRejectedValue(Error('PRIVATE_PRODUCER_CHANGED'));
  f.effects.maintain.mockClear();
  expect(await f.invoke()).toMatchObject({
    status: 'backup_upload_failed',
    completeCredentials: { status: 'failed', lastSnapshotAt: expect.any(String) },
  });
  expect(f.effects.maintain).not.toHaveBeenCalled();
});
it('G04 maintain-only mode never collects a page or creates another capture', async () => {
  const f = fixture('G04');
  expect(await f.invoke('maintain')).toMatchObject({ status: 'backup_maintenance_verified' });
  expect(f.effects.journalCredentials).not.toHaveBeenCalled();
  expect(f.effects.captureCredentials).not.toHaveBeenCalled();
});
it.each(['G04', 'G05'] as const)(
  '%s requires installed page and capture ports instead of silently behaving like G03',
  async (slice) => {
    const f = fixture(slice);
    Object.assign(f.effects, { captureCredentials: undefined });
    await expect(f.invoke()).rejects.toThrow('backup_upload_job_unavailable');
    expect(f.effects.mount).not.toHaveBeenCalled();
  },
);
it('G04 rejects malformed completion evidence and closes an escaped job guard after return', async () => {
  const f = fixture('G04');
  let escaped!: () => void;
  f.effects.captureCredentials.mockImplementation(async (_cycleAt, guard) => {
    escaped = guard;
    return {
      contract: 'cos-backup-remote-checkpoint/v1',
      repositoryId: 'c'.repeat(64),
      ownerDigest: 'd'.repeat(64),
      kind: 'credentials',
      operationId: randomUUID(),
      snapshotId: 'e'.repeat(64),
      snapshotAt: 'invalid',
      archiveBytes: 16384,
      archiveSha256: 'f'.repeat(64),
      reconciled: false,
      verifiedAt: new Date().toISOString(),
    };
  });
  expect(await f.invoke()).toMatchObject({
    status: 'backup_upload_failed',
    completeCredentials: { status: 'failed', lastSnapshotAt: null },
  });
  expect(f.effects.maintain).not.toHaveBeenCalled();
  expect(() => escaped()).toThrow('backup_upload_job_unavailable');
});
it.each(['G04', 'G05'] as const)(
  '%s preserves a later owner pause, consumed attempts and the shared main context during capture',
  async (slice) => {
    const f = fixture(slice),
      capture = f.effects.captureCredentials.getMockImplementation()!;
    f.effects.captureCredentials.mockImplementation(async (...args) => {
      f.native.prepare('UPDATE state SET paused=1,used=4').run();
      return capture(...args);
    });
    expect(await f.invoke()).toMatchObject({ status: 'backup_uploaded', completeCredentials: { status: 'verified' } });
    expect(f.native.prepare('SELECT * FROM state').get()).toEqual({ paused: 1, context: 'main-context', used: 4 });
    expect(f.native.prepare('SELECT body FROM messages').get()).toEqual({ body: 'ordinary-message' });
  },
);
it.each(['G02', 'G03'] as const)(
  '%s performs daily integrity and retention after delivery, retaining the verified time across idle runs',
  async (slice) => {
    const f = fixture(slice);
    f.add('state');
    expect(await f.invoke()).toMatchObject({
      status: 'backup_uploaded',
      maintenance: { status: 'verified', lastVerifiedAt: expect.any(String) },
    });
    expect(f.effects.maintain).toHaveBeenCalledOnce();
    const recorded = readPrivate<{ verifiedAt: string }>(f.root + '/backup-maintenance-status.json');
    expect(await f.invoke()).toMatchObject({
      status: 'backup_upload_idle',
      maintenance: { lastVerifiedAt: recorded.verifiedAt },
    });
    f.add('credentials');
    expect(await f.invoke()).toMatchObject({ maintenance: { status: 'not_due', lastVerifiedAt: recorded.verifiedAt } });
    expect(f.effects.maintain).toHaveBeenCalledOnce();
  },
);
it('permits an owner integrity check with an empty queue under the independent uploader lock', async () => {
  const f = fixture(),
    before = f.native.serialize();
  expect(await f.invoke('maintain')).toMatchObject({
    status: 'backup_maintenance_verified',
    uploaded: 0,
    maintenance: { status: 'verified' },
  });
  expect(f.effects.mount).toHaveBeenCalledOnce();
  expect(f.effects.maintain).toHaveBeenCalledOnce();
  expect(f.effects.upload).not.toHaveBeenCalled();
  expect(f.effects.reconcile).not.toHaveBeenCalled();
  expect(f.native.serialize().equals(before)).toBe(true);
});
it('protects pending remote reconciliation from an owner retention request', async () => {
  const f = fixture();
  f.add('credentials', 'reconcile');
  expect(await f.invoke('maintain')).toMatchObject({
    status: 'backup_maintenance_held',
    maintenance: { status: 'held' },
  });
  expect(f.effects.mount).not.toHaveBeenCalled();
  expect(f.effects.maintain).not.toHaveBeenCalled();
});
it('reports failed integrity separately after successful delivery without recording verification or exposing diagnostics', async () => {
  const f = fixture();
  f.add('state');
  f.effects.maintain.mockRejectedValueOnce(Error('PRIVATE_REPOSITORY_DATA'));
  const result = await f.invoke();
  expect(result).toMatchObject({
    status: 'backup_uploaded_maintenance_failed',
    uploaded: 1,
    maintenance: { status: 'failed', lastVerifiedAt: null },
    state: { pending: 0 },
  });
  expect(fs.existsSync(f.root + '/backup-maintenance-status.json')).toBe(false);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
it('checks new integrity after 24 hours and refuses changed target admission during maintenance', async () => {
  const f = fixture();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-10-11T00:00:00Z');
  await f.invoke('maintain');
  vi.setSystemTime('2026-10-12T00:00:01Z');
  f.add('state');
  expect(await f.invoke()).toMatchObject({ maintenance: { status: 'verified' } });
  expect(f.effects.maintain).toHaveBeenCalledTimes(2);
  f.effects.maintain.mockImplementationOnce(async (guard) => {
    writeAtomic(f.root, 'state.json', { ...readTarget(f.root, f.binding), maintenance: true });
    guard();
    throw Error('unreachable');
  });
  await expect(f.invoke('maintain')).rejects.toThrow('backup_upload_job_unavailable');
});
it('does not use a future or another release verification to defer a fresh check', async () => {
  const f = fixture();
  writeAtomic(f.root, 'backup-maintenance-status.json', {
    contract: 'cos-backup-maintenance-status/v1',
    releaseId: f.manifest.releaseId,
    bindingDigest: digest(f.binding),
    verifiedAt: '2099-01-01T00:00:00Z',
  });
  f.add('state');
  expect(await f.invoke()).toMatchObject({ maintenance: { status: 'verified' } });
  expect(f.effects.maintain).toHaveBeenCalledOnce();
  writeAtomic(f.root, 'backup-maintenance-status.json', {
    contract: 'cos-backup-maintenance-status/v1',
    releaseId: 'release-another',
    bindingDigest: digest(f.binding),
    verifiedAt: new Date().toISOString(),
  });
  f.add('state');
  await f.invoke();
  expect(f.effects.maintain).toHaveBeenCalledTimes(2);
});
it('recovers local captures before observing delivery, then uploads recovered pending work', async () => {
  const f = fixture(),
    id = f.add('state', 'held'),
    before = f.native.serialize();
  f.effects.inspect.mockImplementation(async (kind) => {
    expect(f.effects.reconcile).toHaveBeenCalledWith(kind, expect.any(Function));
    return structuredClone(f.queues[kind]);
  });
  f.effects.reconcile.mockImplementation(async (kind, assertCurrent) => {
    assertCurrent();
    f.queues[kind].items.forEach((item) => {
      item.disposition = 'upload';
    });
  });
  expect(await f.invoke()).toMatchObject({ status: 'backup_uploaded', uploaded: 1, state: { held: 0, pending: 0 } });
  expect(f.effects.upload).toHaveBeenCalledWith('state', id, expect.any(Function));
  expect(f.native.serialize().equals(before)).toBe(true);
});
it('retains unverifiable local captures while continuing delivery of separate pending work', async () => {
  const f = fixture();
  f.add('state', 'held');
  f.add('credentials');
  f.effects.reconcile.mockImplementation(async (kind, assertCurrent) => {
    assertCurrent();
    if (kind === 'state') throw Error('PRIVATE_COPY_CONFLICT');
  });
  expect(await f.invoke()).toMatchObject({ status: 'backup_uploaded', uploaded: 1, state: { held: 1 } });
  expect(f.effects.reconcile).toHaveBeenCalledTimes(2);
});
it('refuses withdrawn admission during local recovery before observing or mounting', async () => {
  const f = fixture();
  f.effects.reconcile.mockImplementationOnce(async (_kind, assertCurrent) => {
    writeAtomic(f.root, 'state.json', { ...readTarget(f.root, f.binding), maintenance: true });
    assertCurrent();
  });
  await expect(f.invoke()).rejects.toThrow('backup_upload_job_unavailable');
  expect(f.effects.inspect).not.toHaveBeenCalled();
  expect(f.effects.mount).not.toHaveBeenCalled();
});
it('reports capture age without treating a later upload as newer captured data', async () => {
  const f = fixture();
  Object.assign(f.queues.state, {
    lastAcknowledgedCaptureAt: '2026-10-01T00:00:00Z',
    lastRemoteCheckpointAt: '2026-10-11T00:00:00Z',
  });
  expect(await f.invoke()).toMatchObject({
    state: { lastAcknowledgedCaptureAt: '2026-10-01T00:00:00Z', lastRemoteCheckpointAt: '2026-10-11T00:00:00Z' },
  });
});
it('stops starting work after the job deadline and records the retained backlog under still-current admission', async () => {
  const f = fixture();
  f.add('state');
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  f.effects.mount.mockImplementationOnce(async () => {
    clock.mockReturnValue(45 * 60 * 1000);
  });
  expect(await f.invoke()).toMatchObject({ status: 'backup_upload_failed', uploaded: 0, state: { pending: 1 } });
  expect(f.effects.upload).not.toHaveBeenCalled();
});
it('checks a healthy protected release, but avoids the NAS for an empty or held-only queue', async () => {
  const f = fixture();
  expect(await f.invoke()).toMatchObject({
    status: 'backup_upload_idle',
    uploaded: 0,
    state: { pending: 0, held: 0, oldestPendingAt: null },
  });
  f.add('state', 'held');
  expect(await f.invoke()).toMatchObject({ status: 'backup_upload_held', uploaded: 0, state: { pending: 0, held: 1 } });
  expect(f.effects.mount).not.toHaveBeenCalled();
  expect(f.effects.upload).not.toHaveBeenCalled();
  expect(f.effects.healthy).toHaveBeenCalled();
});
it.each([0, 1])(
  'uploads in stable order, reconciling the original IDs first without changing native pause=%s',
  async (paused) => {
    const f = fixture();
    f.native.prepare('UPDATE state SET paused=?').run(paused);
    const before = f.native.serialize();
    const state = f.add('state'),
      ready = f.add('credentials'),
      reconcile = f.add('credentials', 'reconcile', '2026-10-11T00:00:00Z');
    f.add('credentials', 'held');
    const result = await f.invoke();
    expect(result).toMatchObject({
      status: 'backup_uploaded',
      uploaded: 3,
      credentials: { held: 1, pending: 0, lastRemoteCheckpointAt: '2026-10-11T00:00:00Z' },
    });
    expect(f.events[0]).toBe('mount');
    expect(f.events[1]).toBe('credentials:' + reconcile);
    expect(f.events.slice(2).sort()).toEqual(['state:' + state, 'credentials:' + ready].sort());
    expect(f.native.serialize().equals(before)).toBe(true);
    expect(readPrivate(f.root + '/backup-upload-status.json')).toMatchObject(result);
  },
);
it('retains backlog and reports only a fixed failure when the NAS is unavailable', async () => {
  const f = fixture();
  const id = f.add('credentials');
  f.effects.mount.mockRejectedValueOnce(Error('PRIVATE_NAS_PASSWORD_AND_ENDPOINT'));
  const result = await f.invoke();
  expect(result).toMatchObject({
    status: 'backup_upload_failed',
    uploaded: 0,
    credentials: { pending: 1, oldestPendingAt: '2026-10-10T00:00:00Z' },
  });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(f.queues.credentials.items[0].operationId).toBe(id);
  expect(f.effects.upload).not.toHaveBeenCalled();
});
it('records partial progress without acknowledging a failed later snapshot', async () => {
  const f = fixture();
  f.add('state');
  const failed = f.add('credentials', 'upload', '2026-10-11T00:00:00Z');
  f.effects.upload
    .mockImplementationOnce(async (kind) => {
      f.queues[kind].items = [];
    })
    .mockRejectedValueOnce(Error('private remote failure'));
  expect(await f.invoke()).toMatchObject({
    status: 'backup_upload_failed',
    uploaded: 1,
    state: { pending: 0 },
    credentials: { pending: 1 },
  });
  expect(f.queues.credentials.items[0].operationId).toBe(failed);
});
it('holds its own real kernel lock while leaving deployment and capture free to proceed', async () => {
  const f = fixture();
  f.add('state');
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      resume = resolve;
    });
  f.effects.mount.mockImplementationOnce(async () => {
    enter();
    await ready;
  });
  const running = f.invoke();
  await entered;
  try {
    await expect(f.invoke()).rejects.toThrow('backup_upload_locked');
    await expect(withDeploymentLock(f.root + '.operation.lock', async () => 42)).resolves.toBe(42);
  } finally {
    resume();
  }
  await running;
});
it('permits actual credential publication during a NAS wait and reports newly queued work after retiring the original ID', async () => {
  const f = fixture();
  for (const kind of ['state', 'credentials']) fs.mkdirSync(f.root + '/' + kind, { mode: 0o700 });
  const queue = new BackupQueue('a'.repeat(64), async (kind, callback) => callback(f.root + '/' + kind));
  const first = randomUUID(),
    next = randomUUID();
  await queue.capture('credentials', first, async (sink) => sink.write('first.json', Buffer.from('fixture')), 65536);
  f.effects.inspect.mockImplementation((kind) => queue.inspectDelivery(kind));
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      resume = resolve;
    });
  f.effects.mount.mockImplementationOnce(async () => {
    enter();
    await ready;
  });
  f.effects.upload.mockImplementation(async (kind, id, assertCurrent) => {
    await queue.retirePending(kind, id, async ({ receipt, archive }) => ({
      assertCurrent,
      checkpoint: {
        contract: 'cos-backup-remote-checkpoint/v1',
        repositoryId: 'b'.repeat(64),
        ownerDigest: 'c'.repeat(64),
        kind: receipt.kind,
        operationId: receipt.operationId,
        snapshotId: 'd'.repeat(64),
        snapshotAt: '2026-10-11T00:00:00Z',
        archiveBytes: archive.bytes,
        archiveSha256: archive.sha256,
        reconciled: false,
        verifiedAt: new Date().toISOString(),
      },
    }));
  });
  const running = f.invoke();
  await entered;
  try {
    await expect(
      queue.capture('credentials', next, async (sink) => sink.write('next.json', Buffer.from('fixture')), 65536),
    ).resolves.toMatchObject({ status: 'queued' });
  } finally {
    resume();
  }
  expect(await running).toMatchObject({ status: 'backup_uploaded', uploaded: 1, credentials: { pending: 1 } });
  expect((await queue.pending('credentials')).map((item) => item.operationId)).toEqual([next]);
  expect(f.effects.upload.mock.calls.map((call) => call[1])).toEqual([first]);
});
it.each(['mount', 'health', 'upload'] as const)('refuses changed maintenance after the %s await', async (stage) => {
  const f = fixture();
  f.add('state');
  const close = () => {
    writeAtomic(f.root, 'state.json', { ...readTarget(f.root, f.binding), maintenance: true });
  };
  if (stage === 'mount')
    f.effects.mount.mockImplementationOnce(async () => {
      close();
    });
  if (stage === 'health')
    f.effects.healthy.mockImplementationOnce(async () => {
      close();
      return true;
    });
  if (stage === 'upload')
    f.effects.upload.mockImplementationOnce(async (_kind, _id, assertCurrent) => {
      close();
      assertCurrent();
    });
  await expect(f.invoke()).rejects.toThrow('backup_upload_job_unavailable');
  expect(f.queues.state.items).toHaveLength(1);
});
it('checks health before mounting and refuses malformed observation without any NAS action', async () => {
  const f = fixture();
  f.add('state');
  f.effects.healthy.mockResolvedValue(false);
  await expect(f.invoke()).rejects.toThrow('backup_upload_job_unavailable');
  expect(f.effects.mount).not.toHaveBeenCalled();
  f.effects.healthy.mockResolvedValue(true);
  f.queues.state.items[0].disposition = 'delete' as never;
  await expect(f.invoke()).rejects.toThrow('backup_upload_job_unavailable');
  expect(f.effects.mount).not.toHaveBeenCalled();
});
it('refuses stale helper release, closed admission, and invented job IDs before mounting', async () => {
  const f = fixture();
  f.add('state');
  f.effects.verify.mockResolvedValue({ ...f.manifest, releaseId: 'release-other' });
  await expect(f.invoke()).rejects.toThrow('backup_upload_job_unavailable');
  f.effects.verify.mockResolvedValue(f.manifest);
  writeAtomic(f.root, 'state.json', { ...readTarget(f.root, f.binding), maintenance: true });
  await expect(f.invoke()).rejects.toThrow('backup_upload_job_unavailable');
  expect(f.effects.mount).not.toHaveBeenCalled();
  await expect(
    uploadBackupJob({ root: f.root, binding: f.binding, requestId: 'latest', effects: f.effects }),
  ).rejects.toThrow('backup_upload_job_unavailable');
});
