import fs from 'node:fs';
import path from 'node:path';
export type MemoryFiles = (file: string) => string;
const hostRead: MemoryFiles = (file) => fs.readFileSync(file, 'utf8');
/** Inspect the process actually handling credentials. Unit-file settings alone are not proof.
 * A piped core handler can ignore RLIMIT_CORE, so it needs a separate process protection proof.
 */
export function verifyVaultMemory(read: MemoryFiles = hostRead): void {
  try {
    if (process.platform !== 'linux') throw new Error('linux_required');
    const bounded = (file: string) => {
      const value = read(file);
      if (typeof value !== 'string' || Buffer.byteLength(value) > 65536) throw new Error('memory_bounds');
      return value;
    };
    const core = bounded('/proc/self/limits').match(/^Max core file size\s+(\S+)\s+(\S+)\s+bytes\s*$/m);
    if (!core || core[1] !== '0' || core[2] !== '0' || bounded('/proc/sys/kernel/core_pattern').trim().startsWith('|'))
      throw new Error('core_unprotected');
    if (!bounded('/sys/fs/cgroup/cgroup.controllers').trim().split(/\s+/).includes('memory'))
      throw new Error('memory_controller_missing');
    const groups = bounded('/proc/self/cgroup').trim().split('\n');
    if (groups.length !== 1 || !groups[0].startsWith('0::/')) throw new Error('unified_cgroup_required');
    const relative = groups[0].slice(3);
    if (!/^\/[a-zA-Z0-9_.@/-]*$/.test(relative) || path.posix.resolve(relative) !== relative)
      throw new Error('unsafe_cgroup');
    let current = relative;
    for (;;) {
      const maximum = bounded(path.posix.join('/sys/fs/cgroup', current, 'memory.swap.max')).trim();
      if (maximum === '0') return;
      if (maximum !== 'max' && !/^[1-9][0-9]*$/.test(maximum)) throw new Error('invalid_swap_limit');
      if (current === '/') break;
      current = path.posix.dirname(current);
    }
    throw new Error('swap_unprotected');
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Process/cgroup diagnostics can include private host paths.
    throw new Error('vault_memory_unprotected');
  }
}
