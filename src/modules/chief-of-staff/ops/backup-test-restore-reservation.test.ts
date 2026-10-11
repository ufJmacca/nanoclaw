import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { BACKUP_LIMITS } from './backup-policy.js';
import { withPinnedBackupTestRestoreReservation } from './backup-test-restore-reservation.js';
import type { CoordinatedTestRestoreReservation, CoordinatedTestRestoreStart } from './coordinated-backup.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-restore-reservation-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const binding = {
      requestId: randomUUID(),
      targetDigest: digest('installation'),
      repositoryId: digest('repository'),
      repositoryOwnerDigest: digest('repository owner'),
      queueOwnerDigest: digest('queue owner'),
      operationId: randomUUID(),
      snapshotId: digest('remote snapshot'),
      archiveSha256: digest('archive'),
      archiveBytes: 16384,
      snapshotDigest: digest('full header'),
      checkpointDigest: digest('coordinated receipt'),
      sourceDatabaseFingerprint: digest('source database'),
      scopeId: 'owned-scope',
      journal: { installationDigest: digest('installation'), generation: randomUUID() },
    },
    start: CoordinatedTestRestoreStart = {
      format: 'cos-sandbox-restore-start/v1',
      checkpointDigest: binding.checkpointDigest,
      sandboxDatabaseFingerprint: digest('separate database'),
      testMarkerDigest: digest('test marker'),
      scopeId: binding.scopeId,
      journal: binding.journal,
    },
    guard = vi.fn(),
    file = root + '/.cos-test-restore-' + binding.requestId + '.json';
  const run = async <T>(operation: (port: CoordinatedTestRestoreReservation) => Promise<T>) => {
    const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      return await withPinnedBackupTestRestoreReservation('/proc/self/fd/' + fd, binding, guard, operation);
    } finally {
      fs.closeSync(fd);
    }
  };
  return { root, binding, start, file, guard, run };
}
it('durably retains only the bound live reservation across a failed import and a new held scope', async () => {
  const f = fixture();
  await expect(
    f.run(async (port) => {
      expect(port.read()).toBeUndefined();
      port.create(f.start);
      throw Error('PRIVATE_UNKNOWN_COMMIT');
    }),
  ).rejects.toThrow(/^backup_test_restore_reservation_unavailable$/);
  const before = fs.readFileSync(f.file);
  expect(fs.statSync(f.file).mode & 0o7777).toBe(0o600);
  expect(await f.run(async (port) => port.read())).toEqual(f.start);
  expect(fs.readFileSync(f.file)).toEqual(before);
  expect(fs.readdirSync(f.root)).toEqual([path.basename(f.file)]);
});
it('never converts an ordinary path to held encrypted staging admission', async () => {
  const f = fixture(),
    body = vi.fn();
  await expect(withPinnedBackupTestRestoreReservation(f.root, f.binding, f.guard, body)).rejects.toThrow(
    /^backup_test_restore_reservation_unavailable$/,
  );
  expect(body).not.toHaveBeenCalled();
  expect(fs.readdirSync(f.root)).toEqual([]);
});
it.each([
  'targetDigest',
  'repositoryId',
  'repositoryOwnerDigest',
  'queueOwnerDigest',
  'operationId',
  'snapshotId',
  'archiveSha256',
  'snapshotDigest',
  'checkpointDigest',
  'sourceDatabaseFingerprint',
  'scopeId',
  'journal',
])('holds a previous reservation when current %s no longer matches', async (field) => {
  const f = fixture();
  await f.run(async (port) => port.create(f.start));
  const before = fs.readFileSync(f.file);
  if (field === 'journal') f.binding.journal.generation = randomUUID();
  else if (field === 'operationId') f.binding.operationId = randomUUID();
  else if (field === 'scopeId') f.binding.scopeId = 'foreign';
  else Object.assign(f.binding, { [field]: digest('foreign binding') });
  const body = vi.fn();
  await expect(f.run(body)).rejects.toThrow(/^backup_test_restore_reservation_unavailable$/);
  expect(body).not.toHaveBeenCalled();
  expect(fs.readFileSync(f.file)).toEqual(before);
});
it.each(['checkpoint', 'journal', 'same-database', 'scope', 'extra-key'])(
  'refuses an unbound %s start before creating a durable file',
  async (kind) => {
    const f = fixture();
    if (kind === 'checkpoint') f.start.checkpointDigest = digest('foreign');
    if (kind === 'journal') f.start.journal = { ...f.start.journal, generation: randomUUID() };
    if (kind === 'same-database') f.start.sandboxDatabaseFingerprint = f.binding.sourceDatabaseFingerprint;
    if (kind === 'scope') f.start.scopeId = 'foreign';
    if (kind === 'extra-key') Object.assign(f.start, { archivedPermission: true });
    await expect(f.run(async (port) => port.create(f.start))).rejects.toThrow(
      /^backup_test_restore_reservation_unavailable$/,
    );
    expect(fs.existsSync(f.file)).toBe(false);
  },
);
it.each(['link', 'hardlink', 'mode', 'partial'])(
  'refuses a %s collision without adopting or clearing it',
  async (kind) => {
    const f = fixture(),
      source = f.root + '/foreign';
    fs.writeFileSync(source, 'PRIVATE_COLLISION', { mode: 0o600 });
    if (kind === 'link') fs.symlinkSync(source, f.file);
    if (kind === 'hardlink') fs.linkSync(source, f.file);
    if (kind === 'mode') fs.writeFileSync(f.file, '{}', { mode: 0o644 });
    if (kind === 'partial') fs.writeFileSync(f.file, '{', { mode: 0o600 });
    await expect(f.run(async (port) => port.read())).rejects.toThrow(/^backup_test_restore_reservation_unavailable$/);
    expect(fs.lstatSync(f.file)).toBeDefined();
    expect(fs.readFileSync(source, 'utf8')).toBe('PRIVATE_COLLISION');
  },
);
it.each(['content', 'inode', 'caller', 'binding'])(
  'withdraws the held reservation on awaited %s changes',
  async (kind) => {
    const f = fixture();
    await f.run(async (port) => port.create(f.start));
    await expect(
      f.run(async (port) => {
        await Promise.resolve();
        if (kind === 'content') fs.appendFileSync(f.file, 'PRIVATE_CHANGED');
        if (kind === 'inode') {
          fs.renameSync(f.file, f.file + '.held');
          fs.writeFileSync(f.file, '{}', { mode: 0o600 });
        }
        if (kind === 'caller')
          f.guard.mockImplementation(() => {
            throw Error('PRIVATE_WITHDRAWN');
          });
        if (kind === 'binding') f.binding.archiveSha256 = digest('changed');
        return port.read();
      }),
    ).rejects.toThrow(/^backup_test_restore_reservation_unavailable$/);
    expect(fs.existsSync(f.file)).toBe(true);
  },
);
it('expires borrowed reservation methods and refuses a second creation', async () => {
  const f = fixture();
  let borrowed: CoordinatedTestRestoreReservation | undefined;
  await f.run(async (port) => {
    borrowed = port;
    port.create(f.start);
    expect(() => port.create(f.start)).toThrow();
  });
  expect(() => borrowed!.read()).toThrow(/^backup_test_restore_reservation_unavailable$/);
  expect(() => borrowed!.assertCurrent()).toThrow(/^backup_test_restore_reservation_unavailable$/);
});
it.each(['limit', 'free'])('refuses exhausted measured staging %s before publishing a start record', async (kind) => {
  const f = fixture();
  if (kind === 'limit') {
    fs.writeFileSync(f.root + '/held', '', { mode: 0o600 });
    fs.truncateSync(f.root + '/held', BACKUP_LIMITS.staging);
  }
  if (kind === 'free') vi.spyOn(fs, 'statfsSync').mockReturnValue({ bsize: 4096n, bavail: 1n } as never);
  await expect(f.run(async (port) => port.create(f.start))).rejects.toThrow(
    /^backup_test_restore_reservation_unavailable$/,
  );
  expect(fs.existsSync(f.file)).toBe(false);
});
