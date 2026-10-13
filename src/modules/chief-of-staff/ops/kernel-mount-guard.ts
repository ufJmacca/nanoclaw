import fs from 'node:fs';
import { createHash } from 'node:crypto';
function mountTableDigest(): string {
  let fd: number | undefined;
  const buffer = Buffer.alloc(65536),
    hash = createHash('sha256');
  try {
    if (process.platform !== 'linux') throw Error('linux_required');
    fd = fs.openSync('/proc/self/mountinfo', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile() || fs.statfsSync('/proc/self/fd/' + fd, { bigint: true }).type !== 0x9fa0n)
      throw Error('kernel_mount_table_required');
    let total = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, total);
      if (!count) break;
      total += count;
      if (total > 1024 ** 2) throw Error('kernel_mount_table_bounds');
      hash.update(buffer.subarray(0, count));
      buffer.fill(0);
    }
    if (!total) throw Error('kernel_mount_table_required');
    return hash.digest('hex');
  } finally {
    buffer.fill(0);
    if (fd !== undefined) fs.closeSync(fd);
  }
}
/** Continuity only, never mount or encryption admission. A trusted caller must
 * verify its complete storage policy while this table is unchanged, pin its
 * named descriptors, and repeat full verification before returning success.
 * Every assertion reads the current kernel table; any namespace mount change,
 * including remount options, withdraws the scope. No clock cache is used. */
export function pinKernelMountTable(): () => void {
  try {
    const initial = mountTableDigest();
    return () => {
      try {
        if (mountTableDigest() !== initial) throw Error('kernel_mount_table_changed');
      } catch {
        // eslint-disable-next-line preserve-caught-error -- Kernel paths and mount data never leave the trusted process.
        throw Error('kernel_mount_unverified');
      }
    };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Kernel inspection failures expose only this fixed category.
    throw Error('kernel_mount_unverified');
  }
}
