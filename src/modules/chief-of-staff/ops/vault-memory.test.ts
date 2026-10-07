import { expect, it } from 'vitest';
import { verifyVaultMemory, type MemoryFiles } from './vault-memory.js';

function fixture() {
  const files: Record<string, string> = {
    '/proc/self/limits':
      'Limit                     Soft Limit           Hard Limit           Units\nMax core file size        0                    0                    bytes\n',
    '/proc/sys/kernel/core_pattern': 'core\n',
    '/proc/self/cgroup': '0::/user.slice/cos.service\n',
    '/sys/fs/cgroup/cgroup.controllers': 'cpu memory pids\n',
    '/sys/fs/cgroup/user.slice/cos.service/memory.swap.max': '0\n',
    '/sys/fs/cgroup/user.slice/memory.swap.max': 'max\n',
    '/sys/fs/cgroup/memory.swap.max': 'max\n',
  };
  const read: MemoryFiles = (file) => {
    if (!(file in files)) throw new Error('PRIVATE_PROCESS_CANARY');
    return files[file];
  };
  return { files, read };
}
it('admits only actual zero core limits and effective cgroup swap exclusion', () => {
  const f = fixture();
  expect(() => verifyVaultMemory(f.read)).not.toThrow();
  f.files['/sys/fs/cgroup/user.slice/cos.service/memory.swap.max'] = 'max\n';
  f.files['/sys/fs/cgroup/user.slice/memory.swap.max'] = '0\n';
  expect(() => verifyVaultMemory(f.read)).not.toThrow();
});
it.each(['core-soft', 'core-hard', 'piped-core', 'swap', 'controller', 'cgroup', 'read-failure'])(
  'closes credential admission with a fixed private error when memory protection fails: %s',
  (reason) => {
    const f = fixture();
    if (reason === 'core-soft') f.files['/proc/self/limits'] = 'Max core file size 1024 0 bytes\n';
    if (reason === 'core-hard') f.files['/proc/self/limits'] = 'Max core file size 0 unlimited bytes\n';
    if (reason === 'piped-core') f.files['/proc/sys/kernel/core_pattern'] = '|/private/core-helper %p\n';
    if (reason === 'swap') f.files['/sys/fs/cgroup/user.slice/cos.service/memory.swap.max'] = 'max\n';
    if (reason === 'controller') f.files['/sys/fs/cgroup/cgroup.controllers'] = 'cpu pids\n';
    if (reason === 'cgroup') f.files['/proc/self/cgroup'] = '0::/../../private\n';
    if (reason === 'read-failure') delete f.files['/proc/self/limits'];
    expect(() => verifyVaultMemory(f.read)).toThrow('vault_memory_unprotected');
  },
);
