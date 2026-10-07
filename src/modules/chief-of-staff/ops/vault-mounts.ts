import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest } from '../domain/contracts.js';
import { readPrivate, writeAtomic } from './target-state.js';
import type { VaultProvisionIdentity } from './vault-provision.js';
import { VAULT_DIRECTORIES, type VaultArea } from './vault-storage.js';
export type VaultMountPaths = { stateRoot: string; vaultRoot: string; calendarRoot: string };
export type VaultMountProof = {
  target: string;
  fstype: string;
  fsroot: string;
  'maj:min': string;
  uuid: string | null;
  options: string;
};
export type VaultMountControls = {
  assertAuthority(): Promise<void>;
  assertMemory(): void;
  assertFilesystem(): void;
  /** Supplied by the verified crypto adapter; the number is the mapped block device's rdev. */
  withMappedDevice<T>(operation: (fd: number, filesystemDevice: number) => T): T;
  inspect?(directory: string): VaultMountProof | null;
  run?(command: string, args: string[], descriptors: number[]): { status: number; output: string };
};
type Inode = { device: number; inode: number };
type Area = Inode & { phase: 'intent' | 'complete'; initialMode: number };
type Claim = {
  contract: 'cos-vault-mounts/v1';
  identityDigest: string;
  pathsDigest: string;
  owner: { uid: number; gid: number };
  underlays: Partial<Record<'vault' | 'calendar', Inode>>;
  areas: Record<string, Area>;
};
const filename = 'mounts.json';
function inode(stat: fs.Stats): Inode {
  return { device: stat.dev, inode: stat.ino };
}
function same(stat: fs.Stats, expected: Inode) {
  return stat.dev === expected.device && stat.ino === expected.inode;
}
function directory(file: string): fs.Stats {
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || fs.realpathSync(file) !== file) throw Error('unsafe_mount_directory');
  return stat;
}
function syncDirectory(file: string) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function inspectKernel(directory: string): VaultMountProof | null {
  const result = spawnSync(
    '/usr/bin/findmnt',
    ['--json', '--mountpoint', directory, '--output', 'TARGET,FSTYPE,FSROOT,MAJ:MIN,UUID,OPTIONS'],
    {
      cwd: '/',
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      maxBuffer: 262144,
    },
  );
  if (result.error || result.signal || result.status === null) throw Error('mount_inspection_unavailable');
  if (result.status === 1 && !result.stdout.trim()) return null;
  if (result.status !== 0) throw Error('mount_inspection_unavailable');
  const value = JSON.parse(result.stdout).filesystems;
  if (!Array.isArray(value) || value.length !== 1) throw Error('mount_inspection_ambiguous');
  return value[0];
}
/** Claims closed plaintext underlays before mounting, and never adopts or repairs foreign directories. */
export function createVaultMounts(
  paths: VaultMountPaths,
  identity: VaultProvisionIdentity,
  owner: { uid: number; gid: number },
  controls: VaultMountControls,
) {
  const safe = <T>(operation: () => T): T => {
    controls.assertMemory();
    const result = operation();
    controls.assertMemory();
    return result;
  };
  const guard = () => {
    for (const value of Object.values(paths))
      if (!path.isAbsolute(value) || path.resolve(value) !== value || value === '/' || /[\0\r\n]/.test(value))
        throw Error('unsafe_mount_path');
    const values = Object.values(paths);
    if (values.some((a, i) => values.some((b, j) => i !== j && (a === b || a.startsWith(b + '/')))))
      throw Error('overlapping_mount_paths');
    if (!Number.isSafeInteger(owner.uid) || owner.uid < 1 || !Number.isSafeInteger(owner.gid) || owner.gid < 1)
      throw Error('unsafe_mount_owner');
    const state = directory(paths.stateRoot),
      vaultParent = directory(path.dirname(paths.vaultRoot)),
      calendarParent = directory(path.dirname(paths.calendarRoot));
    if (
      state.uid !== process.getuid?.() ||
      (state.mode & 0o777) !== 0o700 ||
      vaultParent.uid !== process.getuid?.() ||
      vaultParent.mode & 0o022 ||
      calendarParent.uid !== owner.uid ||
      (calendarParent.mode & 0o777) !== 0o700
    )
      throw Error('unsafe_mount_parent');
    return state;
  };
  const read = (): Claim | null => {
    const stat = fs.lstatSync(path.join(paths.stateRoot, filename), { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile() || stat.nlink !== 1) throw Error('unsafe_mount_claim');
    const value = readPrivate<Claim>(path.join(paths.stateRoot, filename), 16384);
    const validInode = (entry: Inode) =>
      entry &&
      Number.isSafeInteger(entry.device) &&
      entry.device >= 0 &&
      Number.isSafeInteger(entry.inode) &&
      entry.inode > 0;
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'areas,contract,identityDigest,owner,pathsDigest,underlays' ||
      value.contract !== 'cos-vault-mounts/v1' ||
      value.identityDigest !== digest(identity) ||
      value.pathsDigest !== digest(paths) ||
      digest(value.owner) !== digest(owner) ||
      !value.underlays ||
      Array.isArray(value.underlays) ||
      !value.areas ||
      Array.isArray(value.areas) ||
      Object.entries(value.underlays).some(
        ([key, entry]) =>
          !['vault', 'calendar'].includes(key) ||
          !validInode(entry) ||
          Object.keys(entry).sort().join(',') !== 'device,inode',
      ) ||
      Object.entries(value.areas).some(
        ([key, entry]) =>
          !['@volume', ...VAULT_DIRECTORIES].includes(key) ||
          !validInode(entry) ||
          !['intent', 'complete'].includes(entry.phase) ||
          ![0o700, 0o755].includes(entry.initialMode) ||
          Object.keys(entry).sort().join(',') !== 'device,initialMode,inode,phase',
      )
    )
      throw Error('mount_claim_conflict');
    return value;
  };
  const persist = (record: Claim, state: Inode) => {
    if (!same(guard(), state)) throw Error('mount_control_changed');
    writeAtomic(paths.stateRoot, filename, record);
  };
  const proof = (file: string, fsroot: string, device: number) => {
    const value = (controls.inspect ?? inspectKernel)(file);
    if (!value) return null;
    const number = BigInt(device),
      major = ((number >> 8n) & 0xfffn) | ((number >> 32n) & 0xfffff000n),
      minor = (number & 0xffn) | ((number >> 12n) & 0xffffff00n);
    if (
      value.target !== file ||
      value.fstype !== 'ext4' ||
      value.fsroot !== fsroot ||
      value['maj:min'] !== `${major}:${minor}` ||
      (value.uuid != null && value.uuid !== identity.filesystemUuid) ||
      typeof value.options !== 'string' ||
      ['rw', 'nosuid', 'nodev', 'noexec'].some((option) => !value.options.split(',').includes(option))
    )
      throw Error('foreign_mount');
    if (directory(file).dev !== device) throw Error('mount_device_mismatch');
    return value;
  };
  const underlay = (key: 'vault' | 'calendar', record: Claim | null) => {
    const file = key === 'vault' ? paths.vaultRoot : paths.calendarRoot;
    const stat = fs.lstatSync(file, { throwIfNoEntry: false }),
      expected = record?.underlays[key];
    if (!stat && !expected) return null;
    if (
      !stat ||
      !expected ||
      !stat.isDirectory() ||
      fs.realpathSync(file) !== file ||
      !same(stat, expected) ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0 ||
      fs.readdirSync(file).length
    )
      throw Error('foreign_mount_underlay');
    return stat;
  };
  const checkArea = (key: string, record: Claim, device: number, complete = true) => {
    const file = key === '@volume' ? paths.vaultRoot : path.join(paths.vaultRoot, key),
      entry = record.areas[key],
      stat = directory(file);
    // A dm minor can change after a cold open. The verified filesystem UUID and its inode identify persistent areas.
    if (!entry || stat.ino !== entry.inode || stat.dev !== device || (complete && entry.phase !== 'complete'))
      throw Error('foreign_vault_directory');
    const owned = stat.uid === owner.uid && stat.gid === owner.gid && (stat.mode & 0o777) === 0o700;
    const initial = stat.uid === process.getuid?.() && (stat.mode & 0o777) === entry.initialMode;
    // Only an intent belonging to this inode permits finishing its original ownership transition.
    if (
      !owned &&
      (entry.phase !== 'intent' ||
        (!initial && !(stat.uid === owner.uid && stat.gid === owner.gid && (stat.mode & 0o777) === entry.initialMode)))
    )
      throw Error('vault_directory_permissions_changed');
    return stat;
  };
  const observe = (record: Claim | null, device: number): 'absent' | 'matching' => {
    controls.assertFilesystem();
    const vault = proof(paths.vaultRoot, '/', device),
      calendar = proof(paths.calendarRoot, '/google/calendar', device);
    if ((vault && !record?.underlays.vault) || (calendar && (!vault || !record?.underlays.calendar)))
      throw Error('unclaimed_mount');
    if (!vault) underlay('vault', record);
    if (!calendar) underlay('calendar', record);
    if (!vault) return 'absent';
    for (const [key] of Object.entries(record!.areas)) checkArea(key, record!, device, false);
    if (
      !calendar ||
      ['@volume', ...VAULT_DIRECTORIES].some((key) => !record!.areas[key] || record!.areas[key].phase !== 'complete')
    )
      return 'absent';
    for (const key of ['@volume', ...VAULT_DIRECTORIES]) checkArea(key, record!, device);
    const calendarStat = directory(paths.calendarRoot),
      source = directory(paths.vaultRoot + '/google/calendar');
    if (
      !same(calendarStat, inode(source)) ||
      calendarStat.uid !== owner.uid ||
      calendarStat.gid !== owner.gid ||
      (calendarStat.mode & 0o777) !== 0o700
    )
      throw Error('calendar_bind_changed');
    return 'matching';
  };
  const inspect = (): 'absent' | 'matching' | 'conflict' => {
    try {
      return safe(() => {
        guard();
        return controls.withMappedDevice((_fd, device) => observe(read(), device));
      });
      // eslint-disable-next-line no-catch-all/no-catch-all -- Fixed status excludes paths and root utility diagnostics.
    } catch {
      return 'conflict';
    }
  };
  const authority = async () => {
    controls.assertMemory();
    await controls.assertAuthority();
    controls.assertMemory();
    guard();
  };
  const run = (args: string[], descriptors: number[]) =>
    safe(() => {
      const result = (
        controls.run ??
        ((command, values, fds) => {
          const child = spawnSync(command, values, {
            cwd: '/',
            env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore', ...fds],
            timeout: 15000,
            maxBuffer: 262144,
          });
          if (child.error || child.signal || child.status === null) throw Error('mount_command_unavailable');
          return { status: child.status, output: child.stdout ?? '' };
        })
      )('/usr/bin/mount', args, descriptors);
      if (result.status !== 0 || typeof result.output !== 'string' || Buffer.byteLength(result.output) > 262144)
        throw Error('mount_command_failed');
    });
  return {
    inspect,
    withArea<T>(area: VaultArea, operation: (fd: number) => T): T {
      try {
        return safe(() => {
          guard();
          if (!VAULT_DIRECTORIES.includes(area)) throw Error('invalid_vault_area');
          return controls.withMappedDevice((_deviceFd, device) => {
            const record = read();
            if (!record || observe(record, device) !== 'matching') throw Error('vault_mount_unavailable');
            const before = checkArea(area, record, device),
              file = path.join(paths.vaultRoot, area);
            const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
            try {
              if (!same(fs.fstatSync(fd), inode(before))) throw Error('vault_area_changed');
              const result = operation(fd);
              if (result && typeof (result as { then?: unknown }).then === 'function')
                throw Error('synchronous_descriptor_operation_required');
              if (
                !same(fs.fstatSync(fd), inode(before)) ||
                observe(read(), device) !== 'matching' ||
                !same(checkArea(area, read()!, device), inode(before))
              )
                throw Error('vault_area_changed');
              return result;
            } finally {
              fs.closeSync(fd);
            }
          });
        });
      } catch {
        // eslint-disable-next-line preserve-caught-error -- Root effect paths and mount diagnostics cannot enter output.
        throw Error('vault_mounts_unavailable');
      }
    },
    async mount() {
      try {
        await authority();
        if (!controls.run && (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0))
          throw Error('root_process_required');
        const state = inode(guard());
        let record = read();
        controls.withMappedDevice((_fd, device) => observe(record, device));
        record ??= {
          contract: 'cos-vault-mounts/v1',
          identityDigest: digest(identity),
          pathsDigest: digest(paths),
          owner,
          underlays: {},
          areas: {},
        };
        for (const key of ['vault', 'calendar'] as const) {
          await authority();
          const file = key === 'vault' ? paths.vaultRoot : paths.calendarRoot;
          const mounted = controls.withMappedDevice((_fd, device) =>
            proof(file, key === 'vault' ? '/' : '/google/calendar', device),
          );
          if (mounted) {
            if (!record.underlays[key]) throw Error('unclaimed_mount');
            continue;
          }
          if (underlay(key, record)) continue;
          const parent = path.dirname(file),
            before = directory(parent),
            parentFd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
          try {
            if (!same(fs.fstatSync(parentFd), inode(before))) throw Error('mount_parent_changed');
            fs.mkdirSync(`/proc/self/fd/${parentFd}/${path.basename(file)}`, { mode: 0 });
            fs.fsyncSync(parentFd);
            const created = directory(file);
            record.underlays[key] = inode(created);
            persist(record, state);
            underlay(key, record);
          } finally {
            fs.closeSync(parentFd);
          }
        }
        await authority();
        controls.withMappedDevice((deviceFd, device) => {
          controls.assertFilesystem();
          if (proof(paths.vaultRoot, '/', device)) return;
          const before = underlay('vault', record)!;
          const targetFd = fs.openSync(
            paths.vaultRoot,
            fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
          );
          try {
            if (!same(fs.fstatSync(targetFd), inode(before))) throw Error('mount_underlay_changed');
            run(
              ['-t', 'ext4', '-o', 'nosuid,nodev,noexec', '/proc/self/fd/3', '/proc/self/fd/4'],
              [deviceFd, targetFd],
            );
            if (!proof(paths.vaultRoot, '/', device)) throw Error('vault_mount_missing');
          } finally {
            fs.closeSync(targetFd);
          }
        });
        for (const key of ['@volume', ...VAULT_DIRECTORIES]) {
          await authority();
          controls.withMappedDevice((_deviceFd, device) => {
            if (!proof(paths.vaultRoot, '/', device)) throw Error('vault_mount_missing');
            const file = key === '@volume' ? paths.vaultRoot : path.join(paths.vaultRoot, key);
            let entry = record!.areas[key];
            if (!entry) {
              if (key === '@volume') {
                const stat = directory(file);
                if (
                  stat.uid !== process.getuid?.() ||
                  (stat.mode & 0o777) !== 0o755 ||
                  stat.dev !== device ||
                  (!controls.run && stat.ino !== 2) ||
                  fs.readdirSync(file).join(',') !== 'lost+found'
                )
                  throw Error('foreign_vault_root');
                entry = { ...inode(stat), phase: 'intent', initialMode: 0o755 };
              } else {
                const parent = path.dirname(file),
                  parentKey = parent === paths.vaultRoot ? '@volume' : path.relative(paths.vaultRoot, parent);
                const before = checkArea(parentKey, record!, device),
                  fd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
                try {
                  if (!same(fs.fstatSync(fd), inode(before))) throw Error('encrypted_parent_changed');
                  fs.mkdirSync(`/proc/self/fd/${fd}/${path.basename(file)}`, { mode: 0o700 });
                  fs.fsyncSync(fd);
                  const stat = directory(file);
                  if (stat.dev !== device || !proof(paths.vaultRoot, '/', device))
                    throw Error('encrypted_directory_changed');
                  entry = { ...inode(stat), phase: 'intent', initialMode: 0o700 };
                } finally {
                  fs.closeSync(fd);
                }
              }
              record!.areas[key] = entry;
              persist(record!, state);
            }
            const before = checkArea(key, record!, device, false);
            if (entry.phase === 'complete') return;
            const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
            try {
              if (!same(fs.fstatSync(fd), inode(before))) throw Error('encrypted_directory_changed');
              fs.fchownSync(fd, owner.uid, owner.gid);
              fs.fchmodSync(fd, 0o700);
              fs.fsyncSync(fd);
              checkArea(key, record!, device, false);
              if (!proof(paths.vaultRoot, '/', device)) throw Error('vault_mount_lost');
              entry.phase = 'complete';
              persist(record!, state);
            } finally {
              fs.closeSync(fd);
            }
          });
        }
        await authority();
        controls.withMappedDevice((_deviceFd, device) => {
          if (!proof(paths.vaultRoot, '/', device)) throw Error('vault_mount_lost');
          if (proof(paths.calendarRoot, '/google/calendar', device)) return;
          const source = checkArea('google/calendar', record!, device),
            target = underlay('calendar', record)!;
          const sourceFd = fs.openSync(
            paths.vaultRoot + '/google/calendar',
            fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
          );
          const targetFd = fs.openSync(
            paths.calendarRoot,
            fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
          );
          try {
            if (!same(fs.fstatSync(sourceFd), inode(source)) || !same(fs.fstatSync(targetFd), inode(target)))
              throw Error('bind_directory_changed');
            run(['-o', 'bind,nosuid,nodev,noexec', '/proc/self/fd/3', '/proc/self/fd/4'], [sourceFd, targetFd]);
          } finally {
            fs.closeSync(sourceFd);
            fs.closeSync(targetFd);
          }
        });
        await authority();
        if (inspect() !== 'matching') throw Error('vault_mount_unverified');
        syncDirectory(paths.stateRoot);
      } catch {
        // eslint-disable-next-line preserve-caught-error -- Root mount diagnostics and owner proof failures remain private.
        throw Error('vault_mounts_unavailable');
      }
    },
  };
}
