import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import { digest } from '../domain/contracts.js';
import { writeAtomic } from './target-state.js';
import { BACKUP_LIMITS, type BackupKind } from './backup-policy.js';
import { verifyVaultStorage, withVaultDirectory } from './vault-storage.js';
import type { RemoteCheckpoint } from './backup-restic-transfer.js';
import { streamBackupArchive } from './backup-archive.js';
import { BackupRepositoryWriter } from './backup-repository-lease.js';
import {
  assertCaptureAvailable,
  captureJournalNames,
  createCaptureJournal,
  readCaptureJournal,
  reconcileOwnedCapture,
} from './backup-capture-journal.js';
import {
  credentialEventName,
  credentialHead,
  credentialMetadata,
  credentialOrder,
  credentialSource,
  makeCredentialEvent,
  publishCredentialHead,
  readCredentialMetadata,
  recoverCredentialTemporaries,
  type CredentialChange,
  type CredentialHead,
} from './backup-credential-event.js';
export type BackupRemoteIdentity = Omit<RemoteCheckpoint, 'verifiedAt' | 'reconciled'>;
export type BackupRetirementRequest = {
  receipt: BackupQueueReceipt;
  archive: { bytes: number; sha256: string };
  previous?: BackupRemoteIdentity;
};
export type BackupRetirementProof = {
  checkpoint: RemoteCheckpoint;
  assertCurrent(): void;
};
/** Delivery observations are not cleanup, restore or repository authority. */
export type BackupDeliveryItem = {
  kind: BackupKind;
  operationId: string;
  disposition: 'upload' | 'reconcile' | 'held';
  createdAt: string;
  bytes: number;
};
export type BackupDeliveryObservation = {
  items: BackupDeliveryItem[];
  lastRemoteCheckpointAt: string | null;
  /** Older observation ports may omit this; omission never establishes freshness. */
  lastAcknowledgedCaptureAt?: string | null;
};
type Retirement = {
  contract: 'cos-backup-queue-retirement/v2';
  receipt: BackupQueueReceipt;
  remote: BackupRemoteIdentity;
  slot: { device: number; inode: number };
  retired: boolean;
};
type LegacyRetirement = Omit<Retirement, 'contract' | 'remote' | 'retired'> & {
  contract: 'cos-backup-queue-retirement/v1';
  remote: RemoteCheckpoint;
  retiredAt: string | null;
};
const intentName = '.cos-retirement.json',
  ackName = '.cos-last-ack.json';
function remoteIdentity(remote: BackupRemoteIdentity): BackupRemoteIdentity {
  return {
    contract: remote.contract,
    repositoryId: remote.repositoryId,
    ownerDigest: remote.ownerDigest,
    kind: remote.kind,
    operationId: remote.operationId,
    snapshotId: remote.snapshotId,
    snapshotAt: remote.snapshotAt,
    archiveBytes: remote.archiveBytes,
    archiveSha256: remote.archiveSha256,
  };
}
const publicationTemporary = (name: string) =>
  /^\.cos-publish-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(name);
/** Observation only: neither an incomplete publication nor its filename grants authority. */
function publicationTemporaries(root: string, device: number): string[] {
  const names = fs.readdirSync(root).filter(publicationTemporary);
  if (names.length > 2) throw Error('publication_temporary_bounds');
  for (const name of names) {
    const stat = fs.lstatSync(path.join(root, name));
    if (
      !stat.isFile() ||
      stat.dev !== device ||
      stat.uid !== process.getuid?.() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 1024 ** 2
    )
      throw Error('unsafe_publication_temporary');
  }
  return names;
}
/** A reported publication failure removes only this call's still-held temporary
 * inode. Canonical records and unexplained replacements are never removed here. */
function publishRetirement(root: string, name: string, value: Retirement): void {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  if (bytes.length > 1024 ** 2) throw Error('retirement_metadata_bounds');
  const temporary = path.join(root, '.cos-publish-' + randomUUID() + '.tmp');
  const fd = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  const initial = fs.fstatSync(fd);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.renameSync(temporary, path.join(root, name));
    const directory = privateDirectory(root, initial.dev);
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  } finally {
    bytes.fill(0);
    try {
      const current = fs.lstatSync(temporary, { throwIfNoEntry: false });
      if (
        current &&
        current.dev === initial.dev &&
        current.ino === initial.ino &&
        current.uid === initial.uid &&
        current.nlink === 1 &&
        current.isFile()
      ) {
        fs.unlinkSync(temporary);
        const directory = privateDirectory(root, initial.dev);
        try {
          fs.fsyncSync(directory);
        } finally {
          fs.closeSync(directory);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}
export type BackupQueueReceipt = {
  format: 'cos-backup-queue/v1';
  ownerDigest: string;
  kind: BackupKind;
  operationId: string;
  state: 'capturing' | 'pending' | 'failed';
  createdAt: string;
  maximumBytes: number;
  bytes: number;
  files: Array<{ name: string; bytes: number; sha256: string }>;
};
export type BackupSnapshotSink = { write(name: string, bytes: Buffer): void };
type VaultQueueAccess = <T>(kind: BackupKind, operation: (directory: string) => Promise<T>) => Promise<T>;
const uuid = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function privateDirectory(file: string, device?: number) {
  // Exact self-descriptor aliases refer to a held kernel directory, never a configurable symlink.
  const descriptor = /^\/proc\/self\/fd\/\d+$/.test(file);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (descriptor ? 0 : fs.constants.O_NOFOLLOW),
  );
  const stat = fs.fstatSync(fd);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    (device !== undefined && stat.dev !== device)
  ) {
    fs.closeSync(fd);
    throw Error('unsafe_queue_directory');
  }
  return fd;
}
const pinned = (fd: number) => '/proc/self/fd/' + fd;
const allocated = (stat: fs.Stats) => Math.max(stat.size, stat.blocks * 512, Math.ceil(stat.size / 4096) * 4096);
function measure(directory: string, device: number, visited = { count: 0 }): number {
  const fd = privateDirectory(directory, device);
  try {
    let total = allocated(fs.fstatSync(fd));
    for (const name of fs.readdirSync(pinned(fd))) {
      if (++visited.count > 16384 || /[\0/]/.test(name)) throw Error('queue_bounds');
      const file = path.join(pinned(fd), name),
        stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || stat.dev !== device || stat.uid !== process.getuid?.())
        throw Error('unsafe_queue_file');
      if (stat.isDirectory()) total += measure(file, device, visited);
      else if (stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600) total += allocated(stat);
      else throw Error('unsafe_queue_file');
    }
    return total;
  } finally {
    fs.closeSync(fd);
  }
}
function privateJson<T>(file: string, device: number): T {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.dev !== device ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o777) !== 0o600 ||
      before.size > 1024 ** 2
    )
      throw Error('unsafe_queue_receipt');
    const bytes = Buffer.alloc(before.size + 1),
      count = fs.readSync(fd, bytes, 0, bytes.length, 0),
      after = fs.fstatSync(fd),
      current = fs.lstatSync(file);
    if (
      count !== before.size ||
      after.size !== before.size ||
      after.mode !== before.mode ||
      after.uid !== before.uid ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.dev !== before.dev ||
      current.ino !== before.ino
    )
      throw Error('queue_receipt_changed');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))) as T;
  } finally {
    fs.closeSync(fd);
  }
}
function validName(name: string): boolean {
  const parts = name.split('/');
  return (
    Buffer.byteLength(name) <= 192 &&
    parts.length <= 8 &&
    parts.every((part) => /^(?:[A-Za-z0-9]|\.cos-)[A-Za-z0-9_.-]*$/.test(part))
  );
}
function checksum(file: string, expected: { bytes: number; sha256: string }, device: number) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.dev !== device ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o777) !== 0o600 ||
      before.size !== expected.bytes
    )
      throw Error('unsafe_pending_file');
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(65536);
    let count: number;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    const after = fs.fstatSync(fd),
      current = fs.lstatSync(file);
    if (
      hash.digest('hex') !== expected.sha256 ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.dev !== before.dev ||
      current.ino !== before.ino
    )
      throw Error('pending_file_changed');
  } finally {
    fs.closeSync(fd);
  }
}
function validateReceipt(value: BackupQueueReceipt, owner: string, kind: BackupKind, name?: string): void {
  if (
    !value ||
    value.format !== 'cos-backup-queue/v1' ||
    value.ownerDigest !== owner ||
    value.kind !== kind ||
    typeof value.operationId !== 'string' ||
    !uuid(value.operationId) ||
    (kind === 'credentials' && name !== undefined && value.operationId !== name) ||
    !['capturing', 'pending', 'failed'].includes(value.state) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    !Number.isSafeInteger(value.maximumBytes) ||
    value.maximumBytes < 16384 ||
    value.maximumBytes > (kind === 'state' ? BACKUP_LIMITS.staging : BACKUP_LIMITS.credentials) ||
    !Array.isArray(value.files) ||
    value.files.length > 4096 ||
    new Set(value.files.map((file) => file?.name)).size !== value.files.length ||
    value.files.some(
      (file) =>
        !file ||
        typeof file.name !== 'string' ||
        !validName(file.name) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        typeof file.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(file.sha256),
    )
  )
    throw Error('invalid_queue_receipt');
}
function validateRemote(
  remote: RemoteCheckpoint,
  receipt: BackupQueueReceipt,
  archive: { bytes: number; sha256: string },
): void {
  if (
    !remote ||
    typeof remote !== 'object' ||
    Array.isArray(remote) ||
    Object.keys(remote).sort().join(',') !==
      'archiveBytes,archiveSha256,contract,kind,operationId,ownerDigest,reconciled,repositoryId,snapshotAt,snapshotId,verifiedAt' ||
    remote.contract !== 'cos-backup-remote-checkpoint/v1' ||
    remote.kind !== receipt.kind ||
    remote.operationId !== receipt.operationId ||
    [remote.repositoryId, remote.ownerDigest, remote.snapshotId, remote.archiveSha256].some(
      (value) => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value),
    ) ||
    !Number.isSafeInteger(remote.archiveBytes) ||
    remote.archiveBytes < 2048 ||
    remote.archiveBytes >
      (receipt.kind === 'state' ? BACKUP_LIMITS.staging : BACKUP_LIMITS.credentials) + 2 * 1024 ** 2 ||
    remote.archiveBytes !== archive.bytes ||
    remote.archiveSha256 !== archive.sha256 ||
    typeof remote.reconciled !== 'boolean' ||
    [remote.snapshotAt, remote.verifiedAt].some(
      (value) => typeof value !== 'string' || !Number.isFinite(Date.parse(value)),
    )
  )
    throw Error('invalid_remote_checkpoint');
}
function validateRemoteIdentity(remote: BackupRemoteIdentity, receipt: BackupQueueReceipt): void {
  if (
    !remote ||
    typeof remote !== 'object' ||
    Array.isArray(remote) ||
    Object.keys(remote).sort().join(',') !==
      'archiveBytes,archiveSha256,contract,kind,operationId,ownerDigest,repositoryId,snapshotAt,snapshotId' ||
    remote.contract !== 'cos-backup-remote-checkpoint/v1' ||
    remote.kind !== receipt.kind ||
    remote.operationId !== receipt.operationId ||
    [remote.repositoryId, remote.ownerDigest, remote.snapshotId, remote.archiveSha256].some(
      (value) => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value),
    ) ||
    !Number.isSafeInteger(remote.archiveBytes) ||
    remote.archiveBytes < 2048 ||
    remote.archiveBytes >
      (receipt.kind === 'state' ? BACKUP_LIMITS.staging : BACKUP_LIMITS.credentials) + 2 * 1024 ** 2 ||
    typeof remote.snapshotAt !== 'string' ||
    !Number.isFinite(Date.parse(remote.snapshotAt))
  )
    throw Error('invalid_remote_identity');
}
function validateRetirement(
  value: Retirement | LegacyRetirement,
  name: string,
  owner: string,
  kind: BackupKind,
  device: number,
): Retirement {
  const legacy = value?.contract === 'cos-backup-queue-retirement/v1';
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      (legacy ? 'contract,receipt,remote,retiredAt,slot' : 'contract,receipt,remote,retired,slot') ||
    !['cos-backup-queue-retirement/v1', 'cos-backup-queue-retirement/v2'].includes(value.contract) ||
    !value.slot ||
    Object.keys(value.slot).sort().join(',') !== 'device,inode' ||
    !Number.isSafeInteger(value.slot.device) ||
    value.slot.device !== device ||
    !Number.isSafeInteger(value.slot.inode) ||
    value.slot.inode < 1 ||
    (legacy
      ? name === intentName
        ? value.retiredAt !== null
        : typeof value.retiredAt !== 'string' || !Number.isFinite(Date.parse(value.retiredAt))
      : typeof value.retired !== 'boolean' || value.retired !== (name === ackName))
  )
    throw Error('invalid_retirement');
  validateReceipt(value.receipt, owner, kind);
  if (
    value.receipt.state !== 'pending' ||
    !value.receipt.files.length ||
    value.receipt.bytes > value.receipt.maximumBytes
  )
    throw Error('invalid_retirement_receipt');
  if (legacy)
    validateRemote(value.remote, value.receipt, {
      bytes: value.remote?.archiveBytes,
      sha256: value.remote?.archiveSha256,
    });
  else validateRemoteIdentity(value.remote, value.receipt);
  return {
    contract: 'cos-backup-queue-retirement/v2',
    receipt: value.receipt,
    remote: remoteIdentity(value.remote),
    slot: { device: value.slot.device, inode: value.slot.inode },
    retired: name === ackName,
  };
}
function retirement(
  root: string,
  name: string,
  owner: string,
  kind: BackupKind,
  device: number,
): Retirement | undefined {
  const file = path.join(root, name);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return undefined;
  return validateRetirement(privateJson<Retirement | LegacyRetirement>(file, device), name, owner, kind, device);
}
/** A torn v2 publication is a prefix of deterministic metadata authenticated by
 * the current remote archive and receipt. Check all candidates before any removal. */
function recoverPublicationTemporaries(
  root: string,
  metadata: Retirement,
  device: number,
  owner: string,
  assertCurrent: () => void,
): void {
  const templates = [false, true].map((retired) => Buffer.from(JSON.stringify({ ...metadata, retired }) + '\n'));
  const held: Array<{ fd: number; file: string; initial: fs.Stats; bytes: Buffer }> = [];
  try {
    for (const name of publicationTemporaries(root, device)) {
      const file = path.join(root, name),
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const initial = fs.fstatSync(fd),
        bytes = Buffer.alloc(Math.min(initial.size + 1, 1024 ** 2 + 1));
      held.push({ fd, file, initial, bytes });
      if (
        !initial.isFile() ||
        initial.dev !== device ||
        initial.uid !== process.getuid?.() ||
        initial.nlink !== 1 ||
        (initial.mode & 0o777) !== 0o600 ||
        initial.size > 1024 ** 2
      )
        throw Error('unsafe_publication_temporary');
      const count = fs.readSync(fd, bytes, 0, bytes.length, 0),
        contents = bytes.subarray(0, count);
      const current = fs.lstatSync(file),
        after = fs.fstatSync(fd);
      if (
        count !== initial.size ||
        current.dev !== initial.dev ||
        current.ino !== initial.ino ||
        after.size !== initial.size ||
        after.mtimeMs !== initial.mtimeMs ||
        after.ctimeMs !== initial.ctimeMs
      )
        throw Error('publication_temporary_changed');
      let matched = templates.some(
        (template) => contents.length <= template.length && contents.equals(template.subarray(0, contents.length)),
      );
      if (!matched) {
        // Complete historical records remain readable; an unknown or torn v1 file stays closed.
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents)) as LegacyRetirement;
        if (parsed?.contract === 'cos-backup-queue-retirement/v1') {
          const value = validateRetirement(
            parsed,
            parsed.retiredAt === null ? intentName : ackName,
            owner,
            metadata.receipt.kind,
            device,
          );
          matched = [false, true].some((retired) => digest(value) === digest({ ...metadata, retired }));
        }
      }
      if (!matched) throw Error('unrecognized_publication_temporary');
    }
    for (const item of held) {
      assertCurrent();
      const current = fs.lstatSync(item.file),
        after = fs.fstatSync(item.fd);
      if (
        current.dev !== item.initial.dev ||
        current.ino !== item.initial.ino ||
        after.nlink !== 1 ||
        after.mode !== item.initial.mode ||
        after.uid !== item.initial.uid ||
        after.size !== item.initial.size ||
        after.mtimeMs !== item.initial.mtimeMs ||
        after.ctimeMs !== item.initial.ctimeMs
      )
        throw Error('publication_temporary_changed');
      fs.unlinkSync(item.file);
      const directory = privateDirectory(root, device);
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    }
  } finally {
    for (const item of held) {
      item.bytes.fill(0);
      fs.closeSync(item.fd);
    }
    for (const template of templates) template.fill(0);
  }
}
/** Only originally declared files and their parent directories may be removed. Each
 * mutation rechecks held descriptors and live proof; saved metadata grants no authority. */
function retireSlot(
  root: string,
  metadata: Retirement,
  device: number,
  recovering: boolean,
  assertCurrent: () => void,
  erase: boolean,
): void {
  const location = path.join(root, metadata.receipt.kind === 'state' ? 'full' : metadata.receipt.operationId);
  if (!fs.lstatSync(location, { throwIfNoEntry: false })) {
    if (!recovering) throw Error('retirement_slot_missing');
    return;
  }
  const slotFd = privateDirectory(location, device),
    slot = pinned(slotFd);
  const link = (fd: number, file: string) => {
    const held = fs.fstatSync(fd),
      current = fs.lstatSync(file);
    if (held.dev !== current.dev || held.ino !== current.ino || held.uid !== current.uid || held.mode !== current.mode)
      throw Error('retirement_directory_changed');
  };
  try {
    const initial = fs.fstatSync(slotFd);
    if (initial.dev !== metadata.slot.device || initial.ino !== metadata.slot.inode)
      throw Error('retirement_slot_changed');
    const receiptFile = path.join(slot, 'receipt.json');
    const checkSlot = () => {
      assertCurrent();
      link(slotFd, location);
      if (fs.readdirSync(slot).some((name) => !['data', 'receipt.json'].includes(name)))
        throw Error('retirement_extra_slot_file');
      if (fs.lstatSync(receiptFile, { throwIfNoEntry: false })) {
        if (digest(privateJson(receiptFile, device)) !== digest(metadata.receipt))
          throw Error('retirement_receipt_changed');
      } else if (!recovering || fs.lstatSync(path.join(slot, 'data'), { throwIfNoEntry: false }))
        throw Error('retirement_receipt_missing');
    };
    checkSlot();
    const expected = new Map(metadata.receipt.files.map((file) => [file.name, file]));
    const prefixes = new Set(
      metadata.receipt.files.flatMap((file) =>
        file.name
          .split('/')
          .slice(0, -1)
          .map((_, index) =>
            file.name
              .split('/')
              .slice(0, index + 1)
              .join('/'),
          ),
      ),
    );
    const found = new Set<string>();
    let visited = 0;
    const walk = (file: string, prefix = '') => {
      const fd = privateDirectory(file, device);
      try {
        for (const name of fs.readdirSync(pinned(fd)).sort()) {
          if (++visited > 16384) throw Error('retirement_tree_bounds');
          const relative = prefix ? prefix + '/' + name : name,
            child = path.join(pinned(fd), name),
            stat = fs.lstatSync(child);
          if (!validName(relative) || stat.dev !== device || stat.uid !== process.getuid?.() || stat.isSymbolicLink())
            throw Error('retirement_unsafe_file');
          if (stat.isDirectory()) {
            if (!prefixes.has(relative)) throw Error('retirement_extra_directory');
            walk(child, relative);
          } else {
            const original = expected.get(relative);
            if (!original) throw Error('retirement_extra_file');
            checksum(child, original, device);
            found.add(relative);
            if (erase) {
              checkSlot();
              link(fd, file);
              checksum(child, original, device);
              fs.unlinkSync(child);
              fs.fsyncSync(fd);
            }
          }
        }
        if (erase) {
          checkSlot();
          link(fd, file);
          fs.rmdirSync(file);
        }
      } finally {
        fs.closeSync(fd);
      }
    };
    const data = path.join(slot, 'data');
    if (fs.lstatSync(data, { throwIfNoEntry: false })) walk(data);
    else if (!recovering) throw Error('retirement_data_missing');
    if (!recovering && found.size !== expected.size) throw Error('retirement_missing_file');
    if (erase) {
      checkSlot();
      if (fs.lstatSync(receiptFile, { throwIfNoEntry: false })) {
        fs.unlinkSync(receiptFile);
        fs.fsyncSync(slotFd);
      }
      assertCurrent();
      link(slotFd, location);
      if (fs.readdirSync(slot).length) throw Error('retirement_slot_not_empty');
      fs.rmdirSync(location);
    }
  } finally {
    fs.closeSync(slotFd);
  }
}
/** The injected accessor is for synthetic fixtures. Installed construction below always verifies and pins the vault. */
export class BackupQueue {
  constructor(
    private readonly ownerDigest: string,
    private readonly access: VaultQueueAccess,
  ) {
    if (!/^[a-f0-9]{64}$/.test(ownerDigest)) throw Error('backup_queue_unavailable');
  }
  private async area<T>(
    kind: BackupKind,
    create: boolean,
    locked: boolean,
    operation: (root: string, device: number, assertWriter: () => void) => Promise<T>,
    absent?: () => Promise<T>,
  ): Promise<T> {
    try {
      if (!['state', 'credentials'].includes(kind)) throw Error('unknown_kind');
      return await this.access(kind, async (area) => {
        const areaFd = privateDirectory(area),
          device = fs.fstatSync(areaFd).dev;
        let rootFd: number | undefined;
        try {
          const location = path.join(pinned(areaFd), 'backup-queue');
          if (!fs.lstatSync(location, { throwIfNoEntry: false })) {
            if (!create && absent) return await absent();
            if (!create) throw Error('queue_not_initialized');
            fs.mkdirSync(location, { mode: 0o700 });
            rootFd = privateDirectory(location, device);
            writeAtomic(pinned(rootFd), 'owner.json', {
              format: 'cos-backup-queue-owner/v1',
              ownerDigest: this.ownerDigest,
              kind,
            });
          } else rootFd = privateDirectory(location, device);
          const root = pinned(rootFd),
            owner = privateJson(path.join(root, 'owner.json'), device);
          if (digest(owner) !== digest({ format: 'cos-backup-queue-owner/v1', ownerDigest: this.ownerDigest, kind }))
            throw Error('queue_owner_conflict');
          const writerOwner = digest({ contract: 'cos-backup-queue-writer/v1', ownerDigest: this.ownerDigest, kind });
          if (
            fs.lstatSync(path.join(root, '.cos-writer.lock'), { throwIfNoEntry: false }) &&
            digest(privateJson(path.join(root, '.cos-writer.lock'), device)) !==
              digest({ contract: 'cos-backup-repository-writer/v1', ownerDigest: writerOwner })
          )
            throw Error('queue_writer_changed');
          if (fs.lstatSync(path.join(root, '.lock'), { throwIfNoEntry: false }))
            throw Error('legacy_queue_lock_requires_reconciliation');
          if (locked) {
            const writer = new BackupRepositoryWriter(
              writerOwner,
              async (callback) => callback(root),
              '.cos-writer.lock',
            );
            return await writer.exclusive(async (lease) => {
              lease.assertCurrent();
              const result = await operation(root, device, lease.assertCurrent);
              lease.assertCurrent();
              return result;
            });
          }
          return await operation(root, device, () => {});
        } finally {
          if (rootFd !== undefined) fs.closeSync(rootFd);
          fs.closeSync(areaFd);
        }
      });
    } catch {
      // eslint-disable-next-line preserve-caught-error -- Vault paths, captured secrets and filesystem diagnostics are private.
      throw Error('backup_queue_unavailable');
    }
  }
  private receipts(root: string, kind: BackupKind, device: number): BackupQueueReceipt[] {
    const capture = readCaptureJournal(root, this.ownerDigest, kind),
      captureNames = captureJournalNames(root, device);
    const intent = retirement(root, intentName, this.ownerDigest, kind, device);
    retirement(root, ackName, this.ownerDigest, kind, device);
    const temporary = new Set(publicationTemporaries(root, device));
    const journals =
      kind === 'credentials' ? credentialMetadata(root, device, this.ownerDigest) : { heads: [], names: [] };
    for (const head of journals.heads) validateReceipt(head.receipt, this.ownerDigest, 'credentials');
    const names = fs
      .readdirSync(root)
      .filter(
        (name) =>
          ![
            'owner.json',
            '.lock',
            '.cos-writer.lock',
            intentName,
            ackName,
            ...journals.names,
            ...captureNames,
          ].includes(name) && !temporary.has(name),
      );
    if (names.length > (kind === 'state' ? 1 : 1024)) throw Error('queue_bounds');
    const values = names.sort().map((name) => {
      if (kind === 'state' ? name !== 'full' : !uuid(name)) throw Error('queue_directory_conflict');
      if (intent && name === (kind === 'state' ? 'full' : intent.receipt.operationId)) {
        const current = fs.lstatSync(path.join(root, name));
        if (current.dev !== intent.slot.device || current.ino !== intent.slot.inode)
          throw Error('retirement_slot_changed');
        return { ...intent.receipt, state: 'failed' as const };
      }
      const fd = privateDirectory(path.join(root, name), device);
      let value: BackupQueueReceipt;
      try {
        const receiptPath = path.join(pinned(fd), 'receipt.json');
        if (
          !fs.lstatSync(receiptPath, { throwIfNoEntry: false }) &&
          capture &&
          capture.phase !== 'retired' &&
          fs.fstatSync(fd).dev === capture.directories[''].device &&
          fs.fstatSync(fd).ino === capture.directories[''].inode &&
          name === (kind === 'state' ? 'full' : capture.operationId)
        )
          value = {
            format: 'cos-backup-queue/v1',
            ownerDigest: this.ownerDigest,
            kind,
            operationId: capture.operationId,
            state: 'capturing',
            createdAt: capture.createdAt,
            maximumBytes: capture.maximumBytes,
            bytes: measure(pinned(fd), device),
            files: [],
          };
        else value = privateJson<BackupQueueReceipt>(receiptPath, device);
      } finally {
        fs.closeSync(fd);
      }
      validateReceipt(value, this.ownerDigest, kind, name);
      return value;
    });
    if (intent && !values.some((value) => value.operationId === intent.receipt.operationId))
      values.push({ ...intent.receipt, state: 'failed' });
    return values;
  }
  async capture(
    kind: BackupKind,
    operationId: string,
    produce: (sink: BackupSnapshotSink) => Promise<void>,
    maximumBytes = kind === 'state' ? BACKUP_LIMITS.staging : BACKUP_LIMITS.credentials,
  ) {
    return this.area(kind, true, true, async (root, device) =>
      this.captureLocked(root, device, kind, operationId, produce, maximumBytes),
    );
  }
  private async captureLocked(
    root: string,
    device: number,
    kind: BackupKind,
    operationId: string,
    produce: (sink: BackupSnapshotSink) => Promise<void>,
    maximumBytes: number,
  ) {
    const limit = kind === 'state' ? BACKUP_LIMITS.staging : BACKUP_LIMITS.credentials;
    if (!uuid(operationId) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 16384 || maximumBytes > limit)
      throw Error('capture_bounds');
    const previous = this.receipts(root, kind, device);
    if (retirement(root, ackName, this.ownerDigest, kind, device)?.receipt.operationId === operationId)
      throw Error('capture_already_retired');
    if (kind === 'state' && previous.length)
      return { status: 'skipped_pending' as const, kind, operationId: previous[0].operationId };
    const same = previous.find((receipt) => receipt.operationId === operationId);
    if (same) {
      if (same.state !== 'pending') throw Error('capture_interrupted');
      return { status: 'queued' as const, kind, operationId };
    }
    const used = measure(root, device),
      budget = Math.min(maximumBytes, limit - used - 2 * 1024 ** 2 - 8192);
    if (budget < 16384) throw Error('capture_capacity');
    const location = path.join(root, kind === 'state' ? 'full' : operationId);
    assertCaptureAvailable(root, this.ownerDigest, kind);
    fs.mkdirSync(location, { mode: 0o700 });
    const slotFd = privateDirectory(location, device),
      slot = pinned(slotFd);
    const reserve = Math.max(4096, Math.min(1024 ** 2, Math.floor(budget / 8 / 4096) * 4096));
    const receipt: BackupQueueReceipt = {
      format: 'cos-backup-queue/v1',
      ownerDigest: this.ownerDigest,
      kind,
      operationId,
      state: 'capturing',
      createdAt: new Date().toISOString(),
      maximumBytes: budget,
      bytes: 0,
      files: [],
    };
    const files = new Map<string, { fd: number; bytes: number; hash: ReturnType<typeof createHash> }>(),
      directories = new Map<string, number>();
    let active = true;
    let journal: ReturnType<typeof createCaptureJournal> | undefined;
    try {
      fs.mkdirSync(path.join(slot, 'data'), { mode: 0o700 });
      const dataFd = privateDirectory(path.join(slot, 'data'), device),
        data = pinned(dataFd);
      directories.set('', dataFd);
      journal = createCaptureJournal(root, receipt, slotFd, dataFd);
      journal.receipt(receipt);
      await produce({
        write: (name, bytes) => {
          if (!active || !validName(name) || !Buffer.isBuffer(bytes)) throw Error('invalid_capture_write');
          const prospective = files.get(name),
            nextBytes = (prospective?.bytes ?? 0) + bytes.length;
          const prefixes = name
            .split('/')
            .slice(0, -1)
            .map((_, index) =>
              name
                .split('/')
                .slice(0, index + 1)
                .join('/'),
            );
          const additionalDirectories = prefixes.filter((prefix) => !directories.has(prefix)).length;
          const preflight =
            [...files.values()].reduce(
              (sum, item) =>
                sum + (item === prospective ? Math.ceil(nextBytes / 4096) * 4096 : allocated(fs.fstatSync(item.fd))),
              0,
            ) +
            (prospective ? 0 : Math.ceil(nextBytes / 4096) * 4096) +
            additionalDirectories * 4096 +
            [...directories.values()].reduce((sum, fd) => sum + allocated(fs.fstatSync(fd)), 0) +
            allocated(fs.fstatSync(slotFd)) +
            2 * reserve;
          const availability = fs.statfsSync(data, { bigint: true });
          if (preflight > budget || availability.ffree < BigInt(additionalDirectories + (prospective ? 0 : 1) + 4096))
            throw Error('capture_capacity');
          const parts = name.split('/'),
            basename = parts.pop()!;
          let parent = dataFd,
            prefix = '';
          for (const part of parts) {
            prefix = prefix ? prefix + '/' + part : part;
            if (!directories.has(prefix)) {
              fs.mkdirSync(path.join(pinned(parent), part), { mode: 0o700 });
              directories.set(prefix, privateDirectory(path.join(pinned(parent), part), device));
              journal!.directory(prefix, directories.get(prefix)!);
            }
            parent = directories.get(prefix)!;
          }
          let file = files.get(name);
          if (!file) {
            if (files.size >= 4096) throw Error('capture_file_bounds');
            file = {
              fd: fs.openSync(
                path.join(pinned(parent), basename),
                fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
                0o600,
              ),
              bytes: 0,
              hash: createHash('sha256'),
            };
            files.set(name, file);
            journal!.file(name, file.fd, 0, createHash('sha256').digest('hex'));
          }
          const nextSize = file.bytes + bytes.length;
          const charge =
            [...files.values()].reduce(
              (sum, item) =>
                sum + (item === file ? Math.ceil(nextSize / 4096) * 4096 : allocated(fs.fstatSync(item.fd))),
              0,
            ) +
            [...directories.values()].reduce((sum, fd) => sum + allocated(fs.fstatSync(fd)), 0) +
            allocated(fs.fstatSync(slotFd)) +
            2 * reserve;
          const statfs = fs.statfsSync(data, { bigint: true }),
            free = statfs.bavail * statfs.bsize;
          if (charge > budget || free < BigInt(bytes.length + BACKUP_LIMITS.vaultReserve))
            throw Error('capture_capacity');
          for (let offset = 0; offset < bytes.length; ) {
            const count = fs.writeSync(file.fd, bytes, offset, bytes.length - offset);
            if (count < 1) throw Error('short_capture_write');
            offset += count;
          }
          file.hash.update(bytes);
          file.bytes = nextSize;
          fs.fsyncSync(file.fd);
          journal!.file(name, file.fd, file.bytes, file.hash.copy().digest('hex'));
        },
      });
      active = false;
      for (const [name, file] of files) {
        fs.fsyncSync(file.fd);
        receipt.files.push({ name, bytes: file.bytes, sha256: file.hash.digest('hex') });
      }
      if (!receipt.files.length) throw Error('empty_capture');
      receipt.files.sort((a, b) => a.name.localeCompare(b.name));
      if (Buffer.byteLength(JSON.stringify(receipt)) + 1 > reserve) throw Error('capture_manifest_bounds');
      for (const fd of directories.values()) fs.fsyncSync(fd);
      receipt.state = 'pending';
      receipt.bytes = measure(slot, device);
      journal.receipt(receipt);
      fs.fsyncSync(slotFd);
      if (measure(root, device) > limit || measure(slot, device) > budget) throw Error('capture_capacity');
      return { status: 'queued' as const, kind, operationId };
    } catch {
      active = false;
      receipt.state = 'failed';
      receipt.files = [];
      receipt.bytes = measure(slot, device);
      if (journal) journal.receipt(receipt);
      // eslint-disable-next-line preserve-caught-error -- A failed capture remains encrypted and occupies its owned slot.
      throw Error('capture_failed');
    } finally {
      active = false;
      for (const file of files.values()) fs.closeSync(file.fd);
      for (const fd of directories.values()) fs.closeSync(fd);
      fs.closeSync(slotFd);
    }
  }
  private async pendingCredentialHead(operationId: string): Promise<CredentialHead | undefined> {
    return this.withPending('credentials', operationId, async (directory, receipt) => {
      if (!receipt.files.some((file) => file.name === credentialEventName)) return undefined;
      const event = readCredentialMetadata<CredentialHead['event']>(
        path.join(directory, credentialEventName),
        fs.statSync(directory).dev,
      );
      return credentialHead(event, receipt);
    });
  }
  private async rememberCredential(
    root: string,
    device: number,
    proposed: CredentialHead,
    assertCurrent: () => void,
  ): Promise<void> {
    const metadata = credentialMetadata(root, device, this.ownerDigest);
    for (const head of metadata.heads) validateReceipt(head.receipt, this.ownerDigest, 'credentials');
    if (metadata.temporaries.length) {
      const candidates = [...metadata.heads, proposed];
      for (const receipt of this.receipts(root, 'credentials', device)) {
        if (receipt.state === 'pending' && receipt.files.some((file) => file.name === credentialEventName)) {
          const head = await this.pendingCredentialHead(receipt.operationId);
          if (head) candidates.push(head);
        }
      }
      assertCurrent();
      recoverCredentialTemporaries(root, device, metadata.temporaries, candidates, assertCurrent);
    }
    const old = metadata.heads.find((head) => credentialSource(head.event) === credentialSource(proposed.event));
    const synchronize = () => {
      const directory = privateDirectory(root, device);
      try {
        assertCurrent();
        fs.fsyncSync(directory);
        assertCurrent();
      } finally {
        fs.closeSync(directory);
      }
    };
    if (old && credentialOrder(old.event) > credentialOrder(proposed.event)) {
      synchronize();
      return;
    }
    if (old && credentialOrder(old.event) === credentialOrder(proposed.event)) {
      if (digest(old) !== digest(proposed)) throw Error('credential_head_conflict');
      // A previous rename may have succeeded while its directory sync failed or
      // its process was killed. Complete durability before acknowledging replay.
      synchronize();
      return;
    }
    const charge = Math.ceil((Buffer.byteLength(JSON.stringify(proposed)) + 1) / 4096) * 4096,
      availability = fs.statfsSync(root, { bigint: true });
    if (
      (metadata.heads.length >= 1024 && !old) ||
      measure(root, device) + charge + 8192 > BACKUP_LIMITS.credentials ||
      availability.bavail * availability.bsize < BigInt(charge + BACKUP_LIMITS.vaultReserve)
    )
      throw Error('credential_head_capacity');
    assertCurrent();
    publishCredentialHead(root, proposed, assertCurrent);
  }
  /** No network work occurs here. The primary credential owner supplies fresh guards and
   * awaits completion before acknowledging its durable write. Stored heads are deduplication
   * evidence only; they cannot restore credentials or authorize payload retirement. */
  async recordCredential(change: CredentialChange, guard: () => void) {
    const held: Buffer[] = [];
    try {
      if (typeof guard !== 'function') throw Error('credential_guard_required');
      const captured = {
        ...change,
        files: change.files.map((file) => {
          const bytes = Buffer.from(file.bytes);
          held.push(bytes);
          return { name: file.name, bytes };
        }),
      };
      const event = makeCredentialEvent(captured, this.ownerDigest),
        bytes = Buffer.from(JSON.stringify(event) + '\n');
      held.push(bytes);
      return await this.area('credentials', true, true, async (root, device, writer) => {
        const assertCurrent = () => {
          writer();
          guard();
        };
        assertCurrent();
        const metadata = credentialMetadata(root, device, this.ownerDigest),
          old = metadata.heads.find((head) => credentialSource(head.event) === credentialSource(event));
        const receipts = this.receipts(root, 'credentials', device),
          same = receipts.find((receipt) => receipt.operationId === event.operationId);
        if (old && credentialOrder(old.event) >= credentialOrder(event)) {
          if (digest(old.event) !== digest(event)) throw Error('credential_generation_conflict');
          if (same?.state === 'pending') {
            const pending = await this.pendingCredentialHead(event.operationId);
            if (digest(pending) !== digest(old)) throw Error('credential_pending_changed');
          } else if (same) {
            const intent = retirement(root, intentName, this.ownerDigest, 'credentials', device);
            if (!intent || digest(intent.receipt) !== digest(old.receipt))
              throw Error('credential_pending_interrupted');
          }
          await this.rememberCredential(root, device, old, assertCurrent);
          assertCurrent();
          return { status: 'recorded' as const, operationId: event.operationId };
        }
        if (!same) {
          const budget = Math.max(
              65536,
              captured.files.reduce((sum, file) => sum + Math.ceil(file.bytes.length / 4096) * 4096, 0) + 65536,
            ),
            availability = fs.statfsSync(root, { bigint: true });
          if (
            (metadata.heads.length >= 1024 && !old) ||
            receipts.length >= 1024 ||
            measure(root, device) + budget + 32768 > BACKUP_LIMITS.credentials ||
            availability.bavail * availability.bsize < BigInt(budget + BACKUP_LIMITS.vaultReserve)
          )
            throw Error('credential_capture_capacity');
          await this.captureLocked(
            root,
            device,
            'credentials',
            event.operationId,
            async (sink) => {
              assertCurrent();
              for (const file of captured.files) sink.write(file.name, file.bytes);
              sink.write(credentialEventName, bytes);
              assertCurrent();
            },
            budget,
          );
        }
        const proposed = await this.pendingCredentialHead(event.operationId);
        if (!proposed || digest(proposed.event) !== digest(event)) throw Error('credential_pending_conflict');
        assertCurrent();
        await this.rememberCredential(root, device, proposed, assertCurrent);
        assertCurrent();
        return { status: 'recorded' as const, operationId: event.operationId };
      });
    } catch {
      // eslint-disable-next-line preserve-caught-error -- Credential contents and filesystem paths never enter diagnostics.
      throw Error('backup_queue_unavailable');
    } finally {
      for (const bytes of held) bytes.fill(0);
    }
  }
  async pending(kind: BackupKind): Promise<BackupQueueReceipt[]> {
    return this.area(kind, false, false, async (root, device) => this.receipts(root, kind, device));
  }
  /** Trusted recovery only. Fresh caller permission and the actual queue writer
   * lease are rechecked throughout; saved claims cannot authorize removal. */
  async reconcileCapture(kind: BackupKind, operationId: string, guard: () => void) {
    if (!uuid(operationId) || typeof guard !== 'function') throw Error('backup_queue_unavailable');
    return this.area(kind, false, true, async (root, _device, writer) =>
      reconcileOwnedCapture(root, this.ownerDigest, kind, operationId, () => {
        writer();
        guard();
      }),
    );
  }
  /** A trusted uploader supplies fresh evidence for both the archive and its original
   * receipt under live descriptor scopes; the stored intent alone is never authority. */
  async retirePending(
    kind: BackupKind,
    operationId: string,
    prove: (request: BackupRetirementRequest) => Promise<BackupRetirementProof>,
  ): Promise<RemoteCheckpoint> {
    return this.area(kind, false, false, async (root, device) => {
      const rootIdentity = fs.statSync(root);
      if (!uuid(operationId) || typeof prove !== 'function') throw Error('invalid_retirement_operation');
      const intent = retirement(root, intentName, this.ownerDigest, kind, device);
      const ack = retirement(root, ackName, this.ownerDigest, kind, device);
      if (intent && intent.receipt.operationId !== operationId) throw Error('retirement_in_progress');
      let metadata = intent ?? (ack?.receipt.operationId === operationId ? ack : undefined);
      const initialMetadata = metadata && digest(metadata);
      let supplied: BackupRetirementProof;
      if (metadata) {
        supplied = await prove(
          structuredClone({
            receipt: metadata.receipt,
            archive: { bytes: metadata.remote.archiveBytes, sha256: metadata.remote.archiveSha256 },
            previous: metadata.remote,
          }),
        );
      } else {
        const receipt = this.receipts(root, kind, device).find((value) => value.operationId === operationId);
        if (!receipt || receipt.state !== 'pending') throw Error('pending_checkpoint_required');
        const slotFd = privateDirectory(path.join(root, kind === 'state' ? 'full' : operationId), device);
        let slot: Retirement['slot'];
        try {
          const stat = fs.fstatSync(slotFd);
          slot = { device: stat.dev, inode: stat.ino };
        } finally {
          fs.closeSync(slotFd);
        }
        supplied = await this.withPending(kind, operationId, async (data, current) => {
          if (digest(current) !== digest(receipt)) throw Error('retirement_receipt_changed');
          const archive = await streamBackupArchive(data, current, async () => {});
          const result = await prove(structuredClone({ receipt: current, archive }));
          validateRemote(result.checkpoint, current, archive);
          return result;
        });
        metadata = {
          contract: 'cos-backup-queue-retirement/v2',
          receipt: structuredClone(receipt),
          remote: remoteIdentity(supplied.checkpoint),
          slot,
          retired: false,
        };
      }
      const remote = structuredClone(supplied.checkpoint);
      validateRemote(remote, metadata.receipt, {
        bytes: metadata.remote.archiveBytes,
        sha256: metadata.remote.archiveSha256,
      });
      if (
        initialMetadata &&
        (remote.repositoryId !== metadata.remote.repositoryId ||
          remote.ownerDigest !== metadata.remote.ownerDigest ||
          remote.snapshotId !== metadata.remote.snapshotId ||
          remote.snapshotAt !== metadata.remote.snapshotAt)
      )
        throw Error('remote_retirement_changed');
      // Capture the live method separately: the serializable record never carries it.
      const assertCurrent = supplied.assertCurrent.bind(supplied);
      assertCurrent();
      const selected = metadata;
      return this.area(kind, false, true, async (lockedRoot, lockedDevice, currentWriter) => {
        const assertAuthority = () => {
          assertCurrent();
          currentWriter();
        };
        const currentRoot = fs.statSync(lockedRoot);
        if (lockedDevice !== device || currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino)
          throw Error('queue_device_changed');
        const currentIntent = retirement(lockedRoot, intentName, this.ownerDigest, kind, device);
        const currentAck = retirement(lockedRoot, ackName, this.ownerDigest, kind, device);
        assertAuthority();
        if (selected.retired) {
          if (currentIntent || !currentAck || digest(currentAck) !== initialMetadata) throw Error('retirement_changed');
          recoverPublicationTemporaries(lockedRoot, selected, device, this.ownerDigest, assertAuthority);
          return remote;
        }
        if (intent ? !currentIntent || digest(currentIntent) !== initialMetadata : !!currentIntent)
          throw Error('retirement_changed');
        if (kind === 'credentials' && !intent) {
          const head = await this.pendingCredentialHead(operationId);
          if (head) await this.rememberCredential(lockedRoot, device, head, assertAuthority);
          assertAuthority();
        }
        retireSlot(lockedRoot, selected, device, !!intent, assertAuthority, false);
        recoverPublicationTemporaries(lockedRoot, selected, device, this.ownerDigest, assertAuthority);
        if (!intent) {
          const charge = Math.ceil((Buffer.byteLength(JSON.stringify(selected)) + 1) / 4096) * 4096;
          const limit = kind === 'state' ? BACKUP_LIMITS.staging : BACKUP_LIMITS.credentials;
          const availability = fs.statfsSync(lockedRoot, { bigint: true });
          if (
            charge > 1024 ** 2 ||
            measure(lockedRoot, device) + charge + 8192 > limit ||
            availability.bavail * availability.bsize < BigInt(charge + BACKUP_LIMITS.vaultReserve)
          )
            throw Error('retirement_capacity');
          assertAuthority();
          publishRetirement(lockedRoot, intentName, selected);
        }
        const durable = retirement(lockedRoot, intentName, this.ownerDigest, kind, device);
        if (!durable || digest(durable) !== digest(selected)) throw Error('retirement_intent_changed');
        retireSlot(
          lockedRoot,
          selected,
          device,
          !!intent,
          () => {
            assertAuthority();
            if (digest(retirement(lockedRoot, intentName, this.ownerDigest, kind, device)) !== digest(selected))
              throw Error('retirement_intent_changed');
          },
          true,
        );
        const rootFd = privateDirectory(lockedRoot, device);
        try {
          fs.fsyncSync(rootFd);
          assertAuthority();
          publishRetirement(lockedRoot, ackName, { ...selected, retired: true });
          assertAuthority();
          if (digest(retirement(lockedRoot, intentName, this.ownerDigest, kind, device)) !== digest(selected))
            throw Error('retirement_intent_changed');
          fs.unlinkSync(path.join(lockedRoot, intentName));
          fs.fsyncSync(rootFd);
        } finally {
          fs.closeSync(rootFd);
        }
        return remote;
      });
    });
  }

  /** Preflight preserves an uninitialized queue and refuses unsafe or unavailable storage. */
  async inspect(kind: BackupKind): Promise<BackupQueueReceipt[]> {
    return this.area(
      kind,
      false,
      false,
      async (root, device) => this.receipts(root, kind, device),
      async () => [],
    );
  }
  /** A durable retirement intent selects its original ID for fresh remote
   * readback. Other incomplete captures remain held. No payload is read or
   * removed, and an absent queue is not initialized by background observation. */
  async inspectDelivery(kind: BackupKind): Promise<BackupDeliveryObservation> {
    return this.area(
      kind,
      false,
      false,
      async (root, device) => {
        const receipts = this.receipts(root, kind, device),
          intent = retirement(root, intentName, this.ownerDigest, kind, device),
          ack = retirement(root, ackName, this.ownerDigest, kind, device);
        return {
          items: receipts.map((receipt) => ({
            kind,
            operationId: receipt.operationId,
            disposition:
              intent?.receipt.operationId === receipt.operationId
                ? 'reconcile'
                : receipt.state === 'pending'
                  ? 'upload'
                  : 'held',
            createdAt: receipt.createdAt,
            bytes: receipt.bytes,
          })),
          lastRemoteCheckpointAt: ack?.retired === true ? ack.remote.snapshotAt : null,
          lastAcknowledgedCaptureAt: ack?.retired === true ? ack.receipt.createdAt : null,
        };
      },
      async () => ({ items: [], lastRemoteCheckpointAt: null, lastAcknowledgedCaptureAt: null }),
    );
  }
  async withPending<T>(
    kind: BackupKind,
    operationId: string,
    operation: (directory: string, receipt: BackupQueueReceipt) => Promise<T>,
  ): Promise<T> {
    // The repository uploader owns its separate lease. Published slots are immutable;
    // a slow reader must not block new credential captures behind the writer lease.
    return this.area(kind, false, false, async (root, device) => {
      const receipt = this.receipts(root, kind, device).find((value) => value.operationId === operationId);
      if (!receipt || receipt.state !== 'pending') throw Error('pending_checkpoint_required');
      const dataFd = privateDirectory(path.join(root, kind === 'state' ? 'full' : operationId, 'data'), device);
      try {
        const directory = pinned(dataFd);
        const verify = () => {
          const names: string[] = [];
          let visited = 0;
          const visit = (root: string, prefix = '') => {
            const fd = privateDirectory(root, device);
            try {
              for (const name of fs.readdirSync(pinned(fd))) {
                if (++visited > 16384) throw Error('pending_tree_bounds');
                const relative = prefix ? prefix + '/' + name : name,
                  file = path.join(pinned(fd), name),
                  stat = fs.lstatSync(file);
                if (!validName(relative) || stat.isSymbolicLink()) throw Error('pending_file_name');
                if (stat.isDirectory()) visit(file, relative);
                else names.push(relative);
              }
            } finally {
              fs.closeSync(fd);
            }
          };
          visit(directory);
          if (
            names.sort().join('\0') !==
            receipt.files
              .map((file) => file.name)
              .sort()
              .join('\0')
          )
            throw Error('pending_files_changed');
          for (const file of receipt.files) {
            const parts = file.name.split('/'),
              name = parts.pop()!,
              held: number[] = [];
            let parent = dataFd;
            try {
              for (const part of parts) {
                parent = privateDirectory(path.join(pinned(parent), part), device);
                held.push(parent);
              }
              checksum(path.join(pinned(parent), name), file, device);
            } finally {
              for (const fd of held) fs.closeSync(fd);
            }
          }
        };
        verify();
        const result = await operation(directory, receipt);
        verify();
        return result;
      } finally {
        fs.closeSync(dataFd);
      }
    });
  }
}
export function createVaultBackupQueue(roots: CalendarStorageRoots): BackupQueue {
  const policy = verifyVaultStorage(roots);
  return new BackupQueue(
    digest({ targetDigest: policy.targetDigest, filesystemUuid: policy.volume.filesystemUuid }),
    (kind, operation) => withVaultDirectory(roots, kind === 'state' ? 'staging' : 'journals', operation),
  );
}
