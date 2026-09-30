/** Private Pi-only snapshots. Caller holds maintenance and has stopped all native writers.
 * A snapshot preserves bytes; it never restores context, credentials or admission authority.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readPrivate, writeAtomic } from './target-state.js';

type Receipt = { version: 1; source: string; present: boolean; sha256: string; files: number; bytes: number };
const generation = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maximumBytes = 4 * 1024 * 1024 * 1024;
function directory(file: string, privateMode = false) {
  const stat = fs.lstatSync(file);
  if (
    !path.isAbsolute(file) ||
    fs.realpathSync(file) !== file ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o022 ||
    (privateMode && (stat.mode & 0o777) !== 0o700)
  )
    throw new Error('unsafe_conversation_backup');
}
function syncDirectory(file: string) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
/** Bound traversal, refuse links/special files, normalize copies to private modes. */
async function inventory(root: string, destination?: string, archived = false) {
  directory(root, true);
  const hash = createHash('sha256');
  let entries = 0,
    files = 0,
    bytes = 0;
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (++entries > 100000 || depth > 64) throw new Error('unsafe_conversation_backup');
    const parts = relative.split('/'),
      file = path.join(root, relative),
      stat = fs.lstatSync(file);
    if (
      !generation.test(parts[0]) ||
      (parts.length === 1 && !stat.isDirectory()) ||
      stat.uid !== process.getuid?.() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o022
    )
      throw new Error('unsafe_conversation_backup');
    // Only the native query cache and its interrupted atomic writes are omitted.
    // The host master credential directory is never part of this source tree.
    if (parts.length === 2 && (parts[1] === 'auth.json' || parts[1].startsWith('.auth-'))) {
      if (archived || !stat.isFile() || stat.nlink !== 1) throw new Error('unsafe_conversation_backup');
      return;
    }
    const copy = destination ? path.join(destination, relative) : undefined;
    if (stat.isDirectory()) {
      directory(file, archived);
      hash.update(JSON.stringify([relative, 'directory']) + '\n');
      if (copy) fs.mkdirSync(copy, { mode: 0o700 });
      for (const child of fs.readdirSync(file).sort()) await visit(relative + '/' + child, depth + 1);
      if (copy) syncDirectory(copy);
    } else if (stat.isFile() && stat.nlink === 1) {
      if (archived && (stat.mode & 0o777) !== 0o600) throw new Error('unsafe_conversation_backup');
      bytes += stat.size;
      if (bytes > maximumBytes) throw new Error('unsafe_conversation_backup');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let output: number | undefined;
      try {
        const opened = fs.fstatSync(fd);
        if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size)
          throw new Error('unsafe_conversation_backup');
        if (copy) output = fs.openSync(copy, 'wx', 0o600);
        const fileHash = createHash('sha256');
        let length = 0;
        for await (const chunk of fs.createReadStream(file, { fd, autoClose: false })) {
          const buffer = chunk as Buffer;
          length += buffer.length;
          if (length > stat.size) throw new Error('unsafe_conversation_backup');
          fileHash.update(buffer);
          if (output !== undefined) {
            let offset = 0;
            while (offset < buffer.length) offset += fs.writeSync(output, buffer, offset, buffer.length - offset);
          }
        }
        const after = fs.fstatSync(fd);
        if (length !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
          throw new Error('unsafe_conversation_backup');
        if (output !== undefined) fs.fsyncSync(output);
        hash.update(JSON.stringify([relative, 'file', length, fileHash.digest('hex')]) + '\n');
        files++;
      } finally {
        fs.closeSync(fd);
        if (output !== undefined) fs.closeSync(output);
      }
    } else throw new Error('unsafe_conversation_backup');
  };
  for (const child of fs.readdirSync(root).sort()) await visit(child, 1);
  if (destination) syncDirectory(destination);
  return { sha256: hash.digest('hex'), files, bytes };
}
export async function verifyConversationBackup(source: string, receiptRoot: string): Promise<Receipt> {
  directory(receiptRoot, true);
  const snapshot = path.join(receiptRoot, 'conversation-backup');
  directory(snapshot, true);
  const receipt = readPrivate<Receipt>(path.join(snapshot, 'receipt.json'));
  if (
    receipt.version !== 1 ||
    receipt.source !== source ||
    typeof receipt.present !== 'boolean' ||
    fs.readdirSync(snapshot).sort().join(',') !== 'history,receipt.json'
  )
    throw new Error('conversation_backup_conflict');
  const actual = await inventory(path.join(snapshot, 'history'), undefined, true);
  if (
    actual.sha256 !== receipt.sha256 ||
    actual.files !== receipt.files ||
    actual.bytes !== receipt.bytes ||
    (!receipt.present && fs.readdirSync(path.join(snapshot, 'history')).length !== 0)
  )
    throw new Error('conversation_backup_conflict');
  return receipt;
}
export async function backupConversations(source: string, receiptRoot: string): Promise<Receipt> {
  directory(path.dirname(source), true);
  directory(receiptRoot, true);
  if (path.resolve(source) !== source || receiptRoot === source || receiptRoot.startsWith(source + '/'))
    throw new Error('unsafe_conversation_backup');
  const snapshot = path.join(receiptRoot, 'conversation-backup');
  if (fs.lstatSync(snapshot, { throwIfNoEntry: false })) return verifyConversationBackup(source, receiptRoot);
  const present = !!fs.lstatSync(source, { throwIfNoEntry: false });
  const empty = { sha256: createHash('sha256').digest('hex'), files: 0, bytes: 0 };
  const before = present ? await inventory(source) : empty;
  const space = fs.statfsSync(receiptRoot);
  if (space.bavail * space.bsize < before.bytes + 64 * 1024 * 1024) throw new Error('conversation_backup_space');
  const temporary = path.join(receiptRoot, '.conversation-backup-' + randomUUID());
  fs.mkdirSync(temporary, { mode: 0o700 });
  const history = path.join(temporary, 'history');
  fs.mkdirSync(history, { mode: 0o700 });
  // Interrupted private staging is left unpublished. A retry never treats it as a receipt.
  const copied = present ? await inventory(source, history) : empty;
  const after = present ? await inventory(source) : empty;
  if (
    JSON.stringify(before) !== JSON.stringify(copied) ||
    JSON.stringify(before) !== JSON.stringify(after) ||
    present !== !!fs.lstatSync(source, { throwIfNoEntry: false })
  )
    throw new Error('conversation_backup_changed');
  const receipt: Receipt = { version: 1, source, present, ...copied };
  syncDirectory(history);
  writeAtomic(temporary, 'receipt.json', receipt);
  // Verify the completed private copy before publishing it as the deployment baseline.
  const checked = await inventory(history, undefined, true);
  if (JSON.stringify(checked) !== JSON.stringify(copied)) throw new Error('conversation_backup_conflict');
  fs.renameSync(temporary, snapshot);
  syncDirectory(receiptRoot);
  return verifyConversationBackup(source, receiptRoot);
}
