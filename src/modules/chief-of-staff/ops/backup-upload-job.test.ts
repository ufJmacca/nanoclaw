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
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-upload-job-'));
  fs.chmodSync(base, 0o700);
  cleanup.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = base + '/target',
    manifest = fixtureVaultRelease('G02'),
    requestId = randomUUID();
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
  const invoke = () => uploadBackupJob({ root, binding, requestId, effects });
  return { root, binding, manifest, queues, effects, events, native, requestId, add, invoke };
}
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
