import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { readPrivate, writeAtomic } from '../ops/target-state.js';
import { verifyCalendarStorage, type CalendarStorageRoots, type CalendarStoragePolicy } from './storage-policy.js';
import type { StorageInspection } from './storage-protection.js';
import { checkedClient, validCalendarTokens } from './oauth-core.js';
import { object } from './normalization.js';
export type CalendarBackupOptions = {
  roots: CalendarStorageRoots;
  operationId: string;
  receiptRoot: string;
  check(): Promise<void>;
  inspect?: StorageInspection;
};
export type CalendarBackupReceipt = {
  contract: 'cos-calendar-backup/v1';
  operationId: string;
  targetDigest: string;
  present: boolean;
  storageDigest: string | null;
  snapshot: string | null;
  sha256: string;
  files: number;
  bytes: number;
};
const name = 'calendar-backup.json',
  maximumBytes = 64 * 1024 * 1024;
const empty = { sha256: createHash('sha256').digest('hex'), files: 0, bytes: 0 };
function directory(file: string, pinned = false) {
  const descriptor = pinned ? /^\/proc\/self\/fd\/(\d+)$/.exec(file) : null;
  const stat = descriptor ? fs.fstatSync(Number(descriptor[1])) : fs.lstatSync(file);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    (!pinned && fs.realpathSync(file) !== file)
  )
    throw new Error('unsafe_backup_directory');
  return stat;
}
function sync(file: string) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function read(file: string, maximum = 16384): unknown {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe_backup_receipt');
  return readPrivate(file, maximum);
}
function parameters(o: CalendarBackupOptions) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(o.operationId) ||
    !path.isAbsolute(o.roots.targetRoot) ||
    path.resolve(o.receiptRoot) !== o.receiptRoot ||
    !o.receiptRoot.startsWith(o.roots.targetRoot + '/')
  )
    throw new Error('invalid_backup_identity');
  directory(o.roots.targetRoot);
  directory(o.receiptRoot);
  return {
    contract: 'cos-calendar-backup/v1' as const,
    operationId: o.operationId,
    targetDigest: digest(o.roots.targetRoot),
  };
}
function absent(o: CalendarBackupOptions) {
  return (
    !fs.lstatSync(path.join(o.roots.targetRoot, 'calendar'), { throwIfNoEntry: false }) &&
    !fs.lstatSync(path.join(o.roots.targetRoot, 'calendar-storage.json'), { throwIfNoEntry: false })
  );
}
function absentReceipt(o: CalendarBackupOptions): CalendarBackupReceipt {
  return { ...parameters(o), present: false, storageDigest: null, snapshot: null, ...empty };
}
function inventory(root: string, destination?: string) {
  directory(root, true);
  let entries = 0,
    files = 0,
    bytes = 0;
  const hash = createHash('sha256');
  const visit = (relative: string, depth: number) => {
    if (++entries > 10000 || depth > 16) throw new Error('calendar_backup_bounds');
    const file = path.join(root, relative),
      stat = fs.lstatSync(file);
    if (stat.uid !== process.getuid?.() || stat.isSymbolicLink()) throw new Error('unsafe_calendar_backup_source');
    const copy = destination ? path.join(destination, relative) : undefined;
    if (stat.isDirectory()) {
      if ((stat.mode & 0o777) !== 0o700) throw new Error('unsafe_calendar_backup_source');
      hash.update(JSON.stringify([relative, 'directory']) + '\n');
      if (copy) fs.mkdirSync(copy, { mode: 0o700 });
      for (const child of fs.readdirSync(file).sort()) visit(relative + '/' + child, depth + 1);
      if (copy) sync(copy);
    } else {
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size > 1024 * 1024 ||
        ++files > 4096
      )
        throw new Error('unsafe_calendar_backup_source');
      bytes += stat.size;
      if (bytes > maximumBytes) throw new Error('calendar_backup_bounds');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const before = fs.fstatSync(fd);
        if (
          before.dev !== stat.dev ||
          before.ino !== stat.ino ||
          before.size !== stat.size ||
          before.uid !== process.getuid?.() ||
          before.nlink !== 1 ||
          (before.mode & 0o777) !== 0o600
        )
          throw new Error('calendar_backup_changed');
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = fs.readSync(fd, buffer, length, buffer.length - length, length);
          if (!read) break;
          length += read;
        }
        const after = fs.fstatSync(fd);
        if (
          length !== stat.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          after.nlink !== 1 ||
          (after.mode & 0o777) !== 0o600
        )
          throw new Error('calendar_backup_changed');
        const content = buffer.subarray(0, length);
        if (copy) {
          const output = fs.openSync(copy, 'wx', 0o600);
          try {
            fs.writeFileSync(output, content);
            fs.fsyncSync(output);
          } finally {
            fs.closeSync(output);
          }
        }
        hash.update(
          JSON.stringify([relative, 'file', length, createHash('sha256').update(content).digest('hex')]) + '\n',
        );
      } finally {
        fs.closeSync(fd);
      }
    }
  };
  for (const child of fs.readdirSync(root).sort()) visit(child, 1);
  if (destination) sync(destination);
  return { sha256: hash.digest('hex'), files, bytes };
}
/** Hold directory descriptors across verification and copying: unmounting a volume must never redirect
 * secret writes into a plaintext directory underneath its former mount point. No restore operation exists.
 */
async function protectedStorage<T>(
  o: CalendarBackupOptions,
  operation: (state: {
    policy: CalendarStoragePolicy;
    source: string;
    backups: string;
    assertPinned(): void;
  }) => Promise<T>,
): Promise<T> {
  const policy = verifyCalendarStorage(o.roots, o.inspect);
  const paths = [path.join(o.roots.targetRoot, 'calendar'), policy.backupRoot];
  const handles: number[] = [];
  try {
    for (const file of paths)
      handles.push(fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW));
    const assertPinned = () => {
      for (let i = 0; i < paths.length; i++) {
        const current = directory(paths[i]),
          pinned = fs.fstatSync(handles[i]);
        if (current.dev !== pinned.dev || current.ino !== pinned.ino) throw new Error('calendar_backup_mount_changed');
      }
      if (digest(verifyCalendarStorage(o.roots, o.inspect)) !== digest(policy))
        throw new Error('calendar_backup_storage_changed');
    };
    assertPinned();
    return await operation({
      policy,
      source: '/proc/self/fd/' + handles[0],
      backups: '/proc/self/fd/' + handles[1],
      assertPinned,
    });
  } finally {
    for (const fd of handles) fs.closeSync(fd);
  }
}
function snapshotName(o: CalendarBackupOptions) {
  return 'calendar-' + digest({ target: digest(o.roots.targetRoot), operation: o.operationId });
}
function checkedSnapshot(
  o: CalendarBackupOptions,
  policy: CalendarStoragePolicy,
  backups: string,
): CalendarBackupReceipt {
  const snapshot = snapshotName(o),
    root = path.join(backups, snapshot);
  directory(root, true);
  if (fs.readdirSync(root).sort().join(',') !== 'policy.json,receipt.json,state')
    throw new Error('invalid_calendar_backup');
  const data = inventory(path.join(root, 'state'));
  const expected: CalendarBackupReceipt = {
    ...parameters(o),
    present: true,
    storageDigest: digest(policy),
    snapshot,
    ...data,
  };
  if (
    digest(read(path.join(root, 'policy.json'))) !== digest(policy) ||
    digest(read(path.join(root, 'receipt.json'))) !== digest(expected)
  )
    throw new Error('calendar_backup_conflict');
  return expected;
}
async function verify(o: CalendarBackupOptions): Promise<CalendarBackupReceipt> {
  await o.check();
  parameters(o);
  const receipt = read(path.join(o.receiptRoot, name));
  if (absent(o)) {
    const expected = absentReceipt(o);
    if (digest(receipt) !== digest(expected)) throw new Error('calendar_backup_conflict');
    await o.check();
    if (!absent(o)) throw new Error('calendar_backup_changed');
    return expected;
  }
  return protectedStorage(o, async ({ policy, backups, assertPinned }) => {
    const expected = checkedSnapshot(o, policy, backups);
    if (digest(receipt) !== digest(expected)) throw new Error('calendar_backup_conflict');
    await o.check();
    assertPinned();
    return expected;
  });
}
export async function verifyCalendarBackup(options: CalendarBackupOptions): Promise<CalendarBackupReceipt> {
  try {
    return await verify(options);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Never expose credential contents, host paths or underlying command diagnostics.
    throw new Error('calendar_backup_unavailable');
  }
}
/** Read-only evidence of the separately granted writer's protected backup. Historical tokens are never
 * returned, installed, refreshed or used for admission. The independent current denial journals still govern.
 */
export async function verifyCalendarWriterBackup(
  options: CalendarBackupOptions,
  grant: { scopeId: string; bindingId: string; reference: string },
): Promise<CalendarBackupReceipt> {
  try {
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(grant.scopeId) ||
      [grant.bindingId, grant.reference].some(
        (id) => !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id),
      )
    )
      throw new Error('writer_backup_invalid');
    const receipt = await verify(options);
    if (!receipt.present) throw new Error('writer_backup_missing');
    return await protectedStorage(options, async ({ policy, backups, assertPinned }) => {
      if (digest(checkedSnapshot(options, policy, backups)) !== digest(receipt))
        throw new Error('writer_backup_changed');
      const stateRoot = path.join(backups, snapshotName(options), 'state'),
        marker = read(path.join(stateRoot, 'writer-credentials', '.cos-calendar-writer-credentials')),
        state = read(path.join(stateRoot, 'writer-credentials', grant.reference + '.json'), 65536),
        client = checkedClient(
          read(path.join(stateRoot, 'writer-oauth-client.json')) as Parameters<typeof checkedClient>[0],
        );
      if (
        !object(marker) ||
        Object.keys(marker).length !== 1 ||
        marker.contract !== 'cos-calendar-writer-credentials/v1' ||
        !object(state) ||
        Object.keys(state).sort().join(',') !== 'clientId,contract,generation,identity,phase,tokens' ||
        state.contract !== 'cos-calendar-writer-credentials/v1' ||
        state.clientId !== client.clientId ||
        state.phase !== 'ready' ||
        state.identity !==
          digest({
            scope: grant.scopeId,
            binding: grant.bindingId,
            reference: grant.reference,
            profile: 'owned_event_writer',
          }) ||
        !Number.isSafeInteger(state.generation) ||
        Number(state.generation) < 1 ||
        !validCalendarTokens(state.tokens, 'owned_event_writer')
      )
        throw new Error('writer_backup_invalid');
      await options.check();
      assertPinned();
      if (digest(checkedSnapshot(options, policy, backups)) !== digest(receipt))
        throw new Error('writer_backup_changed');
      return receipt;
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Archived tokens, OAuth clients and protected paths cannot enter diagnostics or a nested cause.
    throw new Error('calendar_writer_backup_unavailable');
  }
}
/** Caller holds target/maintenance/host authority and has quiesced all credential and journal writers. */
export async function backupCalendarState(o: CalendarBackupOptions): Promise<CalendarBackupReceipt> {
  try {
    await o.check();
    parameters(o);
    if (fs.lstatSync(path.join(o.receiptRoot, name), { throwIfNoEntry: false })) return await verify(o);
    if (absent(o)) {
      const receipt = absentReceipt(o);
      await o.check();
      if (!absent(o)) throw new Error('calendar_backup_changed');
      writeAtomic(o.receiptRoot, name, receipt);
      return await verify(o);
    }
    return await protectedStorage(o, async ({ policy, source, backups, assertPinned }) => {
      const snapshot = snapshotName(o),
        destination = path.join(backups, snapshot);
      if (!fs.lstatSync(destination, { throwIfNoEntry: false })) {
        const before = inventory(source),
          space = fs.statfsSync(backups);
        if (space.bavail * space.bsize < before.bytes + 16 * 1024 * 1024) throw new Error('calendar_backup_space');
        const temporary = path.join(backups, '.calendar-stage-' + randomUUID());
        fs.mkdirSync(temporary, { mode: 0o700 });
        fs.mkdirSync(path.join(temporary, 'state'), { mode: 0o700 });
        const copied = inventory(source, path.join(temporary, 'state'));
        if (digest(before) !== digest(copied) || digest(before) !== digest(inventory(source)))
          throw new Error('calendar_backup_changed');
        await o.check();
        assertPinned();
        const receipt: CalendarBackupReceipt = {
          ...parameters(o),
          present: true,
          storageDigest: digest(policy),
          snapshot,
          ...copied,
        };
        writeAtomic(temporary, 'policy.json', policy);
        writeAtomic(temporary, 'receipt.json', receipt);
        if (digest(inventory(path.join(temporary, 'state'))) !== digest(copied))
          throw new Error('calendar_backup_conflict');
        fs.renameSync(temporary, destination);
      }
      // A prior attempt may have renamed the complete snapshot but failed its directory fsync.
      // Re-establish durability even when reconciling an already-published destination.
      sync(backups);
      const receipt = checkedSnapshot(o, policy, backups);
      await o.check();
      assertPinned();
      writeAtomic(o.receiptRoot, name, receipt);
      return receipt;
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Backup failures must never disclose tokens, source bytes or private filesystem paths.
    throw new Error('calendar_backup_unavailable');
  }
}
