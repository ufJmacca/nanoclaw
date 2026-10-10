import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type { BackupSnapshotSink } from './backup-queue.js';

export type NativeSnapshotReceipt = {
  format: 'cos-native-snapshot/v1';
  source: string;
  file: string;
  bytes: number;
  sha256: string;
  at: string;
};
function sameFile(before: fs.Stats, after: fs.Stats): void {
  if (before.dev !== after.dev || before.ino !== after.ino || before.uid !== after.uid)
    throw Error('native_source_changed');
}
function sidecars(source: string, database: fs.Stats): Map<string, fs.Stats> {
  const result = new Map<string, fs.Stats>();
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const file = source + suffix,
      stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue;
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== database.uid ||
      stat.dev !== database.dev ||
      stat.nlink !== 1 ||
      stat.mode & 0o022 ||
      fs.realpathSync(file) !== file
    )
      throw Error('unsafe_native_sidecar');
    result.set(file, stat);
  }
  return result;
}
/** The caller supplies an admitted vault queue sink and holds the coordinated capture barrier. */
export function captureNativeDatabase(
  source: string,
  sink: BackupSnapshotSink,
  prefix: string,
  maximumBytes: number,
): NativeSnapshotReceipt {
  let fd: number | undefined,
    live: Database.Database | undefined,
    bytes: Buffer | undefined,
    metadata: Buffer | undefined;
  try {
    if (
      !path.isAbsolute(source) ||
      path.resolve(source) !== source ||
      fs.realpathSync(source) !== source ||
      !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+){0,5}$/.test(prefix) ||
      prefix.length > 100 ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 512 ||
      maximumBytes > 64 * 1024 ** 2
    )
      throw Error('native_snapshot_bounds');
    const directory = fs.lstatSync(path.dirname(source));
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || directory.mode & 0o022)
      throw Error('unsafe_native_directory');
    fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const original = fs.fstatSync(fd);
    if (!original.isFile() || original.uid !== process.getuid?.() || original.nlink !== 1 || original.mode & 0o022)
      throw Error('unsafe_native_source');
    const originalSidecars = sidecars(source, original);
    live = new Database(source, { readonly: true, fileMustExist: true });
    sameFile(original, fs.lstatSync(source));
    live.exec('BEGIN');
    // Both size queries and serialization use this connection's single committed read snapshot.
    const pageSize = live.pragma('page_size', { simple: true }),
      pageCount = live.pragma('page_count', { simple: true });
    if (typeof pageSize !== 'number' || typeof pageCount !== 'number') throw Error('native_snapshot_bounds');
    const expectedBytes = pageSize * pageCount;
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 512 || expectedBytes > maximumBytes)
      throw Error('native_snapshot_bounds');
    bytes = live.serialize();
    if (bytes.length !== expectedBytes || bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0')
      throw Error('native_snapshot_invalid');
    // SQLite documents these two header changes for deserializing a WAL snapshot. Only this owned
    // memory copy changes; committed WAL pages are already included by serialize().
    if (![1, 2].includes(bytes[18]) || ![1, 2].includes(bytes[19])) throw Error('native_snapshot_invalid');
    bytes[18] = 1;
    bytes[19] = 1;
    const copy = new Database(bytes, { readonly: true });
    try {
      if (copy.pragma('quick_check', { simple: true }) !== 'ok') throw Error('native_snapshot_invalid');
    } finally {
      copy.close();
    }
    sameFile(original, fs.lstatSync(source));
    sameFile(directory, fs.lstatSync(path.dirname(source)));
    const currentSidecars = sidecars(source, original);
    for (const [file, stat] of originalSidecars) {
      const current = currentSidecars.get(file);
      if (!current) throw Error('native_sidecar_changed');
      sameFile(stat, current);
    }
    live.exec('ROLLBACK');
    live.close();
    live = undefined;
    fs.closeSync(fd);
    fd = undefined;
    const receipt: NativeSnapshotReceipt = {
      format: 'cos-native-snapshot/v1',
      source,
      file: prefix + '/native.sqlite',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      at: new Date().toISOString(),
    };
    metadata = Buffer.from(JSON.stringify(receipt) + '\n');
    sink.write(receipt.file, bytes);
    sink.write(prefix + '/native-backup.json', metadata);
    return receipt;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Source paths, database contents and sink diagnostics are private.
    throw Error('native_snapshot_unavailable');
  } finally {
    bytes?.fill(0);
    metadata?.fill(0);
    try {
      live?.close();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}
