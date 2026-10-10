import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import { digest } from '../domain/contracts.js';
import { verifyVaultStorage, withVaultDirectory } from './vault-storage.js';

type Access = <T>(operation: (directory: string) => Promise<T>) => Promise<T>;
export type BackupRepositoryLease = Readonly<{ assertCurrent(): void }>;
class RepositoryBusy extends Error {
  constructor() {
    super('backup_repository_busy');
  }
}
const pinned = (fd: number) => '/proc/self/fd/' + fd;
/** Fixture access is injected. Installed construction below always admits the protected vault. */
export class BackupRepositoryWriter {
  constructor(
    private readonly ownerDigest: string,
    private readonly access: Access,
  ) {
    if (!/^[a-f0-9]{64}$/.test(ownerDigest)) throw Error('backup_repository_unavailable');
  }
  async exclusive<T>(operation: (lease: BackupRepositoryLease) => Promise<T>): Promise<T> {
    try {
      if (process.platform !== 'linux') throw Error('backup_kernel_lock_required');
      return await this.access(async (root) => {
        if (
          !path.isAbsolute(root) ||
          path.resolve(root) !== root ||
          (!/^\/proc\/self\/fd\/\d+$/.test(root) && fs.realpathSync(root) !== root)
        )
          throw Error('unsafe_repository_lock');
        const rootFd = fs.openSync(
          root,
          fs.constants.O_RDONLY |
            fs.constants.O_DIRECTORY |
            (/^\/proc\/self\/fd\/\d+$/.test(root) ? 0 : fs.constants.O_NOFOLLOW),
        );
        let fd: number | undefined,
          active = false;
        try {
          const rootStat = fs.fstatSync(rootFd);
          if (!rootStat.isDirectory() || rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o777) !== 0o700)
            throw Error('unsafe_repository_lock');
          const file = path.join(pinned(rootFd), 'repository.lock');
          const expected = { contract: 'cos-backup-repository-writer/v1', ownerDigest: this.ownerDigest };
          if (!fs.lstatSync(file, { throwIfNoEntry: false })) {
            fd = fs.openSync(
              file,
              fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
              0o600,
            );
            fs.writeFileSync(fd, JSON.stringify(expected) + '\n');
            fs.fsyncSync(fd);
            fs.fsyncSync(rootFd);
          } else fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
          const initial = fs.fstatSync(fd),
            heldFd = fd;
          const checkFile = () => {
            const stat = fs.fstatSync(heldFd),
              current = fs.lstatSync(file),
              currentRoot = fs.statSync(root);
            if (
              !stat.isFile() ||
              stat.uid !== rootStat.uid ||
              stat.dev !== rootStat.dev ||
              stat.nlink !== 1 ||
              (stat.mode & 0o777) !== 0o600 ||
              stat.size > 4096 ||
              stat.dev !== initial.dev ||
              stat.ino !== initial.ino ||
              current.dev !== stat.dev ||
              current.ino !== stat.ino ||
              currentRoot.dev !== rootStat.dev ||
              currentRoot.ino !== rootStat.ino
            )
              throw Error('repository_lock_changed');
            const bytes = Buffer.alloc(stat.size + 1);
            try {
              const count = fs.readSync(heldFd, bytes, 0, bytes.length, 0),
                after = fs.fstatSync(heldFd);
              if (
                count !== stat.size ||
                after.size !== stat.size ||
                after.mtimeMs !== stat.mtimeMs ||
                after.ctimeMs !== stat.ctimeMs ||
                digest(JSON.parse(bytes.subarray(0, count).toString('utf8'))) !== digest(expected)
              )
                throw Error('repository_lock_changed');
            } finally {
              bytes.fill(0);
            }
          };
          checkFile();
          await new Promise<void>((resolve, reject) => {
            const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
              env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
              timeout: 5000,
              stdio: ['ignore', 'ignore', 'ignore', heldFd],
            });
            child.once('error', () => reject(Error('repository_kernel_lock_unavailable')));
            child.once('close', (code) =>
              code === 0
                ? resolve()
                : reject(code === 1 ? new RepositoryBusy() : Error('repository_kernel_lock_unavailable')),
            );
          });
          checkFile();
          active = true;
          const lease = Object.freeze({
            assertCurrent() {
              try {
                if (!active) throw Error('released_repository_lease');
                checkFile();
              } catch {
                // eslint-disable-next-line preserve-caught-error -- Lease paths and private ownership diagnostics are never public.
                throw Error('backup_repository_unavailable');
              }
            },
          });
          const result = await operation(lease);
          lease.assertCurrent();
          return result;
        } finally {
          active = false;
          try {
            if (fd !== undefined) fs.closeSync(fd);
          } finally {
            fs.closeSync(rootFd);
          }
        }
      });
    } catch (error) {
      if (error instanceof RepositoryBusy) throw error;
      // eslint-disable-next-line preserve-caught-error -- Private callbacks may contain credentials or repository diagnostics.
      throw Error('backup_repository_unavailable');
    }
  }
}
export function createVaultBackupRepositoryWriter(
  roots: CalendarStorageRoots,
  repositoryId: string,
): BackupRepositoryWriter {
  if (!/^[a-f0-9]{64}$/.test(repositoryId)) throw Error('backup_repository_unavailable');
  const policy = verifyVaultStorage(roots);
  return new BackupRepositoryWriter(
    digest({ targetDigest: policy.targetDigest, filesystemUuid: policy.volume.filesystemUuid, repositoryId }),
    (operation) => withVaultDirectory(roots, 'backup-credentials', operation),
  );
}
