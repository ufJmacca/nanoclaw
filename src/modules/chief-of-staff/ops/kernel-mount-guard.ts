import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
function mountpoint(encoded: string): string {
  if (/\\(?!040|011|012|134)/.test(encoded)) throw Error('kernel_mount_path_invalid');
  const decoded = encoded.replace(/\\(040|011|012|134)/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
  if (!decoded.startsWith('/') || decoded.includes('\0') || path.posix.normalize(decoded) !== decoded)
    throw Error('kernel_mount_path_invalid');
  return decoded;
}
const within = (file: string, root: string) => file === root || file.startsWith(root === '/' ? '/' : root + '/');
function scopedTable(bytes: Buffer, paths: readonly string[]): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.endsWith('\n')) throw Error('kernel_mount_table_invalid');
  const ids = new Set<string>(),
    selected: string[] = [];
  let root = false;
  for (const line of text.slice(0, -1).split('\n')) {
    const fields = line.split(' '),
      separator = fields.indexOf('-');
    if (
      separator < 6 ||
      fields.length !== separator + 4 ||
      fields.some((field) => !field) ||
      !/^[1-9][0-9]*$/.test(fields[0]) ||
      !/^[0-9]+$/.test(fields[1]) ||
      !/^[0-9]+:[0-9]+$/.test(fields[2]) ||
      ids.has(fields[0])
    )
      throw Error('kernel_mount_table_invalid');
    ids.add(fields[0]);
    mountpoint(fields[3]);
    const named = mountpoint(fields[4]);
    root ||= named === '/';
    if (paths.some((file) => within(file, named) || within(named, file))) selected.push(line);
  }
  if (!root || !selected.length) throw Error('kernel_mount_table_invalid');
  return selected.sort().join('\n') + '\n';
}
function mountTableDigest(paths?: readonly string[]): string {
  let fd: number | undefined;
  const buffer = Buffer.alloc(65536),
    hash = createHash('sha256'),
    chunks: Buffer[] = [];
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
      if (paths) chunks.push(Buffer.from(buffer.subarray(0, count)));
      else hash.update(buffer.subarray(0, count));
      buffer.fill(0);
    }
    if (!total) throw Error('kernel_mount_table_required');
    if (paths) {
      const bytes = Buffer.concat(chunks);
      try {
        hash.update(scopedTable(bytes, paths));
      } finally {
        bytes.fill(0);
      }
    }
    return hash.digest('hex');
  } finally {
    buffer.fill(0);
    for (const chunk of chunks) chunk.fill(0);
    if (fd !== undefined) fs.closeSync(fd);
  }
}
/** Continuity only, never mount or encryption admission. A trusted caller must
 * verify its complete storage policy while this table is unchanged, pin its
 * named descriptors, and repeat full verification before returning success.
 * Every assertion rereads the kernel table. With explicit protected paths, all
 * ancestor, covering and descendant mount records remain fixed, including IDs,
 * bind roots, propagation and remount options. Unrelated worker mounts may change.
 * Omitting paths retains the strict whole-namespace proof. No clock cache is used. */
export function pinKernelMountTable(protectedPaths?: readonly string[]): () => void {
  try {
    const paths = protectedPaths === undefined ? undefined : Object.freeze([...protectedPaths]);
    if (
      paths &&
      (!paths.length ||
        paths.length > 32 ||
        paths.some(
          (file) =>
            typeof file !== 'string' ||
            !file.startsWith('/') ||
            /[\0\r\n]/.test(file) ||
            path.posix.normalize(file) !== file,
        ))
    )
      throw Error('kernel_mount_paths_invalid');
    const initial = mountTableDigest(paths);
    return () => {
      try {
        if (mountTableDigest(paths) !== initial) throw Error('kernel_mount_table_changed');
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
