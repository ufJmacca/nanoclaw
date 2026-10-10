import fs from 'node:fs';
import path from 'node:path';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import { withVaultDirectory } from './vault-storage.js';
import type { SignedBackupRepository } from './backup-nas-access.js';
import type { BackupCapacity } from './backup-policy.js';
const pinned = (fd: number) => '/proc/self/fd/' + fd;
function allocated(stat: fs.Stats): number {
  if (![stat.size, stat.blocks].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw Error('capacity_bounds');
  const bytes = Math.max(stat.size, stat.blocks * 512, Math.ceil(stat.size / 4096) * 4096);
  if (!Number.isSafeInteger(bytes)) throw Error('capacity_bounds');
  return bytes;
}
function measure(root: string, device?: number, depth = 0, visited = { count: 0 }): number {
  const alias = /^\/proc\/self\/fd\/\d+$/.test(root);
  const heldChild = device !== undefined && /^\/proc\/self\/fd\/\d+\/[^/]+$/.test(root);
  if (
    depth > 12 ||
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    (!alias && !heldChild && fs.realpathSync(root) !== root)
  )
    throw Error('unsafe_capacity_root');
  const fd = fs.openSync(
    root,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (alias ? 0 : fs.constants.O_NOFOLLOW),
  );
  try {
    const before = fs.fstatSync(fd);
    if (
      !before.isDirectory() ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o777) !== 0o700 ||
      (device !== undefined && before.dev !== device)
    )
      throw Error('unsafe_capacity_directory');
    let total = allocated(before);
    for (const name of fs.readdirSync(pinned(fd))) {
      if (
        ++visited.count > 65536 ||
        !name ||
        name === '.' ||
        name === '..' ||
        /[\0/]/.test(name) ||
        Buffer.byteLength(name) > 255
      )
        throw Error('capacity_tree_bounds');
      const file = path.join(pinned(fd), name),
        stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || stat.uid !== before.uid || stat.dev !== before.dev)
        throw Error('unsafe_capacity_file');
      if (stat.isDirectory()) total += measure(file, before.dev, depth + 1, visited);
      else if (stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600) {
        total += allocated(stat);
        const after = fs.lstatSync(file);
        if (
          after.dev !== stat.dev ||
          after.ino !== stat.ino ||
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs
        )
          throw Error('capacity_file_changed');
      } else throw Error('unsafe_capacity_file');
      if (!Number.isSafeInteger(total)) throw Error('capacity_bounds');
    }
    const after = fs.fstatSync(fd),
      current = fs.statSync(root);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.uid !== before.uid ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.dev !== before.dev ||
      current.ino !== before.ino
    )
      throw Error('capacity_directory_changed');
    return total;
  } finally {
    fs.closeSync(fd);
  }
}
function free(root: string): number {
  const stat = fs.statfsSync(root, { bigint: true });
  if (typeof stat.bavail !== 'bigint' || typeof stat.bsize !== 'bigint' || stat.bavail < 0n || stat.bsize < 1n)
    throw Error('capacity_free_unavailable');
  const bytes = Number(stat.bavail * stat.bsize);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error('capacity_bounds');
  return bytes;
}
/** Admission consumes measured usage, never receipt claims or a configured free-space value.
 * All local paths come from the protected vault accessor; the repository is already pinned
 * by signed NAS access. This reads metadata only and never acquires a queue writer lease. */
export async function readBackupCapacity(
  roots: CalendarStorageRoots,
  repository: SignedBackupRepository,
): Promise<BackupCapacity> {
  try {
    if (process.platform !== 'linux') throw Error('linux_required');
    repository.assertCurrent();
    let vaultFree = Number.MAX_SAFE_INTEGER;
    const usage: Record<string, number> = {};
    for (const area of ['staging', 'cache', 'journals'] as const)
      usage[area] = await withVaultDirectory(roots, area, async (directory) => {
        const bytes = measure(directory);
        vaultFree = Math.min(vaultFree, free(directory));
        return bytes;
      });
    const directory = pinned(repository.fd),
      remote = measure(directory),
      nasFree = free(directory);
    repository.assertCurrent();
    return {
      staging: usage.staging,
      cache: usage.cache,
      credentials: usage.journals,
      repository: remote,
      nasFree,
      vaultFree,
    };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- File names, private paths and NAS errors remain private.
    throw Error('backup_capacity_unavailable');
  }
}
