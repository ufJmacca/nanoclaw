import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { BackupQueue, type BackupQueueReceipt } from './backup-queue.js';
import { streamBackupArchive, backupArchiveEntryPrefix } from './backup-archive.js';
import { readBackupArchive } from './backup-archive-reader.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const expected = {
  ownerDigest: 'a'.repeat(64),
  kind: 'state' as const,
  operationId: '9f99d9b4-4dac-423a-956c-afd953993c2d',
};
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-archive-reader-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const queue = new BackupQueue(expected.ownerDigest, async (_kind, callback) => callback(root));
  const longName = 'artifacts/' + 'a'.repeat(64) + '-' + 'b'.repeat(64) + '.blob';
  await queue.capture(
    'state',
    expected.operationId,
    async (sink) => {
      sink.write('coordinated/remote.json', Buffer.from('synthetic-state'));
      sink.write(longName, Buffer.alloc(150000, 0x41));
      sink.write('empty', Buffer.alloc(0));
    },
    262144,
  );
  let receipt!: BackupQueueReceipt;
  const parts: Buffer[] = [];
  await queue.withPending('state', expected.operationId, async (directory, record) => {
    receipt = record;
    await streamBackupArchive(directory, record, async (bytes) => {
      parts.push(Buffer.from(bytes));
    });
  });
  const archive = Buffer.concat(parts),
    files = new Map<string, Buffer[]>(),
    closed: string[] = [],
    guard = vi.fn();
  const sink = {
    open: vi.fn(async (name: string, bytes: number) => {
      expect(bytes).toBe(receipt.files.find((file) => file.name === name)!.bytes);
      files.set(name, []);
      return {
        write: vi.fn(async (chunk: Buffer) => {
          files.get(name)!.push(Buffer.from(chunk));
        }),
        close: vi.fn(async () => {
          closed.push(name);
        }),
      };
    }),
  };
  const borrowed: Buffer[] = [];
  async function* stream(bytes = archive, split = 137) {
    for (let offset = 0; offset < bytes.length; offset += split) {
      const chunk = Buffer.from(bytes.subarray(offset, offset + split));
      borrowed.push(chunk);
      yield chunk;
    }
  }
  const invoke = (bytes = archive) => readBackupArchive(stream(bytes), expected, sink, guard);
  return { archive, receipt, longName, files, closed, sink, guard, borrowed, stream, invoke };
}
it('reads canonical long-name PAX, empty files and fragmented payloads without accumulating a second archive', async () => {
  const f = await fixture(),
    result = await f.invoke();
  expect(result).toMatchObject({
    contract: 'cos-backup-archive-read/v1',
    receipt: f.receipt,
    archiveBytes: f.archive.length,
    archiveSha256: createHash('sha256').update(f.archive).digest('hex'),
  });
  expect(Buffer.concat(f.files.get(f.longName)!)).toEqual(Buffer.alloc(150000, 0x41));
  expect(Buffer.concat(f.files.get('empty')!)).toEqual(Buffer.alloc(0));
  expect(Buffer.concat(f.files.get('coordinated/remote.json')!).toString()).toBe('synthetic-state');
  expect(f.closed.sort()).toEqual(f.receipt.files.map((file) => file.name).sort());
  expect(f.borrowed.every((chunk) => chunk.every((byte) => byte === 0))).toBe(true);
});
it.each(['ownerDigest', 'kind', 'operationId'] as const)(
  'refuses a foreign %s before opening any destination file',
  async (field) => {
    const f = await fixture(),
      foreign = {
        ...expected,
        [field]:
          field === 'kind'
            ? 'credentials'
            : field === 'ownerDigest'
              ? 'b'.repeat(64)
              : '3b86ed51-65c3-4a69-9f7d-21e1bf66291f',
      };
    await expect(readBackupArchive(f.stream(), foreign as typeof expected, f.sink, f.guard)).rejects.toThrow(
      /^backup_archive_read_unavailable$/,
    );
    expect(f.sink.open).not.toHaveBeenCalled();
  },
);
it.each(['traversal', 'duplicate', 'ancestor', 'unknown', 'bytes', 'timestamp'])(
  'refuses %s receipt metadata before opening any destination',
  async (reason) => {
    const f = await fixture(),
      receipt = structuredClone(f.receipt);
    if (reason === 'traversal') receipt.files[0].name = '../escape';
    if (reason === 'duplicate') receipt.files[1] = { ...receipt.files[0] };
    if (reason === 'ancestor') {
      receipt.files[0].name = 'a';
      receipt.files[1].name = 'a/b';
    }
    if (reason === 'unknown') Object.assign(receipt, { unknown: 'private diagnostic sentinel' });
    if (reason === 'bytes') receipt.bytes = 0;
    if (reason === 'timestamp') receipt.createdAt = 'not a date';
    const metadata = Buffer.from(JSON.stringify(receipt) + '\n'),
      oldSize = Buffer.byteLength(JSON.stringify(f.receipt) + '\n');
    const archive = Buffer.concat([
      backupArchiveEntryPrefix('cos-backup-receipt.json', metadata.length, 0),
      metadata,
      Buffer.alloc((512 - (metadata.length % 512)) % 512),
      f.archive.subarray(512 + Math.ceil(oldSize / 512) * 512),
    ]);
    await expect(f.invoke(archive)).rejects.toThrow(/^backup_archive_read_unavailable$/);
    expect(f.sink.open).not.toHaveBeenCalled();
  },
);
it.each(['checksum', 'link', 'pax', 'payload', 'truncated', 'trailing'])(
  'refuses %s corruption and never returns completion',
  async (reason) => {
    const f = await fixture();
    let bytes = Buffer.from(f.archive);
    if (reason === 'checksum') bytes[148] ^= 1;
    if (reason === 'link') bytes[156] = 0x32;
    if (reason === 'pax') bytes[bytes.indexOf(Buffer.from(' path=')) + 6] = 0x2f;
    if (reason === 'payload') bytes[bytes.indexOf(Buffer.alloc(64, 0x41))] ^= 1;
    if (reason === 'truncated') bytes = bytes.subarray(0, -1);
    if (reason === 'trailing') bytes = Buffer.concat([bytes, Buffer.from('extra')]);
    await expect(f.invoke(bytes)).rejects.toThrow(/^backup_archive_read_unavailable$/);
  },
);
it('checks the live caller after awaited input and never invokes a destination after withdrawal', async () => {
  const f = await fixture();
  let open = true;
  const source = (async function* () {
    open = false;
    yield Buffer.from(f.archive.subarray(0, 512));
  })();
  await expect(
    readBackupArchive(source, expected, f.sink, () => {
      if (!open) throw Error('PRIVATE_WITHDRAWAL');
    }),
  ).rejects.toThrow(/^backup_archive_read_unavailable$/);
  expect(f.sink.open).not.toHaveBeenCalled();
});
it('pins the requested identity rather than adopting a caller object changed during an awaited read', async () => {
  const f = await fixture(),
    identity = { ...expected };
  const metadata = Buffer.from(JSON.stringify({ ...f.receipt, ownerDigest: 'b'.repeat(64) }) + '\n'),
    oldSize = Buffer.byteLength(JSON.stringify(f.receipt) + '\n');
  const archive = Buffer.concat([
    backupArchiveEntryPrefix('cos-backup-receipt.json', metadata.length, 0),
    metadata,
    Buffer.alloc((512 - (metadata.length % 512)) % 512),
    f.archive.subarray(512 + Math.ceil(oldSize / 512) * 512),
  ]);
  const source = (async function* () {
    identity.ownerDigest = 'b'.repeat(64);
    yield* f.stream(archive);
  })();
  await expect(readBackupArchive(source, identity, f.sink, f.guard)).rejects.toThrow(
    /^backup_archive_read_unavailable$/,
  );
  expect(f.sink.open).not.toHaveBeenCalled();
});
it('closes an opened isolated file and stops writing after a destination scope is withdrawn', async () => {
  const f = await fixture(),
    close = vi.fn(async () => {});
  let open = true,
    writes = 0;
  f.sink.open.mockImplementation(async () => ({
    write: vi.fn(async () => {
      writes++;
      open = false;
    }),
    close,
  }));
  await expect(
    readBackupArchive(f.stream(), expected, f.sink, () => {
      if (!open) throw Error('PRIVATE_WITHDRAWAL');
    }),
  ).rejects.toThrow(/^backup_archive_read_unavailable$/);
  expect(writes).toBe(1);
  expect(close).toHaveBeenCalledOnce();
});
it('refuses oversized source chunks without trusting transport or diagnostic text', async () => {
  const f = await fixture();
  await expect(
    readBackupArchive(
      (async function* () {
        yield Buffer.alloc(65537);
      })(),
      expected,
      f.sink,
      f.guard,
    ),
  ).rejects.toThrow(/^backup_archive_read_unavailable$/);
  expect(f.sink.open).not.toHaveBeenCalled();
});
it.each(['withdrawn', 'failed'])('does not publish completion after the input close is %s', async (reason) => {
  const f = await fixture(),
    iterator = f.stream()[Symbol.asyncIterator]();
  let open = true;
  const source = {
    [Symbol.asyncIterator]: () => ({
      next: () => iterator.next(),
      async return() {
        await iterator.return(undefined);
        if (reason === 'failed') throw Error('PRIVATE_TRANSPORT_CLOSE');
        open = false;
        return { done: true as const, value: undefined };
      },
    }),
  };
  await expect(
    readBackupArchive(source, expected, f.sink, () => {
      if (!open) throw Error('PRIVATE_WITHDRAWAL');
    }),
  ).rejects.toThrow(/^backup_archive_read_unavailable$/);
});
