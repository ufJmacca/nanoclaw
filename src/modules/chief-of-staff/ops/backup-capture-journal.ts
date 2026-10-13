import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import type { BackupKind } from './backup-policy.js';
import { BACKUP_LIMITS } from './backup-policy.js';
import type { BackupQueueReceipt } from './backup-queue.js';
type Inode = { device: number; inode: number };
type FileClaim = Inode & { bytes: number; sha256: string };
type Capture = {
  contract: 'cos-backup-capture-ownership/v1';
  ownerDigest: string;
  kind: BackupKind;
  operationId: string;
  root: Inode;
  createdAt: string;
  maximumBytes: number;
  phase: 'capturing' | 'pending' | 'retiring' | 'retired';
  directories: Record<string, Inode>;
  files: Record<string, FileClaim>;
  pendingReceipt: { temporary: string; claim: FileClaim; receipt: BackupQueueReceipt } | null;
};
export const captureJournalName = '.cos-capture.json';
const prefix = '.cos-capture-journal-',
  emptyHash = createHash('sha256').digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const inode = (stat: fs.Stats): Inode => ({ device: stat.dev, inode: stat.ino });
const same = (stat: fs.Stats, claim: Inode) => stat.dev === claim.device && stat.ino === claim.inode;
const validInode = (claim: Inode) =>
  claim &&
  Object.keys(claim).sort().join(',') === 'device,inode' &&
  Number.isSafeInteger(claim.device) &&
  claim.device >= 0 &&
  Number.isSafeInteger(claim.inode) &&
  claim.inode > 0;
const validFile = (claim: FileClaim) =>
  claim &&
  Object.keys(claim).sort().join(',') === 'bytes,device,inode,sha256' &&
  validInode({ device: claim.device, inode: claim.inode }) &&
  Number.isSafeInteger(claim.bytes) &&
  claim.bytes >= 0 &&
  /^[a-f0-9]{64}$/.test(claim.sha256);
const dataName = (name: string) =>
  name === 'data' ||
  (name.startsWith('data/') &&
    name.length <= 197 &&
    name.split('/').length <= 9 &&
    name.split('/').every((part) => /^(?:[A-Za-z0-9]|\.cos-)[A-Za-z0-9_.-]*$/.test(part)));
const directory = (file: string) => {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY |
      fs.constants.O_DIRECTORY |
      (/^\/proc\/self\/fd\/\d+$/.test(file) ? 0 : fs.constants.O_NOFOLLOW),
  );
  const stat = fs.fstatSync(fd);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700) {
    fs.closeSync(fd);
    throw Error('unsafe_capture_directory');
  }
  return fd;
};
function json<T>(file: string, device: number): T {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.dev !== device ||
      stat.uid !== process.getuid?.() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.size > 1024 ** 2
    )
      throw Error('unsafe_capture_journal');
    const value = JSON.parse(fs.readFileSync(fd, 'utf8')) as T;
    const after = fs.fstatSync(fd);
    if (
      !same(fs.lstatSync(file), inode(stat)) ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      after.mode !== stat.mode ||
      after.uid !== stat.uid ||
      after.nlink !== 1
    )
      throw Error('capture_journal_changed');
    return value;
  } finally {
    fs.closeSync(fd);
  }
}
/** Private publication leftovers are bounded observations, never ownership or
 * deletion authority. They remain charged to the queue and are not removed. */
export function captureJournalNames(root: string, device: number): string[] {
  const names = fs.readdirSync(root).filter((name) => name === captureJournalName || name.startsWith(prefix));
  if (names.length > 3) throw Error('capture_journal_bounds');
  for (const name of names) {
    if (name !== captureJournalName && !/^\.cos-capture-journal-[a-f0-9-]{36}\.tmp$/.test(name))
      throw Error('capture_journal_conflict');
    const stat = fs.lstatSync(path.join(root, name));
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.dev !== device ||
      stat.nlink !== 1 ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.size > 1024 ** 2
    )
      throw Error('unsafe_capture_journal');
  }
  return names;
}
export function readCaptureJournal(root: string, owner: string, kind: BackupKind): Capture | undefined {
  const stat = fs.statSync(root);
  captureJournalNames(root, stat.dev);
  const file = path.join(root, captureJournalName);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return;
  const value = json<Capture>(file, stat.dev);
  if (
    !value ||
    Object.keys(value).sort().join(',') !==
      'contract,createdAt,directories,files,kind,maximumBytes,operationId,ownerDigest,pendingReceipt,phase,root' ||
    value.contract !== 'cos-backup-capture-ownership/v1' ||
    value.ownerDigest !== owner ||
    value.kind !== kind ||
    !uuid.test(value.operationId) ||
    !validInode(value.root) ||
    !same(stat, value.root) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isSafeInteger(value.maximumBytes) ||
    value.maximumBytes < 16384 ||
    value.maximumBytes > (kind === 'state' ? BACKUP_LIMITS.staging : BACKUP_LIMITS.credentials) ||
    !['capturing', 'pending', 'retiring', 'retired'].includes(value.phase) ||
    !value.directories ||
    !value.files ||
    Array.isArray(value.directories) ||
    Array.isArray(value.files) ||
    !Object.hasOwn(value.directories, '') ||
    !Object.hasOwn(value.directories, 'data') ||
    Object.keys(value.directories).length > 32769 ||
    Object.keys(value.files).length > 4097 ||
    Object.entries(value.directories).some(
      ([name, claim]) => (name !== '' && !dataName(name)) || !validInode(claim) || claim.device !== stat.dev,
    ) ||
    Object.entries(value.files).some(
      ([name, claim]) =>
        (name !== 'receipt.json' && (!dataName(name) || name === 'data')) ||
        !validFile(claim) ||
        claim.device !== stat.dev ||
        claim.bytes > value.maximumBytes,
    ) ||
    (value.pendingReceipt !== null &&
      (!value.pendingReceipt ||
        Object.keys(value.pendingReceipt).sort().join(',') !== 'claim,receipt,temporary' ||
        !/^\.cos-capture-receipt-[a-f0-9-]{36}\.tmp$/.test(value.pendingReceipt.temporary) ||
        !validFile(value.pendingReceipt.claim) ||
        value.pendingReceipt.claim.device !== stat.dev ||
        value.pendingReceipt.claim.bytes > 1024 ** 2 ||
        !validReceipt(value.pendingReceipt.receipt, value) ||
        value.pendingReceipt.receipt?.format !== 'cos-backup-queue/v1' ||
        value.pendingReceipt.receipt.ownerDigest !== owner ||
        value.pendingReceipt.receipt.kind !== kind ||
        value.pendingReceipt.receipt.operationId !== value.operationId ||
        hash(JSON.stringify(value.pendingReceipt.receipt) + '\n') !== value.pendingReceipt.claim.sha256))
  )
    throw Error('invalid_capture_journal');
  return value;
}
function validReceipt(receipt: BackupQueueReceipt, record: Capture) {
  return (
    !!receipt &&
    Object.keys(receipt).sort().join(',') ===
      'bytes,createdAt,files,format,kind,maximumBytes,operationId,ownerDigest,state' &&
    receipt.format === 'cos-backup-queue/v1' &&
    receipt.ownerDigest === record.ownerDigest &&
    receipt.kind === record.kind &&
    receipt.operationId === record.operationId &&
    receipt.createdAt === record.createdAt &&
    receipt.maximumBytes === record.maximumBytes &&
    ['capturing', 'failed', 'pending'].includes(receipt.state) &&
    Number.isSafeInteger(receipt.bytes) &&
    receipt.bytes >= 0 &&
    Array.isArray(receipt.files) &&
    receipt.files.length <= 4096 &&
    new Set(receipt.files.map((file) => file?.name)).size === receipt.files.length &&
    receipt.files.every(
      (file) =>
        file &&
        typeof file.name === 'string' &&
        Object.keys(file).sort().join(',') === 'bytes,name,sha256' &&
        dataName('data/' + file.name) &&
        Number.isSafeInteger(file.bytes) &&
        file.bytes >= 0 &&
        file.bytes <= record.maximumBytes &&
        /^[a-f0-9]{64}$/.test(file.sha256),
    ) &&
    (receipt.state !== 'pending' || (receipt.files.length > 0 && receipt.bytes <= receipt.maximumBytes))
  );
}
function validPendingFiles(receipt: BackupQueueReceipt, record: Capture) {
  return (
    validReceipt(receipt, record) &&
    receipt.state === 'pending' &&
    receipt.files.length === Object.keys(record.files).filter((name) => name.startsWith('data/')).length &&
    receipt.files.every((file) => {
      const claimed = record.files['data/' + file.name];
      return claimed && file.bytes === claimed.bytes && file.sha256 === claimed.sha256;
    })
  );
}
function publish(root: string, value: Capture) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  if (bytes.length > 1024 ** 2) throw Error('capture_journal_bounds');
  const file = path.join(root, prefix + randomUUID() + '.tmp'),
    fd = fs.openSync(file, 'wx', 0o600),
    initial = fs.fstatSync(fd);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.renameSync(file, path.join(root, captureJournalName));
    const parent = directory(root);
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
  } finally {
    bytes.fill(0);
    try {
      const current = fs.lstatSync(file, { throwIfNoEntry: false });
      if (current && same(current, inode(initial)) && current.isFile() && current.nlink === 1) {
        fs.unlinkSync(file);
        const parent = directory(root);
        try {
          fs.fsyncSync(parent);
        } finally {
          fs.closeSync(parent);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}
export function assertCaptureAvailable(root: string, owner: string, kind: BackupKind) {
  const previous = readCaptureJournal(root, owner, kind);
  if (previous && !['pending', 'retired'].includes(previous.phase)) throw Error('capture_requires_reconciliation');
}
/** Receipts keep their existing format. The extra journal proves only the
 * locally created copies, not source/maintenance/restore or cleanup authority. */
export function createCaptureJournal(root: string, receipt: BackupQueueReceipt, slotFd: number, dataFd: number) {
  const record: Capture = {
    contract: 'cos-backup-capture-ownership/v1',
    ownerDigest: receipt.ownerDigest,
    kind: receipt.kind,
    operationId: receipt.operationId,
    root: inode(fs.statSync(root)),
    createdAt: receipt.createdAt,
    maximumBytes: receipt.maximumBytes,
    phase: 'capturing',
    directories: { '': inode(fs.fstatSync(slotFd)), data: inode(fs.fstatSync(dataFd)) },
    files: {},
    pendingReceipt: null,
  };
  const save = () => publish(root, record);
  save();
  return {
    directory(name: string, fd: number) {
      record.directories['data/' + name] = inode(fs.fstatSync(fd));
      save();
    },
    file(name: string, fd: number, bytes: number, sha256: string) {
      record.files['data/' + name] = { ...inode(fs.fstatSync(fd)), bytes, sha256 };
      save();
    },
    receipt(value: BackupQueueReceipt) {
      if (record.pendingReceipt) throw Error('capture_receipt_requires_reconciliation');
      const bytes = Buffer.from(JSON.stringify(value) + '\n'),
        temporary = '.cos-capture-receipt-' + randomUUID() + '.tmp',
        file = path.join('/proc/self/fd/' + slotFd, temporary),
        fd = fs.openSync(file, 'wx', 0o600);
      try {
        record.pendingReceipt = {
          temporary,
          claim: { ...inode(fs.fstatSync(fd)), bytes: bytes.length, sha256: hash(bytes) },
          receipt: structuredClone(value),
        };
        save();
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
        fs.renameSync(file, path.join('/proc/self/fd/' + slotFd, 'receipt.json'));
        fs.fsyncSync(slotFd);
        record.files['receipt.json'] = record.pendingReceipt.claim;
        record.pendingReceipt = null;
        record.phase = value.state === 'pending' ? 'pending' : 'capturing';
        save();
      } finally {
        bytes.fill(0);
        fs.closeSync(fd);
      }
    },
  };
}
/** Current caller permission and the kernel writer lease are mandatory. Every
 * file is hashed and every directory/entry checked before retirement begins.
 * Changed, unknown and partially written files remain held. */
export function reconcileOwnedCapture(
  root: string,
  owner: string,
  kind: BackupKind,
  operationId: string,
  assertCurrent: () => void,
) {
  if (typeof assertCurrent !== 'function') throw Error('capture_authority_required');
  assertCurrent();
  const record = readCaptureJournal(root, owner, kind);
  if (!record || record.operationId !== operationId) throw Error('capture_ownership_required');
  const slotName = kind === 'state' ? 'full' : operationId,
    location = path.join(root, slotName);
  if (record.phase === 'retired') {
    if (fs.lstatSync(location, { throwIfNoEntry: false })) throw Error('retired_capture_replaced');
    assertCurrent();
    return { status: 'capture_retired' as const, kind, operationId };
  }
  const held: Array<{ fd: number; file: string; stat: fs.Stats; directory: boolean; relative: string }> = [],
    removed = new Set<string>();
  let selectedDigest = digest(record);
  const current = () => {
    assertCurrent();
    if (digest(readCaptureJournal(root, owner, kind)) !== selectedDigest) throw Error('capture_ownership_changed');
    for (const item of held) {
      if (removed.has(item.relative)) continue;
      const stat = fs.fstatSync(item.fd),
        named = fs.lstatSync(item.file);
      if (
        !same(named, inode(item.stat)) ||
        !same(stat, inode(item.stat)) ||
        stat.mode !== item.stat.mode ||
        stat.uid !== item.stat.uid ||
        (!item.directory &&
          (stat.size !== item.stat.size ||
            stat.mtimeMs !== item.stat.mtimeMs ||
            stat.ctimeMs !== item.stat.ctimeMs ||
            stat.nlink !== 1))
      )
        throw Error('capture_copy_changed');
    }
  };
  const save = () => {
    current();
    publish(root, record);
    selectedDigest = digest(record);
  };
  try {
    const missingAllowed = record.phase === 'retiring';
    const openDirectory = (relative: string, claim: Inode) => {
      const parent =
        relative === ''
          ? root
          : '/proc/self/fd/' +
            held.find((item) => item.directory && item.relative === path.posix.dirname(relative).replace(/^\.$/, ''))!
              .fd;
      const file = relative === '' ? location : path.join(parent, path.posix.basename(relative));
      if (!fs.lstatSync(file, { throwIfNoEntry: false })) {
        if (missingAllowed) return;
        throw Error('capture_directory_missing');
      }
      const fd = directory(file),
        stat = fs.fstatSync(fd);
      if (!same(stat, claim)) {
        fs.closeSync(fd);
        throw Error('capture_directory_replaced');
      }
      held.push({ fd, file, stat, directory: true, relative });
    };
    for (const [relative, claim] of Object.entries(record.directories).sort(
      ([a], [b]) => a.split('/').length - b.split('/').length || a.localeCompare(b),
    )) {
      if (
        relative !== '' &&
        !held.some((item) => item.directory && item.relative === path.posix.dirname(relative).replace(/^\.$/, ''))
      ) {
        if (missingAllowed) continue;
        throw Error('capture_parent_missing');
      }
      openDirectory(relative, claim);
    }
    const pending = record.pendingReceipt;
    const expected = new Map(Object.entries(record.files));
    if (pending) expected.set(pending.temporary, pending.claim);
    for (const item of held.filter((item) => item.directory)) {
      const entries = fs.readdirSync('/proc/self/fd/' + item.fd);
      for (const name of entries) {
        const relative = item.relative ? item.relative + '/' + name : name;
        if (!Object.hasOwn(record.directories, relative) && !expected.has(relative)) {
          if (relative === 'receipt.json' && pending) expected.set(relative, pending.claim);
          else throw Error('unclaimed_capture_copy');
        }
      }
    }
    for (const [relative, claim] of expected) {
      const parent = held.find(
        (item) => item.directory && item.relative === path.posix.dirname(relative).replace(/^\.$/, ''),
      );
      if (!parent) {
        if (missingAllowed) continue;
        throw Error('capture_parent_missing');
      }
      const file = path.join('/proc/self/fd/' + parent.fd, path.posix.basename(relative));
      if (!fs.lstatSync(file, { throwIfNoEntry: false })) {
        if (missingAllowed || (pending && relative === pending.temporary)) continue;
        throw Error('capture_file_missing');
      }
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK),
        stat = fs.fstatSync(fd);
      held.push({ fd, file, stat, directory: false, relative });
      let wanted = claim;
      if (pending && relative === 'receipt.json' && same(stat, pending.claim)) wanted = pending.claim;
      const empty = relative === pending?.temporary && stat.size === 0;
      if (
        !stat.isFile() ||
        !same(stat, wanted) ||
        stat.uid !== process.getuid?.() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o7777) !== 0o600 ||
        (!empty && stat.size !== wanted.bytes)
      )
        throw Error('capture_file_replaced');
      const checksum = createHash('sha256'),
        buffer = Buffer.alloc(65536);
      let count: number;
      try {
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
          checksum.update(buffer.subarray(0, count));
      } finally {
        buffer.fill(0);
      }
      if (checksum.digest('hex') !== (empty ? emptyHash : wanted.sha256)) throw Error('capture_file_changed');
    }
    current();
    const receiptItem = held.find((item) => item.relative === 'receipt.json' && !item.directory);
    const receipt = receiptItem ? json<BackupQueueReceipt>(receiptItem.file, record.root.device) : undefined;
    if (receipt?.state === 'pending') {
      if (!validPendingFiles(receipt, record)) throw Error('capture_receipt_changed');
      if (pending?.receipt.state === 'pending' && receiptItem && same(receiptItem.stat, pending.claim)) {
        record.files['receipt.json'] = pending.claim;
        record.pendingReceipt = null;
        record.phase = 'pending';
        save();
      }
      current();
      return { status: 'capture_pending' as const, kind, operationId };
    }
    if (pending?.receipt.state === 'pending') {
      const temporary = held.find((item) => item.relative === pending.temporary);
      if (temporary && temporary.stat.size === pending.claim.bytes) {
        if (!validPendingFiles(pending.receipt, record)) throw Error('capture_manifest_changed');
        current();
        fs.renameSync(
          temporary.file,
          path.join('/proc/self/fd/' + held.find((item) => item.relative === '')!.fd, 'receipt.json'),
        );
        if (receiptItem) {
          receiptItem.relative = 'replaced-receipt';
          removed.add(receiptItem.relative);
        }
        temporary.relative = 'receipt.json';
        temporary.file = path.join('/proc/self/fd/' + held.find((item) => item.relative === '')!.fd, 'receipt.json');
        temporary.stat = fs.fstatSync(temporary.fd);
        fs.fsyncSync(held.find((item) => item.relative === '')!.fd);
        record.files['receipt.json'] = pending.claim;
        record.pendingReceipt = null;
        record.phase = 'pending';
        save();
        return { status: 'capture_pending' as const, kind, operationId };
      }
    }
    record.phase = 'retiring';
    save();
    for (const item of held.filter((item) => !item.directory)) {
      current();
      fs.unlinkSync(item.file);
      removed.add(item.relative);
      const parent = held.find(
        (dir) => dir.directory && dir.relative === path.posix.dirname(item.relative).replace(/^\.$/, ''),
      );
      fs.fsyncSync(parent!.fd);
    }
    for (const item of held.filter((item) => item.directory).reverse()) {
      current();
      fs.rmdirSync(item.file);
      removed.add(item.relative);
    }
    const rootFd = directory(root);
    try {
      fs.fsyncSync(rootFd);
    } finally {
      fs.closeSync(rootFd);
    }
    record.phase = 'retired';
    save();
    return { status: 'capture_retired' as const, kind, operationId };
  } finally {
    for (const item of held.reverse()) fs.closeSync(item.fd);
  }
}
