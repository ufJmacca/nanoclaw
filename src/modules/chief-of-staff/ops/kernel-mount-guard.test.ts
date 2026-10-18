import fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { pinKernelMountTable } from './kernel-mount-guard.js';
function kernelTable(initial: string) {
  let table = initial;
  const read = fs.readSync;
  vi.spyOn(fs, 'readSync').mockImplementation(((
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => {
    if (!fs.readlinkSync('/proc/self/fd/' + fd).endsWith('/mountinfo'))
      return Reflect.apply(read, fs, [fd, buffer, offset, length, position]);
    return Buffer.from(table)
      .subarray(Number(position), Number(position) + length)
      .copy(buffer, offset);
  }) as typeof fs.readSync);
  return (next: string) => {
    table = next;
  };
}
const rootMount = '1 0 8:1 / / rw - ext4 /dev/root rw\n';
const vaultMount = '2 1 253:0 / /private/vault rw - ext4 /dev/mapper/vault rw\n';
const workerMount = '3 1 0:45 / /var/lib/docker/overlay2/worker/merged rw - overlay overlay rw\n';
const namespaceMount = '4 1 0:4 net:[4026533001] /run/docker/netns/worker rw - nsfs nsfs rw\n';
afterEach(() => vi.restoreAllMocks());
it('keeps a protected storage scope open while an unrelated worker mount starts and stops', () => {
  const change = kernelTable(rootMount + vaultMount);
  const current = pinKernelMountTable(['/private/vault', '/private/target']);
  change(rootMount + vaultMount + workerMount);
  expect(() => current()).not.toThrow();
  change(rootMount + vaultMount);
  expect(() => current()).not.toThrow();
});
it.each(['net', 'mnt', 'uts', 'ipc', 'pid', 'user', 'cgroup', 'time'])(
  'accepts an existing unrelated %s namespace bind and its subsequent mount changes',
  (name) => {
    const namespace = namespaceMount.replace('net:[', name + ':['),
      change = kernelTable(rootMount + vaultMount + namespace),
      current = pinKernelMountTable(['/private/vault']);
    expect(() => current()).not.toThrow();
    change(rootMount + vaultMount + namespace.replace('4026533001', '4026533002'));
    expect(() => current()).not.toThrow();
    change(rootMount + vaultMount);
    expect(() => current()).not.toThrow();
  },
);
it.each([namespaceMount.replace('4026533001', '4026533002'), namespaceMount.replace('4 1', '5 1'), ''])(
  'retains the identity of a namespace bind inside protected storage',
  (changed) => {
    const protectedNamespace = (record: string) => record.replace('/run/docker/netns/worker', '/private/vault/netns'),
      change = kernelTable(rootMount + vaultMount + protectedNamespace(namespaceMount)),
      current = pinKernelMountTable(['/private/vault']);
    expect(() => current()).not.toThrow();
    change(rootMount + vaultMount + protectedNamespace(changed));
    expect(() => current()).toThrow(/^kernel_mount_unverified$/);
  },
);
it.each([
  namespaceMount.replace('- nsfs', '- ext4'),
  namespaceMount.replace('net:[4026533001]', 'relative'),
  namespaceMount.replace('net:[4026533001]', 'net:[0]'),
  namespaceMount.replace('net:[4026533001]', 'net:[-1]'),
  namespaceMount.replace('net:[4026533001]', 'net:[4026533001]extra'),
  namespaceMount.replace('net:[4026533001]', 'net/other:[4026533001]'),
  namespaceMount.replace('net:[4026533001]', 'net:[4026533001'),
  namespaceMount.replace('/run/docker/netns/worker', 'net:[4026533001]'),
  vaultMount.replace('253:0 / ', '253:0 relative '),
])('refuses malformed namespace roots, non-nsfs relative roots and non-path mountpoints', (record) => {
  kernelTable(rootMount + record);
  expect(() => pinKernelMountTable(['/private/vault'])).toThrow(/^kernel_mount_unverified$/);
});
it.each([
  rootMount,
  rootMount + vaultMount.replace('rw - ext4', 'ro - ext4'),
  rootMount + vaultMount.replace('2 1', '4 1'),
  rootMount + vaultMount + '4 2 0:46 / /private/vault/credentials rw - tmpfs tmpfs rw\n',
  rootMount + vaultMount + '4 1 0:46 / /private rw - tmpfs tmpfs rw\n',
  rootMount.replace('rw - ext4', 'ro - ext4') + vaultMount,
])('refuses a changed vault, ancestor, nested mount or mount instance', (changed) => {
  const change = kernelTable(rootMount + vaultMount);
  const current = pinKernelMountTable(['/private/vault']);
  change(changed);
  expect(() => current()).toThrow(/^kernel_mount_unverified$/);
});
it('compares path components and decodes escaped kernel mountpoints', () => {
  const escaped = vaultMount.replace('/private/vault', '/private/secret\\040vault');
  const change = kernelTable(rootMount + escaped);
  const current = pinKernelMountTable(['/private/secret vault']);
  change(rootMount + escaped + '4 1 0:46 / /private/secret\\040vault-other rw - tmpfs tmpfs rw\n');
  expect(() => current()).not.toThrow();
  change(rootMount + escaped + '4 2 0:46 / /private/secret\\040vault/child rw - tmpfs tmpfs rw\n');
  expect(() => current()).toThrow(/^kernel_mount_unverified$/);
});
it.each(['broken\n', rootMount + rootMount, rootMount + vaultMount.replace('/private/vault', '/private/\\999')])(
  'refuses malformed or duplicate kernel records in a scoped proof',
  (table) => {
    kernelTable(table);
    expect(() => pinKernelMountTable(['/private/vault'])).toThrow(/^kernel_mount_unverified$/);
  },
);
it.each([{ paths: [] }, { paths: ['relative'] }, { paths: ['/private/../vault'] }])(
  'refuses invalid protected path selections',
  ({ paths }) => {
    expect(() => pinKernelMountTable(paths)).toThrow(/^kernel_mount_unverified$/);
  },
);
it('reads the current kernel table again on every assertion without retaining its private paths', () => {
  const read = vi.spyOn(fs, 'readSync'),
    current = pinKernelMountTable(),
    initial = read.mock.calls.length;
  current();
  current();
  expect(read.mock.calls.length).toBeGreaterThan(initial + 1);
});
it('refuses an altered mount table at the next assertion', () => {
  const current = pinKernelMountTable();
  vi.spyOn(fs, 'readSync').mockImplementation(((
    _fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => {
    if (position) return 0;
    return Buffer.from('CHANGED_PRIVATE_KERNEL_MOUNT').copy(buffer, offset, 0, length);
  }) as typeof fs.readSync);
  expect(() => current()).toThrow(/^kernel_mount_unverified$/);
});
it('refuses oversized kernel output and releases its descriptor', () => {
  const closed = vi.spyOn(fs, 'closeSync');
  vi.spyOn(fs, 'readSync').mockImplementation(((_fd: number, buffer: Buffer, offset: number, length: number) => {
    buffer.fill(0x41, offset, offset + length);
    return length;
  }) as typeof fs.readSync);
  expect(() => pinKernelMountTable()).toThrow(/^kernel_mount_unverified$/);
  expect(closed).toHaveBeenCalledOnce();
});
