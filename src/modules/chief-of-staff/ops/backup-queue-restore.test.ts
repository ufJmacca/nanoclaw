import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BackupQueue } from './backup-queue.js';
import { BACKUP_LIMITS } from './backup-policy.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('reserves transport headroom from actual vault free space before allocating a recovery directory', async () => {
  const f = fixture(),
    body = vi.fn(async () => {});
  vi.spyOn(fs, 'statfsSync').mockReturnValue({ bsize: 4096n, bavail: 4096n } as never);
  await expect(f.queue.withRestoreWorkspace(requestId, f.guard, body, 64 * 1024 ** 2)).rejects.toThrow(
    /^backup_restore_workspace_unavailable$/,
  );
  expect(body).not.toHaveBeenCalled();
  expect(fs.readdirSync(f.root + '/state').some((name) => name.startsWith('.cos-restore-'))).toBe(false);
});
const owner = 'a'.repeat(64),
  requestId = '5f74b367-fd8f-449c-a832-dbe40cff9ae3',
  operationId = '9f99d9b4-4dac-423a-956c-afd953993c2d';
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-queue-restore-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  for (const kind of ['state', 'credentials']) fs.mkdirSync(root + '/' + kind, { mode: 0o700 });
  const queue = new BackupQueue(owner, async (kind, operation) => operation(root + '/' + kind)),
    guard = vi.fn();
  return {
    root,
    queue,
    guard,
    restore: <T>(operation: Parameters<typeof queue.withRestoreWorkspace<T>>[2]) =>
      queue.withRestoreWorkspace(requestId, guard, operation),
  };
}
it('holds the actual state queue writer while writing a new isolated sibling and preserves the pending checkpoint', async () => {
  const f = fixture();
  await f.queue.capture('state', operationId, async (sink) => sink.write('current', Buffer.from('PRESERVE')), 65536);
  const before = await f.queue.pending('state');
  const result = await f.restore(async (scope) => {
    const file = await scope.sink.open('recovered', 6);
    await file.write(Buffer.from('secret'));
    await file.close();
    expect(fs.readFileSync(scope.directory + '/recovered', 'utf8')).toBe('secret');
    await expect(
      f.queue.capture(
        'state',
        '3b86ed51-65c3-4a69-9f7d-21e1bf66291f',
        async () => {
          throw Error('must_not_capture');
        },
        65536,
      ),
    ).rejects.toThrow(/^backup_queue_unavailable$/);
    expect(await f.queue.pending('state')).toEqual(before);
    return 'verified';
  });
  expect(result).toBe('verified');
  expect(f.guard).toHaveBeenCalled();
  expect(fs.readdirSync(f.root + '/state')).toEqual(['backup-queue']);
  expect(await f.queue.pending('state')).toEqual(before);
});
it('keeps credential publication independent while the isolated state workspace holds its writer', async () => {
  const f = fixture();
  await f.restore(async (scope) => {
    const file = await scope.sink.open('empty', 0);
    await file.close();
    await f.queue.capture(
      'credentials',
      operationId,
      async (sink) => sink.write('credential', Buffer.from('SYNTHETIC')),
      65536,
    );
    expect(await f.queue.pending('credentials')).toHaveLength(1);
  });
});
it('refuses restore allocation when measured held staging already occupies the common limit', async () => {
  const f = fixture(),
    file = f.root + '/state/held';
  fs.writeFileSync(file, '', { mode: 0o600 });
  fs.truncateSync(file, BACKUP_LIMITS.staging - 1024 ** 2);
  const body = vi.fn(async () => {});
  await expect(f.restore(body)).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
  expect(body).not.toHaveBeenCalled();
  expect(fs.statSync(file).size).toBe(BACKUP_LIMITS.staging - 1024 ** 2);
  expect(fs.readdirSync(f.root + '/state').some((name) => name.startsWith('.cos-restore-'))).toBe(false);
});
it('new full captures count held restore residue elsewhere in staging before invoking the producer', async () => {
  const f = fixture(),
    file = f.root + '/state/held';
  fs.writeFileSync(file, '', { mode: 0o600 });
  fs.truncateSync(file, BACKUP_LIMITS.staging - 1024 ** 2);
  const produce = vi.fn(async (sink) => sink.write('over-limit', Buffer.from('unexpected')));
  await expect(f.queue.capture('state', operationId, produce, 65536)).rejects.toThrow(/^backup_queue_unavailable$/);
  expect(produce).not.toHaveBeenCalled();
  expect(fs.statSync(file).size).toBe(BACKUP_LIMITS.staging - 1024 ** 2);
  expect(fs.existsSync(f.root + '/state/backup-queue/full')).toBe(false);
});
it('requires current caller scope before initializing a queue or new restore namespace', async () => {
  const f = fixture();
  f.guard.mockImplementation(() => {
    throw Error('PRIVATE_WITHDRAWN');
  });
  await expect(f.restore(async () => {})).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
  expect(fs.readdirSync(f.root + '/state')).toEqual([]);
});
it('refuses unsafe staging siblings without adopting or clearing them', async () => {
  const f = fixture();
  fs.symlinkSync(f.root + '/credentials', f.root + '/state/unknown');
  await expect(f.restore(async () => {})).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
  expect(fs.lstatSync(f.root + '/state/unknown').isSymbolicLink()).toBe(true);
});
it('queue pathname replacement withdraws the workspace guard before another payload write', async () => {
  const f = fixture();
  await expect(
    f.restore(async (scope) => {
      fs.renameSync(f.root + '/state/backup-queue', f.root + '/state/original-queue');
      fs.mkdirSync(f.root + '/state/backup-queue', { mode: 0o700 });
      await scope.sink.open('must-not-create', 1);
    }),
  ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
  expect(fs.existsSync(f.root + '/state/.cos-restore-' + requestId + '/must-not-create')).toBe(false);
  expect(fs.existsSync(f.root + '/state/original-queue/owner.json')).toBe(true);
});
it('never treats a saved queue owner change as current restore permission', async () => {
  const f = fixture();
  await expect(
    f.restore(async (scope) => {
      fs.writeFileSync(
        f.root + '/state/backup-queue/owner.json',
        JSON.stringify({ format: 'cos-backup-queue-owner/v1', ownerDigest: 'b'.repeat(64), kind: 'state' }),
      );
      await scope.sink.open('must-not-create', 1);
    }),
  ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
  expect(fs.existsSync(f.root + '/state/.cos-restore-' + requestId + '/must-not-create')).toBe(false);
});
