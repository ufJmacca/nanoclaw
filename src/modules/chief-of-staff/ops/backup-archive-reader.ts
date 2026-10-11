import { createHash } from 'node:crypto';
import type { BackupKind } from './backup-policy.js';
import { BACKUP_LIMITS } from './backup-policy.js';
import type { BackupQueueReceipt } from './backup-queue.js';
import { backupArchiveEntryPrefix, backupArchiveReceiptPrefix } from './backup-archive.js';
export type BackupArchiveIdentity = { ownerDigest: string; kind: BackupKind; operationId: string };
export type BackupArchiveRestoreSink = {
  open(name: string, bytes: number): Promise<{ write(bytes: Buffer): Promise<void>; close(): Promise<void> }>;
};
export type BackupArchiveReadResult = {
  contract: 'cos-backup-archive-read/v1';
  receipt: BackupQueueReceipt;
  archiveBytes: number;
  archiveSha256: string;
};
class Reader {
  private chunk: Buffer = Buffer.alloc(0);
  private offset = 0;
  private readonly iterator: AsyncIterator<Buffer>;
  private readonly hash = createHash('sha256');
  bytes = 0;
  constructor(
    source: AsyncIterable<Buffer>,
    private readonly maximum: number,
    private readonly guard: () => void,
  ) {
    this.iterator = source[Symbol.asyncIterator]();
  }
  private async fill(): Promise<boolean> {
    this.guard();
    if (this.offset < this.chunk.length) return true;
    this.chunk.fill(0);
    this.chunk = Buffer.alloc(0);
    this.offset = 0;
    const next = await this.iterator.next();
    try {
      this.guard();
      if (next.done) return false;
      if (!Buffer.isBuffer(next.value) || next.value.length < 1 || next.value.length > 65536)
        throw Error('archive_chunk_bounds');
      this.chunk = next.value;
      return true;
    } catch (error) {
      if (Buffer.isBuffer(next.value)) next.value.fill(0);
      throw error;
    }
  }
  async consume(size: number, use: (chunk: Buffer) => Promise<void>): Promise<void> {
    if (!Number.isSafeInteger(size) || size < 0 || this.bytes + size > this.maximum) throw Error('archive_bounds');
    let remaining = size;
    while (remaining) {
      if (!(await this.fill())) throw Error('archive_truncated');
      const length = Math.min(remaining, this.chunk.length - this.offset),
        chunk = this.chunk.subarray(this.offset, this.offset + length);
      try {
        this.guard();
        this.hash.update(chunk);
        this.bytes += length;
        this.offset += length;
        remaining -= length;
        await use(chunk);
        this.guard();
      } finally {
        chunk.fill(0);
      }
    }
  }
  async read(size: number): Promise<Buffer> {
    if (size > 1024 ** 2) throw Error('archive_metadata_bounds');
    const bytes = Buffer.alloc(size);
    let offset = 0;
    try {
      await this.consume(size, async (chunk) => {
        chunk.copy(bytes, offset);
        offset += chunk.length;
      });
      return bytes;
    } catch (error) {
      bytes.fill(0);
      throw error;
    }
  }
  async match(expected: Buffer): Promise<void> {
    const actual = await this.read(expected.length);
    try {
      if (!actual.equals(expected)) throw Error('archive_framing_changed');
    } finally {
      actual.fill(0);
    }
  }
  async padding(size: number): Promise<void> {
    const bytes = Buffer.alloc((512 - (size % 512)) % 512);
    try {
      await this.match(bytes);
    } finally {
      bytes.fill(0);
    }
  }
  async complete(): Promise<string> {
    if (await this.fill()) throw Error('archive_trailing_data');
    this.guard();
    return this.hash.digest('hex');
  }
  async close(): Promise<void> {
    this.chunk.fill(0);
    const returned = await this.iterator.return?.();
    if (Buffer.isBuffer(returned?.value)) returned.value.fill(0);
  }
}
function receiptIdentity(receipt: BackupQueueReceipt, expected: BackupArchiveIdentity): void {
  if (
    !receipt ||
    Object.keys(receipt).sort().join(',') !==
      'bytes,createdAt,files,format,kind,maximumBytes,operationId,ownerDigest,state' ||
    receipt.ownerDigest !== expected.ownerDigest ||
    receipt.kind !== expected.kind ||
    receipt.operationId !== expected.operationId ||
    typeof receipt.createdAt !== 'string' ||
    receipt.createdAt.length > 40 ||
    !Number.isFinite(Date.parse(receipt.createdAt)) ||
    !Array.isArray(receipt.files) ||
    receipt.files.some((file) => !file || Object.keys(file).sort().join(',') !== 'bytes,name,sha256') ||
    receipt.files.reduce((sum, file) => sum + file.bytes, 0) > receipt.bytes
  )
    throw Error('archive_receipt_changed');
  const names = new Set(receipt.files.map((file) => file.name));
  for (const name of names) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++)
      if (names.has(parts.slice(0, i).join('/'))) throw Error('archive_path_conflict');
  }
}
/** Canonical application archives only. The trusted caller supplies a fresh
 * isolated vault sink and permission/capacity guard. Data reaches only declared
 * files, never live paths. Returned metadata is evidence, not restored authority.
 * Borrowed input and payload buffers are consumed and wiped after awaited use. */
export async function readBackupArchive(
  source: AsyncIterable<Buffer>,
  expected: BackupArchiveIdentity,
  sink: BackupArchiveRestoreSink,
  assertCurrent: () => void,
): Promise<BackupArchiveReadResult> {
  let reader: Reader | undefined, metadata: Buffer | undefined, first: Buffer | undefined, prefix: Buffer | undefined;
  let result: BackupArchiveReadResult | undefined,
    failed = false;
  try {
    expected = Object.freeze({ ...expected });
    if (
      !expected ||
      Object.keys(expected).sort().join(',') !== 'kind,operationId,ownerDigest' ||
      !/^[a-f0-9]{64}$/.test(expected.ownerDigest) ||
      !['state', 'credentials'].includes(expected.kind) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(expected.operationId) ||
      typeof assertCurrent !== 'function' ||
      typeof sink?.open !== 'function'
    )
      throw Error('archive_reader_scope_required');
    assertCurrent();
    reader = new Reader(
      source,
      (expected.kind === 'state' ? BACKUP_LIMITS.staging : BACKUP_LIMITS.credentials) + 2 * 1024 ** 2,
      assertCurrent,
    );
    first = await reader.read(512);
    const field = first.subarray(124, 136).toString('latin1');
    if (!/^[0-7]{11}\0$/.test(field)) throw Error('archive_metadata_size');
    const size = Number.parseInt(field.slice(0, -1), 8);
    if (size < 1 || size > 1024 ** 2) throw Error('archive_metadata_bounds');
    metadata = await reader.read(size);
    const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata)) as BackupQueueReceipt;
    prefix = backupArchiveReceiptPrefix(receipt);
    receiptIdentity(receipt, expected);
    if (!first.equals(prefix.subarray(0, 512)) || !metadata.equals(prefix.subarray(512)))
      throw Error('archive_receipt_framing');
    await reader.padding(size);
    const files = [...receipt.files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const [index, item] of files.entries()) {
      const framing = backupArchiveEntryPrefix('payload/' + item.name, item.bytes, index + 1);
      try {
        await reader.match(framing);
      } finally {
        framing.fill(0);
      }
      let file: Awaited<ReturnType<BackupArchiveRestoreSink['open']>> | undefined;
      try {
        assertCurrent();
        file = await sink.open(item.name, item.bytes);
        assertCurrent();
        if (typeof file?.write !== 'function' || typeof file.close !== 'function')
          throw Error('archive_file_scope_required');
        const hash = createHash('sha256');
        await reader.consume(item.bytes, async (chunk) => {
          hash.update(chunk);
          await file!.write(chunk);
        });
        if (hash.digest('hex') !== item.sha256) throw Error('archive_file_changed');
        await reader.padding(item.bytes);
        assertCurrent();
      } finally {
        if (typeof file?.close === 'function') await file.close();
      }
    }
    await reader.match(Buffer.alloc(1024));
    const archiveSha256 = await reader.complete();
    assertCurrent();
    result = { contract: 'cos-backup-archive-read/v1', receipt, archiveBytes: reader.bytes, archiveSha256 };
    // eslint-disable-next-line no-catch-all/no-catch-all -- Untrusted diagnostics are collapsed after buffers and the private input transport are closed.
  } catch {
    failed = true;
  } finally {
    metadata?.fill(0);
    first?.fill(0);
    prefix?.fill(0);
    try {
      await reader?.close();
      if (!failed) assertCurrent();
      // eslint-disable-next-line no-catch-all/no-catch-all -- Failure to close the private transport invalidates completion and reports only the fixed category below.
    } catch {
      failed = true;
    }
  }
  if (failed || !result) throw Error('backup_archive_read_unavailable');
  return result;
}
