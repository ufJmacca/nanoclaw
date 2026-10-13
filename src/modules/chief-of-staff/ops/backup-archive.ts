import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { BackupQueueReceipt } from './backup-queue.js';
import { BACKUP_LIMITS } from './backup-policy.js';

const pinned = (fd: number) => '/proc/self/fd/' + fd;
function directory(file: string, device?: number): number {
  const alias = /^\/proc\/self\/fd\/\d+$/.test(file);
  const heldChild = device !== undefined && /^\/proc\/self\/fd\/\d+\/(?:[A-Za-z0-9]|\.cos-)[A-Za-z0-9_.-]*$/.test(file);
  if (!path.isAbsolute(file) || path.resolve(file) !== file || (!alias && !heldChild && fs.realpathSync(file) !== file))
    throw Error('unsafe_archive_directory');
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (alias ? 0 : fs.constants.O_NOFOLLOW),
  );
  const stat = fs.fstatSync(fd);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    (device !== undefined && stat.dev !== device)
  ) {
    fs.closeSync(fd);
    throw Error('unsafe_archive_directory');
  }
  return fd;
}
function validate(receipt: BackupQueueReceipt): void {
  if (
    !receipt ||
    receipt.format !== 'cos-backup-queue/v1' ||
    receipt.state !== 'pending' ||
    !['state', 'credentials'].includes(receipt.kind) ||
    !/^[a-f0-9]{64}$/.test(receipt.ownerDigest) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(receipt.operationId) ||
    !Number.isSafeInteger(receipt.maximumBytes) ||
    receipt.maximumBytes < 16384 ||
    receipt.maximumBytes > (receipt.kind === 'state' ? BACKUP_LIMITS.staging : BACKUP_LIMITS.credentials) ||
    !Number.isSafeInteger(receipt.bytes) ||
    receipt.bytes < 0 ||
    receipt.bytes > receipt.maximumBytes ||
    !Array.isArray(receipt.files) ||
    !receipt.files.length ||
    receipt.files.length > 4096 ||
    new Set(receipt.files.map((file) => file.name)).size !== receipt.files.length ||
    receipt.files.some(
      (file) =>
        !file ||
        typeof file.name !== 'string' ||
        file.name.length > 192 ||
        file.name.split('/').length > 8 ||
        !file.name.split('/').every((part) => /^(?:[A-Za-z0-9]|\.cos-)[A-Za-z0-9_.-]*$/.test(part)) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        !/^[a-f0-9]{64}$/.test(file.sha256),
    ) ||
    receipt.files.reduce((total, file) => total + file.bytes, 0) > receipt.maximumBytes
  )
    throw Error('invalid_archive_receipt');
}
function header(name: string, size: number, type = '0'): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write(name, 0, 100, 'ascii');
  const octal = (offset: number, length: number, value: number) => {
    const text = value.toString(8);
    if (text.length >= length) throw Error('archive_header_bounds');
    bytes.write(text.padStart(length - 1, '0') + '\0', offset, length, 'ascii');
  };
  octal(100, 8, 0o600);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, 0);
  bytes.fill(0x20, 148, 156);
  bytes.write(type, 156, 1, 'ascii');
  bytes.write('ustar\0', 257, 6, 'ascii');
  bytes.write('00', 263, 2, 'ascii');
  octal(329, 8, 0);
  octal(337, 8, 0);
  const sum = bytes.reduce((total, byte) => total + byte, 0);
  bytes.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return bytes;
}
function paxPath(name: string): Buffer {
  const text = ' path=' + name + '\n';
  let length = text.length + 1;
  while (length !== text.length + String(length).length) length = text.length + String(length).length;
  return Buffer.from(String(length) + text, 'ascii');
}
/** Canonical entry framing shared by the owned producer and restore reader.
 * This produces bytes only; it grants no file or restore permission. */
export function backupArchiveEntryPrefix(name: string, size: number, index: number): Buffer {
  if (
    typeof name !== 'string' ||
    name.length > 200 ||
    !name.split('/').every((part) => /^(?:[A-Za-z0-9]|\.cos-)[A-Za-z0-9_.-]*$/.test(part)) ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > BACKUP_LIMITS.staging ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index > 4096
  )
    throw Error('archive_entry_bounds');
  if (name.length <= 100) return header(name, size);
  const pax = paxPath(name);
  try {
    return Buffer.concat([
      header('PaxHeaders/' + index, pax.length, 'x'),
      pax,
      Buffer.alloc((512 - (pax.length % 512)) % 512),
      header('PaxFile/' + index, size),
    ]);
  } finally {
    pax.fill(0);
  }
}
function identity(before: fs.Stats, after: fs.Stats, content = false): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.uid !== after.uid ||
    (content &&
      (before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.mode !== after.mode ||
        before.nlink !== after.nlink))
  )
    throw Error('archive_file_changed');
}
/** Canonical first entry, used to authenticate durable cleanup metadata against
 * remote bytes even when some local payload files have already been removed. */
export function backupArchiveReceiptPrefix(receipt: BackupQueueReceipt): Buffer {
  validate(receipt);
  const metadata = Buffer.from(JSON.stringify(receipt) + '\n');
  try {
    if (metadata.length > 1024 ** 2) throw Error('archive_receipt_bounds');
    return Buffer.concat([header('cos-backup-receipt.json', metadata.length), metadata]);
  } finally {
    metadata.fill(0);
  }
}
/** Streams only declared immutable queue files. The emitter consumes borrowed bytes before resolving.
 * Production invokes this producer with Restic --stdin-from-command so any failure denies a snapshot. */
export async function streamBackupArchive(
  root: string,
  receipt: BackupQueueReceipt,
  emit: (bytes: Buffer) => Promise<void>,
): Promise<{ bytes: number; sha256: string }> {
  let rootFd: number | undefined, metadata: Buffer | undefined;
  const hash = createHash('sha256');
  let count = 0;
  try {
    validate(receipt);
    metadata = Buffer.from(JSON.stringify(receipt) + '\n');
    if (metadata.length > 1024 ** 2) throw Error('archive_receipt_bounds');
    rootFd = directory(root);
    const rootStat = fs.fstatSync(rootFd),
      device = rootStat.dev;
    const ceiling = (receipt.kind === 'state' ? BACKUP_LIMITS.staging : BACKUP_LIMITS.credentials) + 2 * 1024 ** 2;
    const send = async (bytes: Buffer) => {
      if (bytes.length > 65536 || count + bytes.length > ceiling) throw Error('archive_stream_bounds');
      hash.update(bytes);
      count += bytes.length;
      await emit(bytes);
    };
    const owned = async (bytes: Buffer) => {
      try {
        await send(bytes);
      } finally {
        bytes.fill(0);
      }
    };
    const padding = async (size: number) => {
      if (size % 512) await owned(Buffer.alloc(512 - (size % 512)));
    };
    const entry = async (name: string, size: number, index: number) => {
      await owned(backupArchiveEntryPrefix(name, size, index));
    };
    await entry('cos-backup-receipt.json', metadata.length, 0);
    for (let offset = 0; offset < metadata.length; offset += 65536)
      await send(metadata.subarray(offset, offset + 65536));
    await padding(metadata.length);
    const files = [...receipt.files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const [index, file] of files.entries()) {
      const held: Array<{ parent: number; name: string; fd: number; stat: fs.Stats }> = [];
      let fd: number | undefined;
      const buffer = Buffer.alloc(65536);
      try {
        let parent = rootFd;
        const parts = file.name.split('/'),
          basename = parts.pop()!;
        for (const part of parts) {
          const child = directory(path.join(pinned(parent), part), device);
          held.push({ parent, name: part, fd: child, stat: fs.fstatSync(child) });
          parent = child;
        }
        const pathname = path.join(pinned(parent), basename);
        fd = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const before = fs.fstatSync(fd);
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          before.uid !== process.getuid?.() ||
          before.dev !== device ||
          (before.mode & 0o777) !== 0o600 ||
          before.size !== file.bytes
        )
          throw Error('unsafe_archive_file');
        identity(before, fs.lstatSync(pathname), true);
        await entry('payload/' + file.name, file.bytes, index + 1);
        const fileHash = createHash('sha256');
        for (let offset = 0; offset < file.bytes; ) {
          const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, file.bytes - offset), offset);
          if (read < 1) throw Error('archive_short_read');
          const chunk = buffer.subarray(0, read);
          fileHash.update(chunk);
          await send(chunk);
          buffer.fill(0);
          offset += read;
        }
        identity(before, fs.fstatSync(fd), true);
        identity(before, fs.lstatSync(pathname), true);
        if (fileHash.digest('hex') !== file.sha256) throw Error('archive_hash_changed');
        for (const item of held) identity(item.stat, fs.lstatSync(path.join(pinned(item.parent), item.name)));
        await padding(file.bytes);
      } finally {
        buffer.fill(0);
        if (fd !== undefined) fs.closeSync(fd);
        for (const item of held.reverse()) fs.closeSync(item.fd);
      }
    }
    identity(rootStat, fs.statSync(root));
    await owned(Buffer.alloc(512));
    await owned(Buffer.alloc(512));
    return { bytes: count, sha256: hash.digest('hex') };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Queue paths, archive content and transport diagnostics are private.
    throw Error('backup_archive_unavailable');
  } finally {
    metadata?.fill(0);
    if (rootFd !== undefined) fs.closeSync(rootFd);
  }
}
