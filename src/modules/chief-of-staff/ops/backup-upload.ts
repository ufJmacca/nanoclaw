import fs from 'node:fs';
import path from 'node:path';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import { digest } from '../domain/contracts.js';
import { verifyVaultStorage, withVaultDirectory } from './vault-storage.js';
import { verifyVaultMemory } from './vault-memory.js';
import { localTarget } from './target-identity.js';
import { withVerifiedResticBinary } from './restic-artifact.js';
import { withSignedBackupRepository, type SignedBackupRepository } from './backup-nas-access.js';
import { withVaultResticPassword } from './backup-password.js';
import { createVaultBackupRepositoryWriter } from './backup-repository-lease.js';
import { createVaultBackupQueue } from './backup-queue.js';
import { readBackupCapacity } from './backup-capacity.js';
import { backupProducerFile } from './backup-producer-file.js';
import { BACKUP_LIMITS, admitBackupCapacity, type BackupKind } from './backup-policy.js';
import {
  BackupResticTransfer,
  type RemoteCheckpoint,
  type BackupMaintenanceResult,
  type BackupRemoteRestore,
} from './backup-restic-transfer.js';
import type { BackupRestoreValidationScope } from './backup-restore-workspace.js';
import {
  validateBackupRepositoryProfile,
  type BackupRepositoryProfile as Profile,
} from './backup-repository-profile.js';
import { withVaultCredentialSnapshot } from './credential-vault-snapshot.js';
const pinned = (fd: number) => '/proc/self/fd/' + fd;
type RepositoryScope = {
  queue: ReturnType<typeof createVaultBackupQueue>;
  repository: SignedBackupRepository;
  repositoryId: string;
  ownerDigest: string;
  queueOwnerDigest: string;
  assertCurrent(): void;
  transfer(admitUpload: (kind: BackupKind, bytes: number) => Promise<void>): BackupResticTransfer;
};
/** Private admitted scope shared by installed upload, retention and recovery. A caller
 * cannot substitute a repository, password, binary, producer or writer. */
async function withVaultBackupRepository<T>(
  roots: CalendarStorageRoots,
  assertCaller: () => void,
  operation: (scope: RepositoryScope) => Promise<T>,
): Promise<T> {
  try {
    if (typeof assertCaller !== 'function') throw Error('backup_caller_unverified');
    assertCaller();
    verifyVaultMemory();
    const policy = verifyVaultStorage(roots),
      target = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot);
    if (target.lifecycle !== 'protected' || target.maintenance !== false || !target.releaseId)
      throw Error('backup_target_not_ready');
    return await withVaultDirectory(roots, 'backup-credentials', async (directory, assertVault) => {
      if (typeof assertVault !== 'function') throw Error('vault_scope_required');
      assertVault();
      const alias = /^\/proc\/self\/fd\/\d+$/.test(directory);
      const rootFd = fs.openSync(
        directory,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (alias ? 0 : fs.constants.O_NOFOLLOW),
      );
      let profileFd: number | undefined;
      try {
        const root = fs.fstatSync(rootFd);
        if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o777) !== 0o700)
          throw Error('unsafe_backup_profile_root');
        const file = path.join(pinned(rootFd), 'backup-repository.json');
        profileFd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const held = profileFd,
          initial = fs.fstatSync(held);
        const read = (): Profile => {
          const stat = fs.fstatSync(held),
            current = fs.lstatSync(file);
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.uid !== root.uid ||
            stat.dev !== root.dev ||
            (stat.mode & 0o777) !== 0o600 ||
            stat.size < 1 ||
            stat.size > 8192 ||
            stat.dev !== initial.dev ||
            stat.ino !== initial.ino ||
            stat.size !== initial.size ||
            stat.mtimeMs !== initial.mtimeMs ||
            stat.ctimeMs !== initial.ctimeMs ||
            current.dev !== initial.dev ||
            current.ino !== initial.ino
          )
            throw Error('backup_profile_changed');
          const bytes = Buffer.alloc(stat.size + 1);
          try {
            const count = fs.readSync(held, bytes, 0, bytes.length, 0),
              after = fs.fstatSync(held);
            if (
              count !== stat.size ||
              after.size !== stat.size ||
              after.mtimeMs !== stat.mtimeMs ||
              after.ctimeMs !== stat.ctimeMs
            )
              throw Error('backup_profile_changed');
            const value = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)),
            ) as Profile;
            validateBackupRepositoryProfile(value, roots, policy.volume.filesystemUuid);
            return value;
          } finally {
            bytes.fill(0);
          }
        };
        const profile = read(),
          profileDigest = digest(profile);
        const assertConfiguration = () => {
          assertCaller();
          verifyVaultMemory();
          assertVault();
          if (digest(read()) !== profileDigest) throw Error('backup_configuration_changed');
          const current = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot);
          if (
            current.lifecycle !== 'protected' ||
            current.maintenance !== false ||
            current.releaseId !== target.releaseId ||
            current.generation !== target.generation
          )
            throw Error('backup_target_changed');
        };
        const producer = backupProducerFile();
        const producerStat = fs.lstatSync(producer);
        if (
          !producerStat.isFile() ||
          producerStat.nlink !== 1 ||
          (producerStat.mode & 0o022) !== 0 ||
          ![0, process.getuid?.()].includes(producerStat.uid) ||
          fs.realpathSync(producer) !== producer
        )
          throw Error('backup_producer_unverified');
        assertConfiguration();
        const assertProducer = () => {
          const current = fs.lstatSync(producer);
          if (
            fs.realpathSync(producer) !== producer ||
            current.dev !== producerStat.dev ||
            current.ino !== producerStat.ino ||
            current.mode !== producerStat.mode ||
            current.uid !== producerStat.uid ||
            current.nlink !== 1 ||
            current.size !== producerStat.size ||
            current.mtimeMs !== producerStat.mtimeMs ||
            current.ctimeMs !== producerStat.ctimeMs
          )
            throw Error('backup_producer_changed');
        };
        return await withVerifiedResticBinary(path.join(roots.installationRoot, 'libexec/restic'), async (binary) =>
          withSignedBackupRepository(profile.mount, async (repository) =>
            withVaultResticPassword(roots, async (password) =>
              withVaultDirectory(roots, 'cache', async (cacheDirectory, assertCacheVault) => {
                if (typeof assertCacheVault !== 'function') throw Error('vault_scope_required');
                assertCacheVault();
                const cacheAlias = /^\/proc\/self\/fd\/\d+$/.test(cacheDirectory);
                const cacheFd = fs.openSync(
                  cacheDirectory,
                  fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (cacheAlias ? 0 : fs.constants.O_NOFOLLOW),
                );
                try {
                  const cacheStat = fs.fstatSync(cacheFd);
                  const cache = Object.freeze({
                    fd: cacheFd,
                    assertCurrent() {
                      assertConfiguration();
                      assertCacheVault();
                      assertProducer();
                      const current = fs.statSync(cacheDirectory),
                        held = fs.fstatSync(cacheFd);
                      if (
                        !held.isDirectory() ||
                        held.uid !== process.getuid?.() ||
                        (held.mode & 0o777) !== 0o700 ||
                        current.dev !== cacheStat.dev ||
                        current.ino !== cacheStat.ino ||
                        held.dev !== cacheStat.dev ||
                        held.ino !== cacheStat.ino
                      )
                        throw Error('backup_cache_changed');
                    },
                  });
                  cache.assertCurrent();
                  const writer = createVaultBackupRepositoryWriter(roots, profile.repositoryId),
                    queue = createVaultBackupQueue(roots);
                  return await writer.exclusive(async (lease) => {
                    const repositoryOwner = digest({
                      targetDigest: policy.targetDigest,
                      filesystemUuid: policy.volume.filesystemUuid,
                      repositoryId: profile.repositoryId,
                    });
                    const assertCurrent = () => {
                      lease.assertCurrent();
                      binary.assertCurrent();
                      repository.assertCurrent();
                      password.assertCurrent();
                      cache.assertCurrent();
                    };
                    assertCurrent();
                    const result = await operation({
                      queue,
                      repository,
                      repositoryId: profile.repositoryId,
                      ownerDigest: repositoryOwner,
                      queueOwnerDigest: digest({
                        targetDigest: policy.targetDigest,
                        filesystemUuid: policy.volume.filesystemUuid,
                      }),
                      assertCurrent,
                      transfer: (admitUpload) =>
                        new BackupResticTransfer({
                          binary,
                          repository,
                          password,
                          cache,
                          writer: lease,
                          repositoryId: profile.repositoryId,
                          ownerDigest: repositoryOwner,
                          credentialInventory: async () =>
                            withVaultCredentialSnapshot(roots, { assertAuthority: assertCurrent }, async (snapshot) => {
                              snapshot.assertPrimaryUnchanged();
                              return {
                                ownerDigest: snapshot.ownerDigest,
                                sources: snapshot.sources.map(({ event, files }) => ({
                                  event,
                                  files: files.map(({ name, destination }) => ({ name, destination })),
                                })),
                              };
                            }),
                          producer: (selected, id) => [
                            process.execPath,
                            producer,
                            roots.targetRoot,
                            roots.installationRoot,
                            roots.dataRoot,
                            selected,
                            id,
                          ],
                          admitUpload,
                        }),
                    });
                    assertCurrent();
                    return result;
                  });
                } finally {
                  fs.closeSync(cacheFd);
                }
              }),
            ),
          ),
        );
      } finally {
        try {
          if (profileFd !== undefined) fs.closeSync(profileFd);
        } finally {
          fs.closeSync(rootFd);
        }
      }
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Profile fields, NAS addresses, paths and secret command errors remain private.
    throw Error('backup_repository_scope_unavailable');
  }
}

/** Independent upload after fresh retained-service admission. Retirement keeps
 * its original remote recovery intent and requires fresh readback. */
export async function uploadVaultBackup(
  roots: CalendarStorageRoots,
  kind: BackupKind,
  operationId: string,
  assertCaller: () => void = () => {},
): Promise<RemoteCheckpoint> {
  try {
    if (
      !['state', 'credentials'].includes(kind) ||
      typeof operationId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId)
    )
      throw Error('invalid_backup_operation');
    return await withVaultBackupRepository(roots, assertCaller, async (scope) =>
      scope.queue.retirePending(kind, operationId, async ({ receipt, archive, previous }) => {
        scope.assertCurrent();
        if (receipt.ownerDigest !== scope.queueOwnerDigest) throw Error('backup_queue_owner_changed');
        if (previous && (previous.repositoryId !== scope.repositoryId || previous.ownerDigest !== scope.ownerDigest))
          throw Error('backup_repository_owner_changed');
        const transfer = scope.transfer(async (selected, bytes) => {
          scope.assertCurrent();
          if (selected !== kind || bytes !== archive.bytes) throw Error('backup_archive_changed');
          const usage = await readBackupCapacity(roots, scope.repository);
          scope.assertCurrent();
          admitBackupCapacity(usage, { kind, bytes: receipt.bytes }, 'remote');
          const reserve = archive.bytes * 2 + 4 * 1024 ** 2;
          if (
            usage.repository + reserve > BACKUP_LIMITS.repository ||
            usage.nasFree - reserve < BACKUP_LIMITS.nasFreeFloor
          )
            throw Error('backup_capacity_unavailable');
        });
        const result = previous
          ? await transfer.verify(kind, operationId, archive, receipt)
          : await transfer.upload(kind, operationId, archive);
        const finalUsage = await readBackupCapacity(roots, scope.repository);
        scope.assertCurrent();
        admitBackupCapacity(finalUsage, { kind, bytes: 1 }, 'remote');
        return { checkpoint: result, assertCurrent: scope.assertCurrent };
      }),
    );
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private profile, queue and provider diagnostics stay out of owner status.
    throw Error('backup_upload_unavailable');
  }
}

/** Fixed repository maintenance never captures, repairs or removes local work.
 * Pending remote reconciliation protects its original snapshot from retention. */
export async function maintainVaultBackups(
  roots: CalendarStorageRoots,
  assertCaller: () => void,
): Promise<BackupMaintenanceResult> {
  try {
    return await withVaultBackupRepository(roots, assertCaller, async (scope) => {
      const admit = async () => {
        scope.assertCurrent();
        for (const kind of ['state', 'credentials'] as const) {
          const delivery = await scope.queue.inspectDelivery(kind);
          scope.assertCurrent();
          if (delivery.items.some((entry) => entry.disposition === 'reconcile'))
            throw Error('backup_retirement_pending');
        }
        const usage = await readBackupCapacity(roots, scope.repository);
        scope.assertCurrent();
        admitBackupCapacity(usage, { kind: 'state', bytes: 1 }, 'remote');
        // Fixed 16 MiB repack input plus conservative metadata/pack headroom.
        const reserve = 132 * 1024 ** 2,
          localReserve = 64 * 1024 ** 2;
        if (
          usage.repository + reserve > BACKUP_LIMITS.repository ||
          usage.nasFree - reserve < BACKUP_LIMITS.nasFreeFloor ||
          usage.cache + localReserve > BACKUP_LIMITS.cache ||
          usage.vaultFree < localReserve + BACKUP_LIMITS.vaultReserve
        )
          throw Error('backup_capacity_unavailable');
      };
      await admit();
      const result = await scope
        .transfer(async () => {
          throw Error('maintenance_cannot_upload');
        })
        .maintain(admit);
      scope.assertCurrent();
      return result;
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Repository, queue and capacity diagnostics remain private.
    throw Error('backup_maintenance_unavailable');
  }
}

/** Installed recovery composition only. This creates a new encrypted staging
 * workspace under the full-checkpoint writer and keeps the actual repository
 * writer for readback and mandatory trusted validation. Recovered data grants
 * no live admission; pending work and independent journals remain current. */
export async function restoreVaultBackup<T>(
  roots: CalendarStorageRoots,
  kind: BackupKind,
  operationId: string,
  requestId: string,
  assertCaller: () => void,
  validate: (scope: BackupRestoreValidationScope, remote: BackupRemoteRestore) => Promise<T>,
): Promise<{ remote: BackupRemoteRestore; validation: T }> {
  try {
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
    if (
      !['state', 'credentials'].includes(kind) ||
      typeof operationId !== 'string' ||
      !uuid.test(operationId) ||
      typeof requestId !== 'string' ||
      !uuid.test(requestId) ||
      typeof assertCaller !== 'function' ||
      typeof validate !== 'function'
    )
      throw Error('restore_scope_required');
    return await withVaultBackupRepository(roots, assertCaller, async (scope) => {
      const transportReserve = 64 * 1024 ** 2;
      const admit = async () => {
        scope.assertCurrent();
        const usage = await readBackupCapacity(roots, scope.repository);
        scope.assertCurrent();
        admitBackupCapacity(usage, { kind, bytes: 1 }, 'remote');
        if (
          usage.cache + transportReserve > BACKUP_LIMITS.cache ||
          usage.vaultFree < transportReserve + BACKUP_LIMITS.vaultReserve
        )
          throw Error('backup_capacity_unavailable');
      };
      await admit();
      return await scope.queue.withRestoreWorkspace(
        requestId,
        scope.assertCurrent,
        async (workspace) => {
          const transfer = scope.transfer(async () => {
            throw Error('restore_cannot_upload');
          });
          const remote = await transfer.restore(kind, operationId, scope.queueOwnerDigest, workspace.sink, admit);
          workspace.assertCurrent();
          if (
            remote.contract !== 'cos-backup-remote-restore/v1' ||
            remote.repositoryId !== scope.repositoryId ||
            remote.ownerDigest !== scope.ownerDigest ||
            remote.kind !== kind ||
            remote.operationId !== operationId ||
            remote.receipt.ownerDigest !== scope.queueOwnerDigest ||
            remote.receipt.kind !== kind ||
            remote.receipt.operationId !== operationId
          )
            throw Error('backup_restore_identity_changed');
          await admit();
          workspace.assertCurrent();
          const identity = digest(remote);
          const validation = await validate(
            Object.freeze({
              directory: workspace.directory,
              assertCurrent: workspace.assertCurrent,
              assertPayloadCurrent: workspace.assertPayloadCurrent,
              ensureDirectory: workspace.ensureDirectory,
              inspectFile: workspace.inspectFile,
              withFileBytes: workspace.withFileBytes,
            }),
            remote,
          );
          workspace.assertCurrent();
          if (digest(remote) !== identity) throw Error('backup_restore_evidence_changed');
          await admit();
          workspace.assertCurrent();
          return { remote, validation };
        },
        transportReserve,
      );
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Recovered payload, credential, repository and validator diagnostics stay private.
    throw Error('backup_restore_check_unavailable');
  }
}
