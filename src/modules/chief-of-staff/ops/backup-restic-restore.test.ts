import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { backupRepositoryHost, backupSnapshotTags } from './backup-retention.js';
import { BackupQueue } from './backup-queue.js';
import { streamBackupArchive } from './backup-archive.js';
const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) =>
      args[0] === '/usr/bin/flock' ? Reflect.apply(actual.spawn, undefined, args) : mocked.spawn(...args),
  };
});
import { BackupResticTransfer } from './backup-restic-transfer.js';
const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const owner = 'a'.repeat(64),
  queueOwner = 'b'.repeat(64),
  repo = 'd'.repeat(64),
  operationId = '9f99d9b4-4dac-423a-956c-afd953993c2d';
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-restic-restore-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const queue = new BackupQueue(queueOwner, async (_kind, callback) => callback(root));
  await queue.capture(
    'state',
    operationId,
    async (sink) => sink.write('native/state.db', Buffer.alloc(150000, 0x41)),
    262144,
  );
  const parts: Buffer[] = [];
  await queue.withPending('state', operationId, async (directory, receipt) =>
    streamBackupArchive(directory, receipt, async (bytes) => {
      parts.push(Buffer.from(bytes));
    }),
  );
  const archive = Buffer.concat(parts),
    commands: string[][] = [],
    borrowed: Buffer[] = [],
    files = new Map<string, Buffer[]>(),
    scope = vi.fn(),
    admit = vi.fn(async () => {}),
    close = vi.fn(async () => {}),
    write = vi.fn(async (bytes: Buffer) => {
      await Promise.resolve();
      files.get('native/state.db')!.push(Buffer.from(bytes));
    });
  const sink = {
    open: vi.fn(async (name: string) => {
      files.set(name, []);
      return { write, close };
    }),
  };
  let respond: ((command: string[]) => unknown) | undefined,
    dumpCode = 0;
  mocked.spawn.mockImplementation((_file, args) => {
    const command = args.slice(7) as string[];
    commands.push(command);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: undefined,
    });
    queueMicrotask(() => {
      let response = respond?.(command);
      if (response === undefined) {
        if (command[0] === 'cat') response = { version: 2, id: repo, chunker_polynomial: '3da3358b4dc173' };
        if (command[0] === 'snapshots')
          response = [
            {
              id: 'c'.repeat(64),
              time: '2026-10-11T03:30:00+11:00',
              hostname: backupRepositoryHost(owner),
              paths: ['/checkpoint.tar'],
              tags: backupSnapshotTags(owner, 'state', operationId),
            },
          ];
        if (command[0] === 'dump') response = archive;
      }
      const bytes = Buffer.isBuffer(response) ? Buffer.from(response) : Buffer.from(JSON.stringify(response));
      borrowed.push(bytes);
      child.stdout.end(bytes);
      child.stderr.end();
      child.emit('close', command[0] === 'dump' ? dumpCode : 0, null);
    });
    return child;
  });
  const transfer = new BackupResticTransfer({
    binary: { fd: 3, assertCurrent: scope } as never,
    password: { fd: 4, assertCurrent: scope } as never,
    repository: { fd: 5, assertCurrent: scope },
    cache: { fd: 6, assertCurrent: scope },
    writer: { assertCurrent: scope },
    repositoryId: repo,
    ownerDigest: owner,
    producer: () => {
      throw Error('must_not_capture');
    },
    admitUpload: async () => {
      throw Error('must_not_upload');
    },
  });
  return {
    archive,
    commands,
    files,
    borrowed,
    sink,
    close,
    write,
    scope,
    admit,
    transfer,
    invoke: () => transfer.restore('state', operationId, queueOwner, sink, admit),
    respond: (fn: typeof respond) => {
      respond = fn;
    },
    failDump: () => {
      dumpCode = 1;
    },
  };
}
it('streams authenticated remote bytes through the canonical reader with awaited writes and no archive file', async () => {
  const f = await fixture(),
    result = await f.invoke();
  expect(result).toMatchObject({
    contract: 'cos-backup-remote-restore/v1',
    repositoryId: repo,
    ownerDigest: owner,
    kind: 'state',
    operationId,
    snapshotId: 'c'.repeat(64),
    archiveBytes: f.archive.length,
    receipt: { ownerDigest: queueOwner, operationId, kind: 'state' },
  });
  expect(Buffer.concat(f.files.get('native/state.db')!)).toEqual(Buffer.alloc(150000, 0x41));
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.write.mock.calls.length).toBeGreaterThan(2);
  expect(f.commands.find((args) => args[0] === 'dump')).toEqual(['dump', 'c'.repeat(64), 'checkpoint.tar']);
  expect(f.commands.every((args) => ['cat', 'snapshots', 'dump'].includes(args[0]))).toBe(true);
  expect(f.borrowed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
});
it.each(['missing', 'ambiguous', 'foreign_host', 'foreign_path', 'extra_tag', 'wrong_repository'])(
  'refuses %s metadata before opening a destination',
  async (reason) => {
    const f = await fixture();
    f.respond((command) => {
      if (reason === 'wrong_repository' && command[0] === 'cat')
        return { version: 2, id: 'e'.repeat(64), chunker_polynomial: '3da3358b4dc173' };
      if (command[0] !== 'snapshots') return undefined;
      const snapshot = {
        id: 'c'.repeat(64),
        time: '2026-10-11T03:30:00+11:00',
        hostname: backupRepositoryHost(owner),
        paths: ['/checkpoint.tar'],
        tags: backupSnapshotTags(owner, 'state', operationId),
      };
      if (reason === 'missing') return [];
      if (reason === 'ambiguous') return [snapshot, snapshot];
      if (reason === 'foreign_host') snapshot.hostname = 'foreign';
      if (reason === 'foreign_path') snapshot.paths = ['/other'];
      if (reason === 'extra_tag') snapshot.tags.push('cos-owner=' + 'e'.repeat(64));
      return [snapshot];
    });
    await expect(f.invoke()).rejects.toThrow(/^backup_restore_unavailable$/);
    expect(f.sink.open).not.toHaveBeenCalled();
    expect(f.commands.some((args) => args[0] === 'dump')).toBe(false);
  },
);
it('refuses a foreign queue receipt even when the encrypted repository and snapshot tags match', async () => {
  const f = await fixture();
  await expect(f.transfer.restore('state', operationId, 'e'.repeat(64), f.sink, f.admit)).rejects.toThrow(
    /^backup_restore_unavailable$/,
  );
  expect(f.sink.open).not.toHaveBeenCalled();
});
it('refuses withdrawn capacity before starting any command', async () => {
  const f = await fixture();
  f.admit.mockRejectedValueOnce(Error('PRIVATE_CAPACITY_WITHDRAWN'));
  await expect(f.invoke()).rejects.toThrow(/^backup_restore_unavailable$/);
  expect(f.commands).toEqual([]);
});
it('rechecks capacity after awaited repository identity before starting the archive command', async () => {
  const f = await fixture();
  let dumpIdentity = false;
  f.respond((args) => {
    if (args[0] === 'cat' && f.commands.some((command) => command[0] === 'snapshots')) dumpIdentity = true;
  });
  f.admit.mockImplementation(async () => {
    if (dumpIdentity) throw Error('PRIVATE_CAPACITY_WITHDRAWN');
  });
  await expect(f.invoke()).rejects.toThrow(/^backup_restore_unavailable$/);
  expect(f.commands.some((args) => args[0] === 'dump')).toBe(false);
  expect(f.sink.open).not.toHaveBeenCalled();
});
it('withdrawn permission during an awaited sink write closes the file and denies completion', async () => {
  const f = await fixture();
  f.write.mockImplementationOnce(async () => {
    f.scope.mockImplementation(() => {
      throw Error('PRIVATE_WITHDRAWN');
    });
  });
  await expect(f.invoke()).rejects.toThrow(/^backup_restore_unavailable$/);
  expect(f.write).toHaveBeenCalledOnce();
  expect(f.close).toHaveBeenCalledOnce();
});
it('a failed archive subprocess denies completion even after all payload bytes arrive', async () => {
  const f = await fixture();
  f.failDump();
  await expect(f.invoke()).rejects.toThrow(/^backup_restore_unavailable$/);
  expect(f.close).toHaveBeenCalledOnce();
});
it('checks admission after the private stream closes before returning recovery evidence', async () => {
  const f = await fixture();
  f.close.mockImplementationOnce(async () => {
    f.admit.mockRejectedValue(Error('PRIVATE_WITHDRAWN'));
  });
  await expect(f.invoke()).rejects.toThrow(/^backup_restore_unavailable$/);
});
it('refuses an unbound selection without commands or destination writes', async () => {
  const f = await fixture();
  await expect(f.transfer.restore('state', '../other', queueOwner, f.sink, f.admit)).rejects.toThrow(
    /^backup_restore_unavailable$/,
  );
  expect(f.commands).toEqual([]);
  expect(f.sink.open).not.toHaveBeenCalled();
});
