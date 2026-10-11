import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { VerifiedResticBinary } from './restic-artifact.js';
import { verifyResticRepositoryIdentity } from './restic-artifact.js';
import type { BackupPassword } from './backup-password.js';
import type { SignedBackupRepository } from './backup-nas-access.js';
import type { BackupRepositoryLease } from './backup-repository-lease.js';
import { BACKUP_LIMITS, type BackupKind } from './backup-policy.js';
import {
  backupRepositoryHost,
  backupSnapshotTags,
  backupRetentionArguments,
  backupSnapshotInventory,
  parseBackupRetentionPreview,
} from './backup-retention.js';
import type { BackupQueueReceipt } from './backup-queue.js';
import { backupArchiveReceiptPrefix } from './backup-archive.js';
type Descriptor = Readonly<{ fd: number; assertCurrent(): void }>;
type Dependencies = {
  binary: VerifiedResticBinary;
  password: BackupPassword;
  repository: SignedBackupRepository;
  cache: Descriptor;
  writer: BackupRepositoryLease;
  repositoryId: string;
  ownerDigest: string;
  producer(kind: BackupKind, operationId: string): string[];
  admitUpload(kind: BackupKind, bytes: number): Promise<void>;
  timeoutMs?: number;
};
type Archive = { bytes: number; sha256: string };
type Snapshot = { id: string; time: string };
export type RemoteCheckpoint = {
  contract: 'cos-backup-remote-checkpoint/v1';
  repositoryId: string;
  ownerDigest: string;
  kind: BackupKind;
  operationId: string;
  snapshotId: string;
  snapshotAt: string;
  archiveBytes: number;
  archiveSha256: string;
  reconciled: boolean;
  verifiedAt: string;
};
export type BackupMaintenanceResult = {
  contract: 'cos-backup-repository-maintenance/v1';
  status: 'backup_repository_maintained';
  repositoryId: string;
  ownerDigest: string;
  state: { retained: number; removed: number };
  credentials: { retained: number; removed: number };
  integrity: 'verified';
};
const hex = /^[a-f0-9]{64}$/,
  uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function verifiedInput(kind: BackupKind, operationId: string, input: Archive): Archive {
  const archive = { ...input };
  if (
    !['state', 'credentials'].includes(kind) ||
    typeof operationId !== 'string' ||
    !uuid.test(operationId) ||
    typeof archive.sha256 !== 'string' ||
    !hex.test(archive.sha256) ||
    !Number.isSafeInteger(archive.bytes) ||
    archive.bytes < 2048 ||
    archive.bytes > (kind === 'state' ? BACKUP_LIMITS.staging : BACKUP_LIMITS.credentials) + 2 * 1024 ** 2
  )
    throw Error('invalid_transfer_archive');
  return archive;
}
/** Trusted transport with admitted descriptor scopes and mandatory growth admission.
 * Synthetic fixtures inject those scopes. Installed construction must use the vault,
 * signed NAS access, verified artifact and kernel writer factories; this is not an agent tool. */
export class BackupResticTransfer {
  private readonly options: Readonly<Dependencies>;
  constructor(options: Dependencies) {
    if (
      typeof options.repositoryId !== 'string' ||
      !hex.test(options.repositoryId) ||
      typeof options.ownerDigest !== 'string' ||
      !hex.test(options.ownerDigest) ||
      typeof options.producer !== 'function' ||
      typeof options.admitUpload !== 'function' ||
      (options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 900000))
    )
      throw Error('backup_transfer_unavailable');
    this.options = Object.freeze({ ...options });
  }
  private current(): void {
    const o = this.options;
    o.writer.assertCurrent();
    o.binary.assertCurrent();
    o.repository.assertCurrent();
    o.password.assertCurrent();
    o.cache.assertCurrent();
    for (const scope of [o.binary, o.repository, o.password, o.cache])
      if (!Number.isSafeInteger(scope.fd) || scope.fd < 3) throw Error('invalid_transfer_descriptor');
  }
  private async run(args: string[], maximum: number, consume?: (bytes: Buffer) => void): Promise<Buffer> {
    const chunks: Buffer[] = [];
    try {
      this.current();
      const o = this.options;
      const child = spawn(
        '/proc/self/fd/3',
        ['--repo', '/proc/self/fd/5', '--password-file', '/proc/self/fd/4', '--no-cache', '--json', '--quiet', ...args],
        {
          cwd: '/',
          detached: true,
          env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'Australia/Sydney', TMPDIR: '/proc/self/fd/6' },
          stdio: ['ignore', 'pipe', 'pipe', o.binary.fd, o.password.fd, o.repository.fd, o.cache.fd],
        },
      );
      const closed = new Promise<boolean>((resolve) => {
        child.once('error', () => resolve(false));
        child.once('close', (code, signal) => resolve(code === 0 && signal === null));
      });
      const terminate = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      };
      let expired = false,
        withdrawn = false,
        killTimer: NodeJS.Timeout | undefined;
      const stop = () => {
        terminate('SIGTERM');
        killTimer ??= setTimeout(() => terminate('SIGKILL'), 5000);
        killTimer.unref();
      };
      const timer = setTimeout(() => {
        expired = true;
        stop();
      }, o.timeoutMs ?? 900000);
      timer.unref();
      const permissionTimer = setInterval(() => {
        try {
          this.current();
          // eslint-disable-next-line no-catch-all/no-catch-all -- Any withdrawn descriptor or target proof terminates the private subprocess; the awaited command reports the fixed error.
        } catch {
          withdrawn = true;
          stop();
        }
      }, 1000);
      permissionTimer.unref();
      try {
        if (!child.stdout || !child.stderr) throw Error('transfer_pipe_required');
        child.stderr.on('data', (bytes: Buffer) => bytes.fill(0));
        let bytes = 0;
        for await (const chunk of child.stdout) {
          const data = chunk as Buffer;
          try {
            bytes += data.length;
            if (expired || withdrawn || bytes > maximum) throw Error('transfer_output_bounds');
            if (consume) consume(data);
            else chunks.push(Buffer.from(data));
          } finally {
            data.fill(0);
          }
        }
        if (!(await closed) || expired || withdrawn) throw Error('transfer_command_failed');
        this.current();
        return Buffer.concat(chunks);
      } catch {
        stop();
        await closed;
        // eslint-disable-next-line preserve-caught-error -- Stderr, paths, producer failures and command details remain private.
        throw Error('backup_transfer_unavailable');
      } finally {
        clearTimeout(timer);
        clearInterval(permissionTimer);
        if (killTimer) clearTimeout(killTimer);
      }
    } catch {
      // eslint-disable-next-line preserve-caught-error -- Descriptor proof errors must not leak private host state.
      throw Error('backup_transfer_unavailable');
    } finally {
      for (const chunk of chunks) chunk.fill(0);
    }
  }
  /** Installed maintenance shares the live repository writer and admitted
   * descriptor scopes. Policy previews select exact IDs; unrelated snapshot
   * identities must survive every deletion and prune. No unlock or repair. */
  async maintain(admit: () => Promise<void>): Promise<BackupMaintenanceResult> {
    try {
      if (typeof admit !== 'function') throw Error('maintenance_guard_required');
      const execute = async (args: string[], maximum = 8 * 1024 ** 2) => {
        this.current();
        await admit();
        this.current();
        const bytes = await this.command(args, maximum, undefined, admit);
        try {
          await admit();
          this.current();
          return bytes;
        } catch (error) {
          bytes.fill(0);
          throw error;
        }
      };
      const discard = async (args: string[]) => {
        const bytes = await execute(args);
        bytes.fill(0);
      };
      const list = async () => {
        const bytes = await execute(['snapshots']);
        try {
          return backupSnapshotInventory(bytes);
        } finally {
          bytes.fill(0);
        }
      };
      await discard(['check', '--read-data', '--with-cache']);
      const snapshots = await list(),
        expected = new Set(snapshots.map((snapshot) => snapshot.id)),
        plans = {} as Record<BackupKind, { keep: string[]; remove: string[] }>;
      for (const kind of ['state', 'credentials'] as const) {
        const bytes = await execute(backupRetentionArguments(this.options.ownerDigest, kind, 'preview'));
        try {
          plans[kind] = parseBackupRetentionPreview(bytes, this.options.ownerDigest, kind, snapshots);
        } finally {
          bytes.fill(0);
        }
      }
      const unchanged = async () => {
        const fresh = (await list()).map((snapshot) => snapshot.id).sort();
        if (fresh.join(',') !== [...expected].sort().join(',')) throw Error('maintenance_inventory_changed');
      };
      for (const kind of ['state', 'credentials'] as const) {
        const ids = plans[kind].remove;
        for (let start = 0; start < ids.length; start += 128) {
          await unchanged();
          const batch = ids.slice(start, start + 128);
          await discard(['forget', ...batch]);
          for (const id of batch) expected.delete(id);
          await unchanged();
        }
      }
      await unchanged();
      await discard(['prune', '--max-repack-size', '16M']);
      await unchanged();
      await discard(['check', '--read-data', '--with-cache']);
      await unchanged();
      return {
        contract: 'cos-backup-repository-maintenance/v1',
        status: 'backup_repository_maintained',
        repositoryId: this.options.repositoryId,
        ownerDigest: this.options.ownerDigest,
        state: { retained: plans.state.keep.length, removed: plans.state.remove.length },
        credentials: { retained: plans.credentials.keep.length, removed: plans.credentials.remove.length },
        integrity: 'verified',
      };
    } catch {
      // eslint-disable-next-line preserve-caught-error -- Repository data, IDs and command diagnostics remain private.
      throw Error('backup_maintenance_unavailable');
    }
  }
  private async command(
    args: string[],
    maximum: number,
    consume?: (bytes: Buffer) => void,
    admit?: () => Promise<void>,
  ): Promise<Buffer> {
    const config = await this.run(['cat', 'config'], 65536);
    try {
      verifyResticRepositoryIdentity(config.toString('utf8'), this.options.repositoryId);
    } finally {
      config.fill(0);
    }
    if (admit) {
      await admit();
      this.current();
    }
    return this.run(args, maximum, consume);
  }
  private async find(kind: BackupKind, operationId: string): Promise<Snapshot | undefined> {
    const tags = backupSnapshotTags(this.options.ownerDigest, kind, operationId),
      host = backupRepositoryHost(this.options.ownerDigest);
    const bytes = await this.command(['snapshots', '--host', host, '--tag', tags.join(',')], 1024 ** 2);
    try {
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (!Array.isArray(value) || value.length > 1) throw Error('ambiguous_remote_operation');
      if (!value.length) return undefined;
      const snapshot = value[0];
      if (
        !snapshot ||
        typeof snapshot !== 'object' ||
        typeof snapshot.id !== 'string' ||
        !hex.test(snapshot.id) ||
        typeof snapshot.time !== 'string' ||
        !Number.isFinite(Date.parse(snapshot.time)) ||
        snapshot.hostname !== host ||
        !Array.isArray(snapshot.paths) ||
        snapshot.paths.length !== 1 ||
        snapshot.paths[0] !== '/checkpoint.tar' ||
        !Array.isArray(snapshot.tags) ||
        snapshot.tags.length > 16 ||
        snapshot.tags.some((tag: unknown) => typeof tag !== 'string' || tag.length > 200) ||
        tags.some((tag) => !snapshot.tags.includes(tag))
      )
        throw Error('remote_operation_conflict');
      return { id: snapshot.id, time: snapshot.time };
    } finally {
      bytes.fill(0);
    }
  }
  /** Fresh readback only. Durable local metadata is never a repository lease. */
  async verify(
    kind: BackupKind,
    operationId: string,
    input: Archive,
    expectedReceipt?: BackupQueueReceipt,
  ): Promise<RemoteCheckpoint> {
    let prefix: Buffer | undefined;
    try {
      const archive = verifiedInput(kind, operationId, input);
      if (expectedReceipt) {
        if (expectedReceipt.kind !== kind || expectedReceipt.operationId !== operationId)
          throw Error('remote_receipt_conflict');
        prefix = backupArchiveReceiptPrefix(structuredClone(expectedReceipt));
      }
      const snapshot = await this.find(kind, operationId);
      if (!snapshot) throw Error('remote_checkpoint_missing');
      return await this.readSnapshot(kind, operationId, archive, snapshot, true, prefix);
    } catch {
      // eslint-disable-next-line preserve-caught-error -- Remote metadata and provider diagnostics remain private.
      throw Error('backup_transfer_unavailable');
    } finally {
      prefix?.fill(0);
    }
  }
  private async readSnapshot(
    kind: BackupKind,
    operationId: string,
    archive: Archive,
    snapshot: Snapshot,
    reconciled: boolean,
    expectedPrefix?: Buffer,
  ): Promise<RemoteCheckpoint> {
    const hash = createHash('sha256');
    let bytes = 0;
    const output = await this.command(['dump', snapshot.id, 'checkpoint.tar'], archive.bytes, (chunk) => {
      if (expectedPrefix && bytes < expectedPrefix.length) {
        const length = Math.min(chunk.length, expectedPrefix.length - bytes);
        if (!chunk.subarray(0, length).equals(expectedPrefix.subarray(bytes, bytes + length)))
          throw Error('remote_receipt_changed');
      }
      bytes += chunk.length;
      hash.update(chunk);
    });
    output.fill(0);
    if (
      bytes !== archive.bytes ||
      hash.digest('hex') !== archive.sha256 ||
      (expectedPrefix && bytes < expectedPrefix.length)
    )
      throw Error('remote_checkpoint_changed');
    this.current();
    return {
      contract: 'cos-backup-remote-checkpoint/v1',
      repositoryId: this.options.repositoryId,
      ownerDigest: this.options.ownerDigest,
      kind,
      operationId,
      snapshotId: snapshot.id,
      snapshotAt: snapshot.time,
      archiveBytes: bytes,
      archiveSha256: archive.sha256,
      reconciled,
      verifiedAt: new Date().toISOString(),
    };
  }
  async upload(kind: BackupKind, operationId: string, input: Archive): Promise<RemoteCheckpoint> {
    try {
      const archive = verifiedInput(kind, operationId, input);
      let snapshot = await this.find(kind, operationId);
      const reconciled = !!snapshot;
      if (!snapshot) {
        const producer = this.options.producer(kind, operationId);
        if (
          !Array.isArray(producer) ||
          !producer.length ||
          producer.length > 16 ||
          producer.some(
            (arg) => typeof arg !== 'string' || !arg.length || Buffer.byteLength(arg) > 8192 || /\0/.test(arg),
          )
        )
          throw Error('invalid_producer_command');
        await this.options.admitUpload(kind, archive.bytes);
        const output = await this.command(
          [
            'backup',
            '--stdin-from-command',
            '--stdin-filename',
            'checkpoint.tar',
            '--host',
            backupRepositoryHost(this.options.ownerDigest),
            ...backupSnapshotTags(this.options.ownerDigest, kind, operationId).flatMap((tag) => ['--tag', tag]),
            '--',
            ...producer,
          ],
          1024 ** 2,
        );
        output.fill(0);
        snapshot = await this.find(kind, operationId);
        if (!snapshot) throw Error('remote_checkpoint_missing');
      }
      return await this.readSnapshot(kind, operationId, archive, snapshot, reconciled);
    } catch {
      // eslint-disable-next-line preserve-caught-error -- Remote snapshot metadata, source paths and provider diagnostics are private.
      throw Error('backup_transfer_unavailable');
    }
  }
}
