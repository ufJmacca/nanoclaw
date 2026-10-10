import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import { digest } from '../domain/contracts.js';
import { verifyVaultStorage, withVaultDirectory } from './vault-storage.js';
import { verifyVaultMemory } from './vault-memory.js';
import { localTarget } from './target-identity.js';
import { withVerifiedResticBinary } from './restic-artifact.js';
import { withSignedBackupRepository } from './backup-nas-access.js';
import { withVaultResticPassword } from './backup-password.js';
import { createVaultBackupRepositoryWriter } from './backup-repository-lease.js';
import { createVaultBackupQueue } from './backup-queue.js';
import { streamBackupArchive } from './backup-archive.js';
import { readBackupCapacity } from './backup-capacity.js';
import { BACKUP_LIMITS, admitBackupCapacity, type BackupKind, type BackupMountBinding } from './backup-policy.js';
import { BackupResticTransfer, type RemoteCheckpoint } from './backup-restic-transfer.js';
type Profile = {
  contract: 'cos-backup-repository/v1';
  rootsDigest: string;
  filesystemUuid: string;
  repositoryId: string;
  mount: BackupMountBinding;
};
const pinned = (fd: number) => '/proc/self/fd/' + fd;
function validateProfile(value: Profile, roots: CalendarStorageRoots, filesystemUuid: string): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'contract,filesystemUuid,mount,repositoryId,rootsDigest' ||
    value.contract !== 'cos-backup-repository/v1' ||
    value.rootsDigest !== digest(roots) ||
    value.filesystemUuid !== filesystemUuid ||
    typeof value.repositoryId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.repositoryId) ||
    !value.mount ||
    typeof value.mount !== 'object' ||
    Object.keys(value.mount).sort().join(',') !== 'host,mount,share' ||
    typeof value.mount.host !== 'string' ||
    isIP(value.mount.host) !== 4 ||
    value.mount.share !== 'nanoclaw-cos-backups' ||
    typeof value.mount.mount !== 'string' ||
    !path.isAbsolute(value.mount.mount) ||
    path.resolve(value.mount.mount) !== value.mount.mount ||
    value.mount.mount === '/' ||
    /[\0\r\n]/.test(value.mount.mount)
  )
    throw Error('invalid_backup_profile');
}
/** Trusted installed uploader. The caller finishes maintenance and ordinary health before
 * dispatching this independent job. This boundary also refuses maintenance and a changed
 * target release. It never initializes a repository, repairs a mount or retires queue data. */
export async function uploadVaultBackup(
  roots: CalendarStorageRoots,
  kind: BackupKind,
  operationId: string,
): Promise<RemoteCheckpoint> {
  try {
    if (
      !['state', 'credentials'].includes(kind) ||
      typeof operationId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId)
    )
      throw Error('invalid_backup_operation');
    verifyVaultMemory();
    const policy = verifyVaultStorage(roots),
      target = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot);
    if (target.lifecycle !== 'protected' || target.maintenance !== false || !target.releaseId)
      throw Error('backup_target_not_ready');
    return await withVaultDirectory(roots, 'backup-credentials', async (directory) => {
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
            validateProfile(value, roots, policy.volume.filesystemUuid);
            return value;
          } finally {
            bytes.fill(0);
          }
        };
        const profile = read(),
          profileDigest = digest(profile);
        const assertConfiguration = () => {
          verifyVaultMemory();
          if (digest(verifyVaultStorage(roots)) !== digest(policy) || digest(read()) !== profileDigest)
            throw Error('backup_configuration_changed');
          const current = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot);
          if (
            current.lifecycle !== 'protected' ||
            current.maintenance !== false ||
            current.releaseId !== target.releaseId ||
            current.generation !== target.generation
          )
            throw Error('backup_target_changed');
        };
        const producer = path.join(
          roots.installationRoot,
          'dist/modules/chief-of-staff/ops/backup-archive-producer.js',
        );
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
              withVaultDirectory(roots, 'cache', async (cacheDirectory) => {
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
                  return await writer.exclusive(async (lease) =>
                    queue.withPending(kind, operationId, async (data, receipt) => {
                      if (
                        receipt.ownerDigest !==
                        digest({ targetDigest: policy.targetDigest, filesystemUuid: policy.volume.filesystemUuid })
                      )
                        throw Error('backup_queue_owner_changed');
                      const archive = await streamBackupArchive(data, receipt, async () => {});
                      const transfer = new BackupResticTransfer({
                        binary,
                        repository,
                        password,
                        cache,
                        writer: lease,
                        repositoryId: profile.repositoryId,
                        ownerDigest: digest({
                          targetDigest: policy.targetDigest,
                          filesystemUuid: policy.volume.filesystemUuid,
                          repositoryId: profile.repositoryId,
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
                        admitUpload: async (selected, bytes) => {
                          cache.assertCurrent();
                          if (selected !== kind || bytes !== archive.bytes) throw Error('backup_archive_changed');
                          const usage = await readBackupCapacity(roots, repository);
                          admitBackupCapacity(usage, { kind, bytes: receipt.bytes }, 'remote');
                          const reserve = archive.bytes * 2 + 4 * 1024 ** 2;
                          if (
                            usage.repository + reserve > BACKUP_LIMITS.repository ||
                            usage.nasFree - reserve < BACKUP_LIMITS.nasFreeFloor
                          )
                            throw Error('backup_capacity_unavailable');
                        },
                      });
                      const result = await transfer.upload(kind, operationId, archive);
                      const finalUsage = await readBackupCapacity(roots, repository);
                      admitBackupCapacity(finalUsage, { kind, bytes: 1 }, 'remote');
                      cache.assertCurrent();
                      return result;
                    }),
                  );
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
    throw Error('backup_upload_unavailable');
  }
}
