import { assertBackupResticScopes, backupResticOutput } from './backup-restic-process.js';
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
import { readBackupArchive, type BackupArchiveRestoreSink } from './backup-archive-reader.js';
import { readCredentialRecoveryArchive, type CredentialRecoveryArchive } from './credential-recovery-archive.js';
import {
  makeRoutedCredentialRecoveryManifest,
  routedCredentialRecoveryCovers,
  type RoutedCredentialInventory,
  type RoutedCredentialRecoveryManifest,
} from './credential-recovery-routing.js';
import { credentialRecoveryCovers } from './credential-recovery-set.js';
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
  credentialInventory?(): Promise<{ ownerDigest: string; sources: RoutedCredentialInventory }>;
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
/** Readback evidence only. It does not restore live admission, credentials,
 * independent journals, model allowance or any runtime database rows. */
export type BackupRemoteRestore = Omit<RemoteCheckpoint, 'contract' | 'reconciled'> & {
  contract: 'cos-backup-remote-restore/v1';
  receipt: BackupQueueReceipt;
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
      (options.credentialInventory !== undefined && typeof options.credentialInventory !== 'function') ||
      (options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 900000))
    )
      throw Error('backup_transfer_unavailable');
    this.options = Object.freeze({ ...options });
  }
  private current(): void {
    assertBackupResticScopes(this.options);
  }
  private async *output(args: string[], maximum: number): AsyncGenerator<Buffer> {
    yield* backupResticOutput(this.options, args, maximum);
  }
  private async run(args: string[], maximum: number, consume?: (bytes: Buffer) => void): Promise<Buffer> {
    const chunks: Buffer[] = [];
    try {
      for await (const bytes of this.output(args, maximum)) {
        if (consume) consume(bytes);
        else chunks.push(Buffer.from(bytes));
      }
      return Buffer.concat(chunks);
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
      const keptCredentials: RoutedCredentialRecoveryManifest[] = [];
      let queueOwner: string | undefined;
      const credentialCoverage = async (removed?: CredentialRecoveryArchive) => {
        if (!this.options.credentialInventory) throw Error('credential_primary_inventory_required');
        this.current();
        await admit();
        this.current();
        const inventory = await this.options.credentialInventory();
        this.current();
        await admit();
        this.current();
        if (queueOwner !== undefined && inventory.ownerDigest !== queueOwner) throw Error('credential_owner_changed');
        const required = makeRoutedCredentialRecoveryManifest(inventory.ownerDigest, inventory.sources);
        queueOwner = inventory.ownerDigest;
        if (!keptCredentials.some((set) => routedCredentialRecoveryCovers(set, queueOwner!, required)))
          throw Error('retained_current_credentials_missing');
        if (removed) {
          const contents = removed.contents;
          const covered = keptCredentials.some((set) =>
            contents.kind === 'set-v2'
              ? routedCredentialRecoveryCovers(set, queueOwner!, contents.manifest)
              : credentialRecoveryCovers(
                  set.contents,
                  queueOwner!,
                  contents.kind === 'change' ? [contents.event] : contents.manifest.sources,
                ),
          );
          if (!covered) throw Error('removed_credentials_not_covered');
        }
      };
      if (plans.credentials.remove.length) {
        if (!this.options.credentialInventory) throw Error('credential_primary_inventory_required');
        this.current();
        await admit();
        this.current();
        const inventory = await this.options.credentialInventory();
        makeRoutedCredentialRecoveryManifest(inventory.ownerDigest, inventory.sources);
        queueOwner = inventory.ownerDigest;
        const read = async (id: string) => {
          const selected = snapshots.find((snapshot) => snapshot.id === id),
            tags = selected?.tags;
          const operation = Array.isArray(tags)
            ? tags.find((tag) => typeof tag === 'string' && tag.startsWith('cos-operation='))
            : undefined;
          if (typeof operation !== 'string') throw Error('credential_snapshot_identity_missing');
          this.current();
          await admit();
          this.current();
          const config = await this.run(['cat', 'config'], 65536);
          try {
            verifyResticRepositoryIdentity(config.toString('utf8'), this.options.repositoryId);
          } finally {
            config.fill(0);
          }
          await admit();
          this.current();
          const archive = await readCredentialRecoveryArchive(
            this.output(['dump', id, 'checkpoint.tar'], BACKUP_LIMITS.credentials + 2 * 1024 ** 2),
            { ownerDigest: queueOwner!, operationId: operation.slice('cos-operation='.length) },
            () => this.current(),
          );
          await admit();
          this.current();
          return archive;
        };
        await unchanged();
        for (const id of plans.credentials.keep) {
          const archive = await read(id);
          if (archive.contents.kind === 'set-v2') keptCredentials.push(archive.contents.manifest);
        }
        await credentialCoverage();
        for (const id of plans.credentials.remove) await credentialCoverage(await read(id));
        await unchanged();
      }
      for (const kind of ['state', 'credentials'] as const) {
        const ids = plans[kind].remove;
        for (let start = 0; start < ids.length; start += 128) {
          await unchanged();
          if (kind === 'credentials') await credentialCoverage();
          const batch = ids.slice(start, start + 128);
          await discard(['forget', ...batch]);
          for (const id of batch) expected.delete(id);
          await unchanged();
        }
      }
      await unchanged();
      if (plans.credentials.remove.length) await credentialCoverage();
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
        snapshot.tags.length !== tags.length ||
        new Set(snapshot.tags).size !== tags.length ||
        snapshot.tags.some((tag: unknown) => typeof tag !== 'string' || tag.length > 200) ||
        tags.some((tag) => !snapshot.tags.includes(tag))
      )
        throw Error('remote_operation_conflict');
      return { id: snapshot.id, time: snapshot.time };
    } finally {
      bytes.fill(0);
    }
  }
  /** Fixed checkpoint selection and canonical parsing. Installed callers must
   * hold the admitted repository scope and supply a fresh isolated vault sink;
   * no generic Restic extraction or caller-selected path is exposed. */
  async restore(
    kind: BackupKind,
    operationId: string,
    queueOwnerDigest: string,
    sink: BackupArchiveRestoreSink,
    admit: () => Promise<void>,
  ): Promise<BackupRemoteRestore> {
    try {
      if (
        !['state', 'credentials'].includes(kind) ||
        !uuid.test(operationId) ||
        typeof queueOwnerDigest !== 'string' ||
        !hex.test(queueOwnerDigest) ||
        typeof sink?.open !== 'function' ||
        typeof admit !== 'function'
      )
        throw Error('restore_scope_required');
      const expected = Object.freeze({ kind, operationId, ownerDigest: queueOwnerDigest });
      this.current();
      await admit();
      this.current();
      const snapshot = await this.find(kind, operationId);
      if (!snapshot) throw Error('remote_checkpoint_missing');
      await admit();
      this.current();
      const config = await this.run(['cat', 'config'], 65536);
      try {
        verifyResticRepositoryIdentity(config.toString('utf8'), this.options.repositoryId);
      } finally {
        config.fill(0);
      }
      await admit();
      this.current();
      const decoded = await readBackupArchive(
        this.output(
          ['dump', snapshot.id, 'checkpoint.tar'],
          (kind === 'state' ? BACKUP_LIMITS.staging : BACKUP_LIMITS.credentials) + 2 * 1024 ** 2,
        ),
        expected,
        sink,
        () => this.current(),
      );
      await admit();
      this.current();
      return {
        contract: 'cos-backup-remote-restore/v1',
        repositoryId: this.options.repositoryId,
        ownerDigest: this.options.ownerDigest,
        kind,
        operationId,
        snapshotId: snapshot.id,
        snapshotAt: snapshot.time,
        archiveBytes: decoded.archiveBytes,
        archiveSha256: decoded.archiveSha256,
        receipt: decoded.receipt,
        verifiedAt: new Date().toISOString(),
      };
    } catch {
      // eslint-disable-next-line preserve-caught-error -- Remote content, paths and transport failures remain private.
      throw Error('backup_restore_unavailable');
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
