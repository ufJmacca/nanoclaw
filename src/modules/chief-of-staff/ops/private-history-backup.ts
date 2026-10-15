import { validBackupPathSegment } from './backup-names.js';
/** Private Pi-only snapshots. Caller holds maintenance and has stopped all native writers.
 * A snapshot preserves bytes; it never restores context, credentials or admission authority.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readPrivate, writeAtomic } from './target-state.js';
import type { BackupSnapshotSink, BackupQueueReceipt } from './backup-queue.js';
import type { BackupRestoreValidationScope } from './backup-restore-workspace.js';
import { BACKUP_LIMITS } from './backup-policy.js';

type Receipt = { version: 1; source: string; present: boolean; sha256: string; files: number; bytes: number };
type Profile = 'conversation' | 'mission';
type CapturedHistoryReceipt = Receipt & { directories: string[] };
const generation = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maximumBytes = 4 * 1024 * 1024 * 1024;
function capturedDirectory(name: string, profile: Profile, names: Set<string>) {
  if (
    typeof name !== 'string' ||
    name.length > 170 ||
    name.split('/').length > 6 ||
    !name.split('/').every((part) => validBackupPathSegment(part))
  )
    throw Error('invalid_history_directory');
  const parts = name.split('/');
  if (profile === 'conversation') {
    if (!generation.test(parts[0])) throw Error('invalid_history_directory');
  } else if (parts[0] === 'mission-purges') {
    if (parts.length !== 1) throw Error('invalid_history_directory');
  } else if (
    parts[0] !== 'missions' ||
    (parts.length >= 2 && !generation.test(parts[1])) ||
    (parts.length >= 3 && !['context', 'provider'].includes(parts[2]))
  )
    throw Error('invalid_history_directory');
  for (let index = 1; index < parts.length; index++)
    if (!names.has(parts.slice(0, index).join('/'))) throw Error('incomplete_history_directories');
}
type Capture = {
  maximumBytes: number;
  check(relative: string): void;
  directory?(relative: string): void;
  write?(relative: string, bytes: Buffer): void;
};
function directory(file: string, profile: Profile, privateMode = false) {
  const stat = fs.lstatSync(file);
  if (
    !path.isAbsolute(file) ||
    fs.realpathSync(file) !== file ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o022 ||
    (privateMode && (stat.mode & 0o777) !== 0o700)
  )
    throw new Error(`unsafe_${profile}_backup`);
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
async function inventory(root: string, profile: Profile, destination?: string, archived = false, capture?: Capture) {
  directory(root, profile, true);
  const unsafe = () => new Error(`unsafe_${profile}_backup`);
  const selected = (name: string) =>
    profile === 'conversation' ||
    name === 'missions' ||
    name === 'mission-purges' ||
    /^(?:mission-delegation|team-admission)-[a-f0-9]{64}\.json$/.test(name);
  const hash = createHash('sha256');
  let entries = 0,
    files = 0,
    bytes = 0;
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (++entries > (capture ? 4096 : 100000) || depth > (capture ? 6 : 64)) throw unsafe();
    const parts = relative.split('/'),
      file = path.join(root, relative),
      stat = fs.lstatSync(file);
    if (stat.uid !== process.getuid?.() || stat.isSymbolicLink() || stat.mode & 0o022) throw unsafe();
    if (profile === 'conversation') {
      if (!generation.test(parts[0]) || (parts.length === 1 && !stat.isDirectory())) throw unsafe();
    } else {
      if (!selected(parts[0])) throw unsafe();
      if (parts[0].startsWith('mission-delegation-') || parts[0].startsWith('team-admission-')) {
        if (parts.length !== 1 || !stat.isFile()) throw unsafe();
      } else if (parts[0] === 'mission-purges') {
        if (
          parts.length === 1
            ? !stat.isDirectory()
            : parts.length !== 2 ||
              !generation.test(parts[1].replace(/\.json$/, '')) ||
              !parts[1].endsWith('.json') ||
              !stat.isFile()
        )
          throw unsafe();
      } else {
        if (parts.length <= 2 && (!stat.isDirectory() || (parts.length === 2 && !generation.test(parts[1]))))
          throw unsafe();
        if (parts.length >= 3 && !['context', 'provider', 'control'].includes(parts[2])) throw unsafe();
        if (parts.length === 3 && !stat.isDirectory()) throw unsafe();
        // Control sockets/capabilities are ephemeral admission authority, never retained history.
        if (parts[2] === 'control') {
          if (archived) throw unsafe();
          directory(file, profile, true);
          return;
        }
      }
    }
    // Omit only the provider's access credential cache and interrupted atomic writes.
    // Mission root selection never traverses the host master credential directories.
    const credentialName =
      profile === 'conversation' && parts.length === 2
        ? parts[1]
        : profile === 'mission' && parts.length === 4 && parts[0] === 'missions' && parts[2] === 'provider'
          ? parts[3]
          : '';
    if (credentialName === 'auth.json' || credentialName.startsWith('.auth-')) {
      if (archived || !stat.isFile() || stat.nlink !== 1) throw unsafe();
      return;
    }
    capture?.check(relative);
    const copy = destination ? path.join(destination, relative) : undefined;
    if (stat.isDirectory()) {
      directory(file, profile, archived);
      hash.update(JSON.stringify([relative, 'directory']) + '\n');
      capture?.directory?.(relative);
      if (copy) fs.mkdirSync(copy, { mode: 0o700 });
      for (const child of fs.readdirSync(file).sort()) await visit(relative + '/' + child, depth + 1);
      if (copy) syncDirectory(copy);
    } else if (stat.isFile() && stat.nlink === 1) {
      if (archived && (stat.mode & 0o777) !== 0o600) throw unsafe();
      bytes += stat.size;
      if (bytes > (capture?.maximumBytes ?? maximumBytes)) throw unsafe();
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let output: number | undefined;
      try {
        const opened = fs.fstatSync(fd);
        if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw unsafe();
        if (copy) output = fs.openSync(copy, 'wx', 0o600);
        const fileHash = createHash('sha256');
        let length = 0;
        for await (const chunk of fs.createReadStream(file, { fd, autoClose: false })) {
          const buffer = chunk as Buffer;
          try {
            length += buffer.length;
            if (length > stat.size) throw unsafe();
            fileHash.update(buffer);
            capture?.write?.(relative, buffer);
            if (output !== undefined) {
              let offset = 0;
              while (offset < buffer.length) {
                const written = fs.writeSync(output, buffer, offset, buffer.length - offset);
                if (written < 1) throw unsafe();
                offset += written;
              }
            }
          } finally {
            buffer.fill(0);
          }
        }
        const after = fs.fstatSync(fd);
        if (length !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw unsafe();
        if (output !== undefined) fs.fsyncSync(output);
        hash.update(JSON.stringify([relative, 'file', length, fileHash.digest('hex')]) + '\n');
        files++;
      } finally {
        fs.closeSync(fd);
        if (output !== undefined) fs.closeSync(output);
      }
    } else throw unsafe();
  };
  for (const child of fs.readdirSync(root).sort()) {
    if (!selected(child)) {
      if (archived) throw unsafe();
      continue;
    }
    await visit(child, 1);
  }
  if (destination) syncDirectory(destination);
  return { sha256: hash.digest('hex'), files, bytes };
}
/** The admitted queue provides encrypted storage and the caller holds maintenance throughout.
 * The additive directory list permits recovery of empty history directories using the v1 reader. */
export async function capturePrivateHistory(
  source: string,
  sink: BackupSnapshotSink,
  profile: Profile,
  limit = BACKUP_LIMITS.staging,
): Promise<Receipt & { directories: string[] }> {
  try {
    if (
      !['conversation', 'mission'].includes(profile) ||
      !Number.isSafeInteger(limit) ||
      limit < 16384 ||
      limit > BACKUP_LIMITS.staging ||
      !path.isAbsolute(source) ||
      path.resolve(source) !== source
    )
      throw Error('history_capture_bounds');
    directory(profile === 'mission' ? source : path.dirname(source), profile, true);
    const prefix = profile + '-backup/history/';
    const bounds: Capture = {
      maximumBytes: limit,
      check(relative) {
        const name = prefix + relative;
        if (
          name.length > 192 ||
          name.split('/').length > 8 ||
          !name.split('/').every((part) => validBackupPathSegment(part))
        )
          throw Error('history_capture_name');
      },
    };
    const present = !!fs.lstatSync(source, { throwIfNoEntry: false });
    const empty = { sha256: createHash('sha256').digest('hex'), files: 0, bytes: 0 };
    const before = present ? await inventory(source, profile, undefined, false, bounds) : empty;
    const directories: string[] = [];
    const copied = present
      ? await inventory(source, profile, undefined, false, {
          ...bounds,
          directory: (relative) => {
            directories.push(relative);
          },
          write: (relative, bytes) => sink.write(prefix + relative, bytes),
        })
      : empty;
    const after = present ? await inventory(source, profile, undefined, false, bounds) : empty;
    if (
      JSON.stringify(before) !== JSON.stringify(copied) ||
      JSON.stringify(before) !== JSON.stringify(after) ||
      present !== !!fs.lstatSync(source, { throwIfNoEntry: false })
    )
      throw Error('history_capture_changed');
    const receipt = { version: 1 as const, source, present, ...copied, directories };
    const bytes = Buffer.from(JSON.stringify(receipt) + '\n');
    try {
      if (bytes.length > 1024 ** 2) throw Error('history_capture_bounds');
      sink.write(profile + '-backup/receipt.json', bytes);
    } finally {
      bytes.fill(0);
    }
    return receipt;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Conversation contents, source paths and provider diagnostics are private.
    throw Error('private_history_capture_unavailable');
  }
}
/** Verify only the portable captured history under an admitted held workspace.
 * Reconstructed directories are owned and charged by that workspace. The v1
 * checksum remains unchanged; no context, credential or live admission is imported. */
export function verifyRecoveredPrivateHistory(
  scope: BackupRestoreValidationScope,
  entries: BackupQueueReceipt['files'],
  source: string,
  profile: Profile,
): CapturedHistoryReceipt {
  try {
    scope.assertCurrent();
    if (
      !['conversation', 'mission'].includes(profile) ||
      typeof source !== 'string' ||
      !path.isAbsolute(source) ||
      path.resolve(source) !== source ||
      !Array.isArray(entries) ||
      entries.length > 4096 ||
      new Set(entries.map((item) => item.name)).size !== entries.length
    )
      throw Error('history_recovery_bounds');
    const root = profile + '-backup',
      prefix = root + '/history/',
      metadata = root + '/receipt.json',
      metadataEntry = entries.find((item) => item.name === metadata);
    const checkEntry = (entry: BackupQueueReceipt['files'][number]) => {
      if (
        !entry ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        entry.bytes > BACKUP_LIMITS.staging ||
        typeof entry.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.sha256)
      )
        throw Error('history_recovery_file_bounds');
      const actual = scope.inspectFile(entry.name);
      if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw Error('history_recovery_changed');
    };
    if (!metadataEntry || metadataEntry.bytes > 1024 ** 2) throw Error('history_recovery_metadata_missing');
    checkEntry(metadataEntry);
    const receipt = scope.withFileBytes(metadata, 1024 ** 2, (bytes) =>
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    ) as CapturedHistoryReceipt;
    if (
      !receipt ||
      Object.keys(receipt).sort().join(',') !== 'bytes,directories,files,present,sha256,source,version' ||
      receipt.version !== 1 ||
      receipt.source !== source ||
      typeof receipt.present !== 'boolean' ||
      !Number.isSafeInteger(receipt.files) ||
      receipt.files < 0 ||
      receipt.files > 4096 ||
      !Number.isSafeInteger(receipt.bytes) ||
      receipt.bytes < 0 ||
      receipt.bytes > BACKUP_LIMITS.staging ||
      typeof receipt.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
      !Array.isArray(receipt.directories) ||
      receipt.directories.length > 4096 ||
      new Set(receipt.directories).size !== receipt.directories.length ||
      (!receipt.present && (receipt.directories.length || receipt.files || receipt.bytes))
    )
      throw Error('invalid_history_receipt');
    const directories = new Set(receipt.directories);
    for (const name of directories) capturedDirectory(name, profile, directories);
    const files = new Map<string, BackupQueueReceipt['files'][number]>();
    for (const entry of entries.filter((item) => item.name.startsWith(root + '/'))) {
      if (entry.name === metadata) continue;
      if (!entry.name.startsWith(prefix)) throw Error('history_recovery_unselected');
      const relative = entry.name.slice(prefix.length),
        parts = relative.split('/');
      if (
        relative.length > 170 ||
        parts.length > 6 ||
        !parts.every((part) => validBackupPathSegment(part)) ||
        directories.has(relative)
      )
        throw Error('history_recovery_file_bounds');
      if (profile === 'conversation') {
        if (
          !generation.test(parts[0]) ||
          parts.length < 2 ||
          (parts.length === 2 && (parts[1] === 'auth.json' || parts[1].startsWith('.auth-')))
        )
          throw Error('history_recovery_unselected');
      } else if (parts[0] === 'mission-purges') {
        if (parts.length !== 2 || !parts[1].endsWith('.json') || !generation.test(parts[1].slice(0, -5)))
          throw Error('history_recovery_unselected');
      } else if (/^(?:mission-delegation|team-admission)-[a-f0-9]{64}\.json$/.test(parts[0])) {
        if (parts.length !== 1) throw Error('history_recovery_unselected');
      } else if (
        parts[0] !== 'missions' ||
        parts.length < 4 ||
        !generation.test(parts[1]) ||
        !['context', 'provider'].includes(parts[2]) ||
        (parts.length === 4 && parts[2] === 'provider' && (parts[3] === 'auth.json' || parts[3].startsWith('.auth-')))
      )
        throw Error('history_recovery_unselected');
      for (let i = 1; i < parts.length; i++)
        if (!directories.has(parts.slice(0, i).join('/'))) throw Error('incomplete_history_directories');
      files.set(relative, entry);
    }
    if (directories.size + files.size > 4096 || files.size !== receipt.files) throw Error('history_recovery_bounds');
    const hash = createHash('sha256');
    let bytes = 0;
    const children = new Map<string, string[]>();
    for (const name of [...directories, ...files.keys()]) {
      const parent = path.posix.dirname(name),
        list = children.get(parent) ?? [];
      list.push(name);
      children.set(parent, list);
    }
    const visit = (name: string) => {
      scope.assertCurrent();
      if (directories.has(name)) {
        hash.update(JSON.stringify([name, 'directory']) + '\n');
        for (const child of (children.get(name) ?? []).sort()) visit(child);
      } else {
        const entry = files.get(name)!;
        checkEntry(entry);
        bytes += entry.bytes;
        if (bytes > BACKUP_LIMITS.staging) throw Error('history_recovery_bounds');
        hash.update(JSON.stringify([name, 'file', entry.bytes, entry.sha256]) + '\n');
      }
    };
    for (const name of (children.get('.') ?? []).sort()) visit(name);
    if (hash.digest('hex') !== receipt.sha256 || bytes !== receipt.bytes) throw Error('history_recovery_changed');
    // Mutation begins only after names, selection and the original v1 checksum pass.
    scope.ensureDirectory(prefix.slice(0, -1));
    for (const name of [...directories].sort()) scope.ensureDirectory(prefix + name);
    checkEntry(metadataEntry);
    scope.assertCurrent();
    return receipt;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- History, source paths and recovery diagnostics are private.
    throw Error('private_history_recovery_check_unavailable');
  }
}
/** Recreate recorded empty directories in an admitted isolated recovery root, then run the v1
 * hash verifier. This does not import a context, change credentials or restore execution authority. */
export async function restoreCapturedHistoryDirectories(source: string, receiptRoot: string, profile: Profile) {
  try {
    if (
      !['conversation', 'mission'].includes(profile) ||
      !path.isAbsolute(source) ||
      path.resolve(source) !== source ||
      receiptRoot === source ||
      receiptRoot.startsWith(source + '/') ||
      source.startsWith(receiptRoot + '/')
    )
      throw Error('history_restore_not_isolated');
    directory(receiptRoot, profile, true);
    const snapshot = path.join(receiptRoot, profile + '-backup');
    directory(snapshot, profile, true);
    const receiptFile = path.join(snapshot, 'receipt.json');
    const receipt = readPrivate<Receipt & { directories: string[] }>(receiptFile, 1024 ** 2);
    if (
      !receipt ||
      receipt.version !== 1 ||
      receipt.source !== source ||
      typeof receipt.present !== 'boolean' ||
      !Number.isSafeInteger(receipt.files) ||
      receipt.files < 0 ||
      receipt.files > 4096 ||
      !Number.isSafeInteger(receipt.bytes) ||
      receipt.bytes < 0 ||
      receipt.bytes > BACKUP_LIMITS.staging ||
      !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
      !Array.isArray(receipt.directories) ||
      receipt.directories.length > 4096 ||
      new Set(receipt.directories).size !== receipt.directories.length ||
      (!receipt.present && (receipt.directories.length || receipt.files || receipt.bytes))
    )
      throw Error('invalid_history_receipt');
    const names = new Set(receipt.directories);
    for (const name of names) capturedDirectory(name, profile, names);
    const history = path.join(snapshot, 'history');
    if (!fs.lstatSync(history, { throwIfNoEntry: false })) fs.mkdirSync(history, { mode: 0o700 });
    directory(history, profile, true);
    for (const name of [...names].sort()) {
      const file = path.join(history, name);
      directory(path.dirname(file), profile, true);
      if (!fs.lstatSync(file, { throwIfNoEntry: false })) fs.mkdirSync(file, { mode: 0o700 });
      directory(file, profile, true);
      syncDirectory(file);
    }
    syncDirectory(history);
    const verified = await verifyPrivateHistory(source, receiptRoot, profile);
    if (
      JSON.stringify(verified) !== JSON.stringify(receipt) ||
      JSON.stringify(readPrivate(receiptFile, 1024 ** 2)) !== JSON.stringify(receipt)
    )
      throw Error('history_restore_changed');
    return verified;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Restored private history and filesystem diagnostics stay in the recovery process.
    throw Error('private_history_restore_unavailable');
  }
}
export async function verifyPrivateHistory(source: string, receiptRoot: string, profile: Profile): Promise<Receipt> {
  directory(receiptRoot, profile, true);
  const snapshot = path.join(receiptRoot, profile + '-backup');
  directory(snapshot, profile, true);
  const receipt = readPrivate<Receipt>(path.join(snapshot, 'receipt.json'));
  if (
    receipt.version !== 1 ||
    receipt.source !== source ||
    typeof receipt.present !== 'boolean' ||
    fs.readdirSync(snapshot).sort().join(',') !== 'history,receipt.json'
  )
    throw new Error(profile + '_backup_conflict');
  const actual = await inventory(path.join(snapshot, 'history'), profile, undefined, true);
  if (
    actual.sha256 !== receipt.sha256 ||
    actual.files !== receipt.files ||
    actual.bytes !== receipt.bytes ||
    (!receipt.present && fs.readdirSync(path.join(snapshot, 'history')).length !== 0)
  )
    throw new Error(profile + '_backup_conflict');
  return receipt;
}
export async function backupPrivateHistory(source: string, receiptRoot: string, profile: Profile): Promise<Receipt> {
  directory(profile === 'mission' ? source : path.dirname(source), profile, true);
  directory(receiptRoot, profile, true);
  // Mission receipts live in the unselected releases subtree of the target root.
  if (
    path.resolve(source) !== source ||
    receiptRoot === source ||
    (receiptRoot.startsWith(source + '/') &&
      (profile !== 'mission' || !receiptRoot.startsWith(path.join(source, 'releases') + '/')))
  )
    throw new Error(`unsafe_${profile}_backup`);
  const snapshot = path.join(receiptRoot, profile + '-backup');
  if (fs.lstatSync(snapshot, { throwIfNoEntry: false })) return verifyPrivateHistory(source, receiptRoot, profile);
  const present = !!fs.lstatSync(source, { throwIfNoEntry: false });
  const empty = { sha256: createHash('sha256').digest('hex'), files: 0, bytes: 0 };
  const before = present ? await inventory(source, profile) : empty;
  const space = fs.statfsSync(receiptRoot);
  if (space.bavail * space.bsize < before.bytes + 64 * 1024 * 1024) throw new Error(profile + '_backup_space');
  const temporary = path.join(receiptRoot, '.' + profile + '-backup-' + randomUUID());
  fs.mkdirSync(temporary, { mode: 0o700 });
  const history = path.join(temporary, 'history');
  fs.mkdirSync(history, { mode: 0o700 });
  // Interrupted private staging is left unpublished. A retry never treats it as a receipt.
  const copied = present ? await inventory(source, profile, history) : empty;
  const after = present ? await inventory(source, profile) : empty;
  if (
    JSON.stringify(before) !== JSON.stringify(copied) ||
    JSON.stringify(before) !== JSON.stringify(after) ||
    present !== !!fs.lstatSync(source, { throwIfNoEntry: false })
  )
    throw new Error(profile + '_backup_changed');
  const receipt: Receipt = { version: 1, source, present, ...copied };
  syncDirectory(history);
  writeAtomic(temporary, 'receipt.json', receipt);
  // Verify the completed private copy before publishing it as the deployment baseline.
  const checked = await inventory(history, profile, undefined, true);
  if (JSON.stringify(checked) !== JSON.stringify(copied)) throw new Error(profile + '_backup_conflict');
  fs.renameSync(temporary, snapshot);
  syncDirectory(receiptRoot);
  return verifyPrivateHistory(source, receiptRoot, profile);
}
