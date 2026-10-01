import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { digest } from '../domain/contracts.js';
export type StorageInspection = (command: string, args: string[]) => string;
export type StorageProof = {
  contract: 'cos-encrypted-storage/v1';
  directoryDigest: string;
  mountDigest: string;
  filesystem: string;
  filesystemUuid: string;
  encryption: 'dm-crypt';
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const maximumOutput = 256 * 1024;
const inspectHost: StorageInspection = (command, args) =>
  execFileSync(command, args, {
    cwd: '/',
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: maximumOutput,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
function privateDirectory(directory: string) {
  const stat = fs.lstatSync(directory);
  if (
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory ||
    fs.realpathSync(directory) !== directory ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('unsafe_storage');
  for (let current = directory; ; current = path.dirname(current)) {
    if (fs.lstatSync(path.join(current, '.git'), { throwIfNoEntry: false })) throw new Error('repository_storage');
    if (path.dirname(current) === current) break;
  }
  return stat;
}
function decode(text: string): Record<string, unknown> {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maximumOutput) throw new Error('storage_inspection_bounds');
  const value: unknown = JSON.parse(text);
  if (!object(value)) throw new Error('storage_inspection_shape');
  return value;
}
/** Verify the actual mounted filesystem and its dm-crypt ancestry. File permissions alone are not encryption.
 * Production uses fixed read-only host tools with no inherited credentials. Injection is for offline tests only.
 */
export function verifyEncryptedCalendarDirectory(
  directory: string,
  inspect: StorageInspection = inspectHost,
): StorageProof {
  try {
    if (process.platform !== 'linux') throw new Error('unsupported_storage_platform');
    const before = privateDirectory(directory);
    const mounts = decode(
      inspect('/usr/bin/findmnt', ['--json', '--target', directory, '--output', 'TARGET,SOURCE,FSTYPE,MAJ:MIN,UUID']),
    );
    if (!Array.isArray(mounts.filesystems) || mounts.filesystems.length !== 1 || !object(mounts.filesystems[0]))
      throw new Error('ambiguous_storage_mount');
    const mount = mounts.filesystems[0];
    if (
      typeof mount.target !== 'string' ||
      !path.isAbsolute(mount.target) ||
      path.resolve(mount.target) !== mount.target ||
      (directory !== mount.target && !directory.startsWith(mount.target === '/' ? '/' : mount.target + '/')) ||
      typeof mount.fstype !== 'string' ||
      !['ext4', 'xfs', 'btrfs'].includes(mount.fstype) ||
      typeof mount['maj:min'] !== 'string' ||
      !/^\d{1,8}:\d{1,8}$/.test(mount['maj:min']) ||
      typeof mount.uuid !== 'string' ||
      !/^[a-zA-Z0-9-]{4,128}$/.test(mount.uuid)
    )
      throw new Error('unsupported_storage_mount');
    const devices = decode(inspect('/usr/bin/lsblk', ['--json', '--paths', '--output', 'NAME,TYPE,MAJ:MIN,UUID']));
    if (!Array.isArray(devices.blockdevices)) throw new Error('missing_storage_devices');
    let visited = 0;
    const matches: boolean[] = [];
    const members: boolean[] = [];
    const visit = (value: unknown, encrypted: boolean, depth: number) => {
      if (
        ++visited > 1024 ||
        depth > 32 ||
        !object(value) ||
        typeof value.type !== 'string' ||
        typeof value['maj:min'] !== 'string' ||
        !/^\d{1,8}:\d{1,8}$/.test(value['maj:min'])
      )
        throw new Error('storage_topology_bounds');
      const protectedPath = encrypted || value.type === 'crypt';
      if (value['maj:min'] === mount['maj:min']) matches.push(protectedPath && value.uuid === mount.uuid);
      if (value.uuid === mount.uuid) members.push(protectedPath);
      if (value.children !== undefined) {
        if (!Array.isArray(value.children)) throw new Error('storage_topology_shape');
        for (const child of value.children) visit(child, protectedPath, depth + 1);
      }
    };
    for (const device of devices.blockdevices) visit(device, false, 0);
    if (matches.length !== 1 || !matches[0] || !members.length || members.some((encrypted) => !encrypted))
      throw new Error('storage_encryption_unverified');
    const after = privateDirectory(directory);
    if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('storage_changed');
    return {
      contract: 'cos-encrypted-storage/v1',
      directoryDigest: digest(directory),
      mountDigest: digest(mount.target),
      filesystem: mount.fstype,
      filesystemUuid: mount.uuid,
      encryption: 'dm-crypt',
    };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Tool diagnostics can contain private paths; expose only this exact verification failure.
    throw new Error('calendar_storage_unverified');
  }
}
