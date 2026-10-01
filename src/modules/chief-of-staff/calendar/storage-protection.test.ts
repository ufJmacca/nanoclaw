import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { verifyEncryptedCalendarDirectory, type StorageInspection } from './storage-protection.js';
const roots: string[] = [];
const uuid = '11111111-2222-4333-8444-555555555555';
function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-calendar-storage-'));
  roots.push(directory);
  const device = { name: '/dev/mapper/private', type: 'crypt', 'maj:min': '253:0', uuid };
  const state = {
    mount: { filesystems: [{ target: directory, source: device.name, fstype: 'ext4', 'maj:min': '253:0', uuid }] },
    devices: { blockdevices: [{ name: '/dev/sda', type: 'disk', 'maj:min': '8:0', uuid: null, children: [device] }] },
  };
  const calls: Array<{ command: string; args: string[] }> = [];
  const inspect: StorageInspection = (command, args) => {
    calls.push({ command, args });
    return JSON.stringify(command.endsWith('/findmnt') ? state.mount : state.devices);
  };
  return { directory, device, state, calls, inspect };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('verifies the directory mount against a crypt block-device ancestry without returning host paths', () => {
  const f = setup();
  const proof = verifyEncryptedCalendarDirectory(f.directory, f.inspect);
  expect(proof).toMatchObject({
    contract: 'cos-encrypted-storage/v1',
    filesystem: 'ext4',
    filesystemUuid: uuid,
    encryption: 'dm-crypt',
  });
  expect(proof.directoryDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(proof)).not.toContain(f.directory);
  expect(JSON.stringify(proof)).not.toContain('/dev/');
  expect(f.calls.map((c) => c.command)).toEqual(['/usr/bin/findmnt', '/usr/bin/lsblk']);
  expect(f.calls[0].args).toContain(f.directory);
});
it('accepts an LVM filesystem under encryption, with a stable proof across kernel device renumbering', () => {
  const f = setup();
  const lvm = { name: '/dev/mapper/private-home', type: 'lvm', 'maj:min': '253:1', uuid };
  Object.assign(f.device, { uuid: null, children: [lvm] });
  Object.assign(f.state.mount.filesystems[0], { source: lvm.name, 'maj:min': '253:1' });
  const proof = verifyEncryptedCalendarDirectory(f.directory, f.inspect);
  lvm['maj:min'] = '253:7';
  f.state.mount.filesystems[0]['maj:min'] = '253:7';
  expect(verifyEncryptedCalendarDirectory(f.directory, f.inspect)).toEqual(proof);
});
it.each(['plain', 'unrelated-crypt', 'wrong-device', 'wrong-uuid', 'wrong-mount', 'duplicate-device'])(
  'rejects unsupported or contradictory encrypted-storage claims: %s',
  (reason) => {
    const f = setup();
    if (reason === 'plain') f.device.type = 'part';
    if (reason === 'unrelated-crypt') {
      f.device.type = 'part';
      f.state.devices.blockdevices.push({
        name: '/dev/mapper/other',
        type: 'crypt',
        'maj:min': '253:3',
        uuid: null,
        children: [],
      });
    }
    if (reason === 'wrong-device') f.state.mount.filesystems[0]['maj:min'] = '253:9';
    if (reason === 'wrong-uuid') f.state.mount.filesystems[0].uuid = 'different-filesystem';
    if (reason === 'wrong-mount') f.state.mount.filesystems[0].target = f.directory + '/elsewhere';
    if (reason === 'duplicate-device') f.state.devices.blockdevices[0].children.push({ ...f.device });
    expect(() => verifyEncryptedCalendarDirectory(f.directory, f.inspect)).toThrow('calendar_storage_unverified');
  },
);
it('rejects symlinks, exposed directories and Git storage before inspecting block devices', () => {
  const f = setup();
  fs.chmodSync(f.directory, 0o755);
  expect(() => verifyEncryptedCalendarDirectory(f.directory, f.inspect)).toThrow('calendar_storage_unverified');
  fs.chmodSync(f.directory, 0o700);
  fs.mkdirSync(path.join(f.directory, '.git'));
  expect(() => verifyEncryptedCalendarDirectory(f.directory, f.inspect)).toThrow('calendar_storage_unverified');
  fs.rmdirSync(path.join(f.directory, '.git'));
  const link = f.directory + '-link';
  fs.symlinkSync(f.directory, link);
  try {
    expect(() => verifyEncryptedCalendarDirectory(link, f.inspect)).toThrow('calendar_storage_unverified');
  } finally {
    fs.unlinkSync(link);
  }
  expect(f.calls).toEqual([]);
});
it('rejects a multi-device filesystem when another member with the same filesystem UUID is unencrypted', () => {
  const f = setup();
  f.state.mount.filesystems[0].fstype = 'btrfs';
  f.state.devices.blockdevices.push({
    name: '/dev/sdb',
    type: 'disk',
    'maj:min': '8:16',
    uuid: null,
    children: [{ name: '/dev/sdb1', type: 'part', 'maj:min': '8:17', uuid }],
  });
  expect(() => verifyEncryptedCalendarDirectory(f.directory, f.inspect)).toThrow('calendar_storage_unverified');
});
it('bounds and redacts command output and refuses a directory replaced during inspection', () => {
  const f = setup();
  for (const inspect of [
    () => {
      throw new Error('PRIVATE_COMMAND_CANARY');
    },
    () => 'not JSON PRIVATE_CANARY',
    () => 'x'.repeat(262145),
  ]) {
    try {
      verifyEncryptedCalendarDirectory(f.directory, inspect);
      throw new Error('unexpected success');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('calendar_storage_unverified');
      expect((error as Error).cause).toBeUndefined();
    }
  }
  const inspect: StorageInspection = (command, args) => {
    if (command.endsWith('/lsblk')) {
      fs.renameSync(f.directory, f.directory + '-old');
      roots.push(f.directory + '-old');
      fs.mkdirSync(f.directory, { mode: 0o700 });
    }
    return f.inspect(command, args);
  };
  expect(() => verifyEncryptedCalendarDirectory(f.directory, inspect)).toThrow('calendar_storage_unverified');
});
