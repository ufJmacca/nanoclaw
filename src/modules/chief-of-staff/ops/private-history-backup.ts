/** Private Pi-only snapshots. Caller holds maintenance and has stopped all native writers.
 * A snapshot preserves bytes; it never restores context, credentials or admission authority.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readPrivate, writeAtomic } from './target-state.js';

type Receipt = { version: 1; source: string; present: boolean; sha256: string; files: number; bytes: number };
type Profile = 'conversation' | 'mission';
const generation = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maximumBytes = 4 * 1024 * 1024 * 1024;
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
async function inventory(root: string, profile: Profile, destination?: string, archived = false) {
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
    if (++entries > 100000 || depth > 64) throw unsafe();
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
    const copy = destination ? path.join(destination, relative) : undefined;
    if (stat.isDirectory()) {
      directory(file, profile, archived);
      hash.update(JSON.stringify([relative, 'directory']) + '\n');
      if (copy) fs.mkdirSync(copy, { mode: 0o700 });
      for (const child of fs.readdirSync(file).sort()) await visit(relative + '/' + child, depth + 1);
      if (copy) syncDirectory(copy);
    } else if (stat.isFile() && stat.nlink === 1) {
      if (archived && (stat.mode & 0o777) !== 0o600) throw unsafe();
      bytes += stat.size;
      if (bytes > maximumBytes) throw unsafe();
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
          length += buffer.length;
          if (length > stat.size) throw unsafe();
          fileHash.update(buffer);
          if (output !== undefined) {
            let offset = 0;
            while (offset < buffer.length) offset += fs.writeSync(output, buffer, offset, buffer.length - offset);
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
