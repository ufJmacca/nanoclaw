import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { verifySignedBackupMount, type BackupMountBinding } from './backup-policy.js';
import { pinKernelMountTable } from './kernel-mount-guard.js';
export type SignedBackupRepository = Readonly<{ fd: number; assertCurrent(): void }>;
const pinned = (fd: number) => '/proc/self/fd/' + fd;
// Linux fs/smb/client/smb2ops.c reports SMB2_SUPER_MAGIC from statfs, including SMB2.1.
const smb2 = 0xfe534d42n;
const inspection: StorageInspection = (command, args) =>
  execFileSync(command, args, {
    cwd: '/',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 262144,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
function privateDirectory(stat: fs.Stats, device?: number): void {
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    (device !== undefined && stat.dev !== device)
  )
    throw Error('unsafe_repository_directory');
}
function descriptorMountId(fd: number): number {
  const text = fs.readFileSync('/proc/self/fdinfo/' + fd, 'utf8');
  if (Buffer.byteLength(text) > 8192) throw Error('mount_id_bounds');
  const matches = [...text.matchAll(/^mnt_id:[\t ]+([0-9]+)[\t ]*$/gm)];
  const id = Number(matches[0]?.[1]);
  if (matches.length !== 1 || !Number.isSafeInteger(id) || id < 1) throw Error('mount_id_required');
  return id;
}
/** Opens only the fixed restic child of an existing dedicated share. This never mounts,
 * creates or repairs a path, and never reads a password before admitting the kernel mount.
 * The caller additionally verifies the decrypted repository ID and owns the writer lease. */
export async function withSignedBackupRepository<T>(
  input: BackupMountBinding,
  operation: (repository: SignedBackupRepository) => Promise<T>,
  inspect: StorageInspection = inspection,
): Promise<T> {
  let mountFd: number | undefined,
    repositoryFd: number | undefined,
    active = false;
  try {
    if (process.platform !== 'linux') throw Error('linux_required');
    const assertKernel = pinKernelMountTable();
    const binding = Object.freeze({ ...input });
    const mountIdentity = () => {
      const text = inspect('/usr/bin/findmnt', [
        '--json',
        '--mountpoint',
        binding.mount,
        '--output',
        'TARGET,SOURCE,FSTYPE,OPTIONS,ID',
      ]);
      const proof = verifySignedBackupMount(binding, text);
      const id = JSON.parse(text).filesystems[0].id as unknown;
      if (!Number.isSafeInteger(id) || Number(id) < 1) throw Error('mount_id_required');
      return { ...proof, id };
    };
    const initialMount = mountIdentity();
    if (fs.realpathSync(binding.mount) !== binding.mount) throw Error('linked_mount');
    const before = fs.lstatSync(binding.mount);
    privateDirectory(before);
    mountFd = fs.openSync(binding.mount, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const heldMount = mountFd,
      mountStat = fs.fstatSync(heldMount);
    privateDirectory(mountStat);
    if (
      before.dev !== mountStat.dev ||
      before.ino !== mountStat.ino ||
      fs.statfsSync(pinned(heldMount), { bigint: true }).type !== smb2 ||
      descriptorMountId(heldMount) !== initialMount.id
    )
      throw Error('mount_changed');
    repositoryFd = fs.openSync(
      path.join(pinned(heldMount), 'restic'),
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const heldRepository = repositoryFd,
      repositoryStat = fs.fstatSync(heldRepository);
    privateDirectory(repositoryStat, mountStat.dev);
    if (descriptorMountId(heldRepository) !== initialMount.id) throw Error('nested_repository_mount');
    active = true;
    const assertCurrent = () => {
      try {
        if (!active) throw Error('released_repository_mount');
        assertKernel();
        if (fs.realpathSync(binding.mount) !== binding.mount) throw Error('mount_changed');
        for (const [fd, original, file] of [
          [heldMount, mountStat, binding.mount],
          [heldRepository, repositoryStat, path.join(binding.mount, 'restic')],
        ] as const) {
          const current = fs.lstatSync(file),
            held = fs.fstatSync(fd);
          privateDirectory(current, mountStat.dev);
          privateDirectory(held, mountStat.dev);
          if (
            current.dev !== original.dev ||
            current.ino !== original.ino ||
            held.dev !== original.dev ||
            held.ino !== original.ino ||
            fs.statfsSync(pinned(fd), { bigint: true }).type !== smb2 ||
            descriptorMountId(fd) !== initialMount.id
          )
            throw Error('repository_mount_changed');
        }
        assertKernel();
      } catch {
        // eslint-disable-next-line preserve-caught-error -- NAS paths and kernel diagnostics never enter public status.
        throw Error('backup_repository_mount_unverified');
      }
    };
    const lease = Object.freeze({ fd: heldRepository, assertCurrent });
    lease.assertCurrent();
    const result = await operation(lease);
    lease.assertCurrent();
    const finalMount = mountIdentity();
    if (finalMount.id !== initialMount.id || finalMount.bindingDigest !== initialMount.bindingDigest)
      throw Error('mount_changed');
    lease.assertCurrent();
    return result;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Awaited callbacks may contain private credentials and diagnostics.
    throw Error('backup_repository_mount_unverified');
  } finally {
    active = false;
    try {
      if (repositoryFd !== undefined) fs.closeSync(repositoryFd);
    } finally {
      if (mountFd !== undefined) fs.closeSync(mountFd);
    }
  }
}
