import fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { pinKernelMountTable } from './kernel-mount-guard.js';
afterEach(() => vi.restoreAllMocks());
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
