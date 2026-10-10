import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import { digest } from '../domain/contracts.js';
import { writeAtomic } from './target-state.js';
import { BACKUP_LIMITS, type BackupKind } from './backup-policy.js';
import { verifyVaultStorage, withVaultDirectory } from './vault-storage.js';
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
function releaseQueueLock(rootFd: number, lockFd: number, nonce: string, device: number): void {
  const owner = privateJson<{ nonce: string }>(path.join(pinned(lockFd), 'owner.json'), device);
  const current = fs.lstatSync(path.join(pinned(rootFd), '.lock')),
    held = fs.fstatSync(lockFd);
  if (owner.nonce !== nonce || current.dev !== held.dev || current.ino !== held.ino)
    throw Error('queue_lock_owner_changed');
  fs.unlinkSync(path.join(pinned(lockFd), 'owner.json'));
  fs.rmdirSync(path.join(pinned(rootFd), '.lock'));
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
    operation: (root: string, device: number) => Promise<T>,
  ): Promise<T> {
    try {
      if (!['state', 'credentials'].includes(kind)) throw Error('unknown_kind');
      return await this.access(kind, async (area) => {
        const areaFd = privateDirectory(area),
          device = fs.fstatSync(areaFd).dev;
        let rootFd: number | undefined, lockFd: number | undefined, nonce: string | undefined;
        try {
          const location = path.join(pinned(areaFd), 'backup-queue');
          if (!fs.lstatSync(location, { throwIfNoEntry: false })) {
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
          if (locked) {
            fs.mkdirSync(path.join(root, '.lock'), { mode: 0o700 });
            lockFd = privateDirectory(path.join(root, '.lock'), device);
            nonce = randomUUID();
            writeAtomic(pinned(lockFd), 'owner.json', { nonce, pid: process.pid });
          }
          return await operation(root, device);
        } finally {
          try {
            if (lockFd !== undefined && rootFd !== undefined && nonce !== undefined) {
              releaseQueueLock(rootFd, lockFd, nonce, device);
            }
          } finally {
            if (lockFd !== undefined) fs.closeSync(lockFd);
            if (rootFd !== undefined) fs.closeSync(rootFd);
            fs.closeSync(areaFd);
          }
        }
      });
    } catch {
      // eslint-disable-next-line preserve-caught-error -- Vault paths, captured secrets and filesystem diagnostics are private.
      throw Error('backup_queue_unavailable');
    }
  }
  private receipts(root: string, kind: BackupKind, device: number): BackupQueueReceipt[] {
    const names = fs.readdirSync(root).filter((name) => !['owner.json', '.lock'].includes(name));
    if (names.length > (kind === 'state' ? 1 : 1024)) throw Error('queue_bounds');
    return names.sort().map((name) => {
      if (kind === 'state' ? name !== 'full' : !uuid(name)) throw Error('queue_directory_conflict');
      const fd = privateDirectory(path.join(root, name), device);
      let value: BackupQueueReceipt;
      try {
        value = privateJson<BackupQueueReceipt>(path.join(pinned(fd), 'receipt.json'), device);
      } finally {
        fs.closeSync(fd);
      }
      if (
        !value ||
        value.format !== 'cos-backup-queue/v1' ||
        value.ownerDigest !== this.ownerDigest ||
        value.kind !== kind ||
        !uuid(value.operationId) ||
        (kind === 'credentials' && value.operationId !== name) ||
        !['capturing', 'pending', 'failed'].includes(value.state) ||
        !Number.isSafeInteger(value.bytes) ||
        value.bytes < 0 ||
        !Number.isSafeInteger(value.maximumBytes) ||
        value.maximumBytes < 16384 ||
        value.maximumBytes > (kind === 'state' ? BACKUP_LIMITS.staging : BACKUP_LIMITS.credentials) ||
        !Array.isArray(value.files) ||
        value.files.length > 4096 ||
        new Set(value.files.map((file) => file.name)).size !== value.files.length ||
        value.files.some(
          (file) =>
            !validName(file.name) ||
            !Number.isSafeInteger(file.bytes) ||
            file.bytes < 0 ||
            !/^[a-f0-9]{64}$/.test(file.sha256),
        )
      )
        throw Error('invalid_queue_receipt');
      return value;
    });
  }
  async capture(
    kind: BackupKind,
    operationId: string,
    produce: (sink: BackupSnapshotSink) => Promise<void>,
    maximumBytes = kind === 'state' ? BACKUP_LIMITS.staging : BACKUP_LIMITS.credentials,
  ) {
    return this.area(kind, true, true, async (root, device) => {
      const limit = kind === 'state' ? BACKUP_LIMITS.staging : BACKUP_LIMITS.credentials;
      if (!uuid(operationId) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 16384 || maximumBytes > limit)
        throw Error('capture_bounds');
      const previous = this.receipts(root, kind, device);
      if (kind === 'state' && previous.length)
        return { status: 'skipped_pending' as const, kind, operationId: previous[0].operationId };
      const same = previous.find((receipt) => receipt.operationId === operationId);
      if (same) {
        if (same.state !== 'pending') throw Error('capture_interrupted');
        return { status: 'queued' as const, kind, operationId };
      }
      const used = measure(root, device),
        budget = Math.min(maximumBytes, limit - used - 8192);
      if (budget < 16384) throw Error('capture_capacity');
      const location = path.join(root, kind === 'state' ? 'full' : operationId);
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
      try {
        fs.mkdirSync(path.join(slot, 'data'), { mode: 0o700 });
        const dataFd = privateDirectory(path.join(slot, 'data'), device),
          data = pinned(dataFd);
        directories.set('', dataFd);
        writeAtomic(slot, 'receipt.json', receipt);
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
        writeAtomic(slot, 'receipt.json', receipt);
        fs.fsyncSync(slotFd);
        if (measure(root, device) > limit || measure(slot, device) > budget) throw Error('capture_capacity');
        return { status: 'queued' as const, kind, operationId };
      } catch {
        active = false;
        receipt.state = 'failed';
        receipt.files = [];
        receipt.bytes = measure(slot, device);
        writeAtomic(slot, 'receipt.json', receipt);
        // eslint-disable-next-line preserve-caught-error -- A failed capture remains encrypted and occupies its owned slot.
        throw Error('capture_failed');
      } finally {
        active = false;
        for (const file of files.values()) fs.closeSync(file.fd);
        for (const fd of directories.values()) fs.closeSync(fd);
        fs.closeSync(slotFd);
      }
    });
  }
  async pending(kind: BackupKind): Promise<BackupQueueReceipt[]> {
    return this.area(kind, false, false, async (root, device) => this.receipts(root, kind, device));
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
