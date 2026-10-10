import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest } from '../domain/contracts.js';
import { verifySignedBackupMount } from './backup-policy.js';
import { backupNasRootConfiguration, type BackupNasRootConfiguration } from './backup-nas-root-config.js';
import {
  backupNasMountJournal,
  type BackupNasMountJournal,
  type BackupNasMountObservation,
} from './backup-nas-mount-state.js';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import { verifyVaultMemory } from './vault-memory.js';
const fixedMount = '/var/lib/nanoclaw-cos/nas';
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
/** Code-only kernel fixtures; no installed path, role or inspection selector. Null means a proven absent mount. */
export type BackupNasKernelControls = {
  mount?: string;
  inspect?(command: string, args: string[]): string | null;
  assertMemory?(): void;
};
function inspect(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, {
    cwd: '/',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 262144,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error || result.signal || result.status === null) throw Error('mount_inspection_failed');
  if (result.status === 1 && result.stdout.trim() === '') return null;
  if (result.status !== 0) throw Error('mount_inspection_failed');
  return result.stdout;
}
function mountId(fd: number): number {
  const read = fs.openSync('/proc/self/fdinfo/' + fd, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const buffer = Buffer.alloc(8193);
  try {
    const count = fs.readSync(read, buffer, 0, buffer.length, 0);
    if (count > 8192) throw Error('mount_id_bounds');
    const matches = [
      ...buffer
        .subarray(0, count)
        .toString('utf8')
        .matchAll(/^mnt_id:[\t ]+([0-9]+)[\t ]*$/gm),
    ];
    const id = Number(matches[0]?.[1]);
    if (matches.length !== 1 || !Number.isSafeInteger(id) || id < 1) throw Error('mount_id_missing');
    return id;
  } finally {
    buffer.fill(0);
    fs.closeSync(read);
  }
}
/** Inspect an actual mount instance or the original empty closed underlay. This does not
 * create, repair, read NAS payloads or grant authority. The caller holds root ownership
 * and fresh authority separately, and compares the returned instance with its journal.
 */
export function observeBackupNasMount(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  state: BackupNasMountJournal,
  controls: BackupNasKernelControls = {},
): BackupNasMountObservation {
  let parentFd: number | undefined, fd: number | undefined;
  try {
    const role = () => {
      (controls.assertMemory ?? verifyVaultMemory)();
      if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0)
        throw Error('root_required');
    };
    role();
    const vault = vaultRootConfiguration(input),
      nas = backupNasRootConfiguration(selected, vault);
    const canonical = Object.freeze({ host: nas.host, share: 'nanoclaw-cos-backups' as const, mount: fixedMount });
    const journal = backupNasMountJournal(state, {
      configurationDigest: digest(nas),
      bindingDigest: digest(canonical),
    });
    const mount = controls.mount ?? fixedMount,
      parent = path.dirname(mount);
    if (
      !path.isAbsolute(mount) ||
      path.resolve(mount) !== mount ||
      path.basename(mount) !== 'nas' ||
      parent === '/' ||
      fs.realpathSync(parent) !== parent
    )
      throw Error('unsafe_mount_parent');
    const before = fs.lstatSync(parent);
    parentFd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const heldParent = parentFd;
    const guard = () => {
      role();
      for (const stat of [fs.fstatSync(heldParent), fs.lstatSync(parent)])
        if (
          !stat.isDirectory() ||
          stat.uid !== 0 ||
          (stat.mode & 0o7777) !== 0o711 ||
          stat.dev !== before.dev ||
          stat.ino !== before.ino
        )
          throw Error('mount_parent_changed');
      if (fs.realpathSync(parent) !== parent) throw Error('mount_parent_changed');
    };
    guard();
    const actualBinding = Object.freeze({ ...canonical, mount });
    const kernel = () => {
      guard();
      const text = (controls.inspect ?? inspect)('/usr/bin/findmnt', [
        '--json',
        '--submounts',
        '--mountpoint',
        mount,
        '--output',
        'TARGET,SOURCE,FSTYPE,OPTIONS,ID',
      ]);
      guard();
      if (text === null) return null;
      verifySignedBackupMount(actualBinding, text);
      const value: unknown = JSON.parse(text);
      if (!object(value) || !Array.isArray(value.filesystems)) throw Error('invalid_kernel_mount');
      const entry = value.filesystems[0];
      if (
        !object(entry) ||
        !Number.isSafeInteger(entry.id) ||
        Number(entry.id) < 1 ||
        (entry.children !== undefined && (!Array.isArray(entry.children) || entry.children.length !== 0)) ||
        typeof entry.options !== 'string'
      )
        throw Error('nested_or_invalid_mount');
      const options = new Map(
        entry.options.split(',').map((option) => {
          const at = option.indexOf('=');
          return at < 0 ? [option, ''] : [option.slice(0, at), option.slice(at + 1)];
        }),
      );
      if (
        options.get('uid') !== String(vault.owner.uid) ||
        options.get('gid') !== String(vault.owner.gid) ||
        options.get('forceuid') !== '' ||
        options.get('forcegid') !== '' ||
        options.get('file_mode') !== '0600' ||
        options.get('dir_mode') !== '0700'
      )
        throw Error('mount_owner_options_unverified');
      return Object.freeze({ id: Number(entry.id), digest: digest(entry) });
    };
    const initial = kernel();
    const point = '/proc/self/fd/' + heldParent + '/nas';
    fd = fs.openSync(point, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const held = fd,
      original = fs.fstatSync(held);
    const current = () => {
      guard();
      for (const stat of [fs.fstatSync(held), fs.lstatSync(point)]) {
        if (
          !stat.isDirectory() ||
          stat.dev !== original.dev ||
          stat.ino !== original.ino ||
          stat.uid !== (initial ? vault.owner.uid : 0) ||
          (stat.mode & 0o7777) !== (initial ? 0o700 : 0)
        )
          throw Error('mount_directory_changed');
        if (
          initial
            ? stat.gid !== vault.owner.gid
            : stat.dev !== before.dev || digest({ device: stat.dev, inode: stat.ino }) !== digest(journal.underlay)
        )
          throw Error('mount_directory_scope_changed');
      }
      if (fs.realpathSync(mount) !== mount) throw Error('linked_mount');
      if (initial) {
        if (
          fs.statfsSync('/proc/self/fd/' + held, { bigint: true }).type !== 0xfe534d42n ||
          mountId(held) !== initial.id
        )
          throw Error('mount_filesystem_unverified');
      } else if (fs.readdirSync('/proc/self/fd/' + held).length) throw Error('underlay_not_empty');
    };
    current();
    const repeated = kernel();
    if (digest(repeated) !== digest(initial)) throw Error('kernel_mount_changed');
    current();
    return initial
      ? Object.freeze({
          state: 'mounted',
          mount: Object.freeze({
            id: initial.id,
            device: original.dev,
            inode: original.ino,
            bindingDigest: digest(canonical),
          }),
        })
      : Object.freeze({ state: 'closed', underlay: Object.freeze({ ...journal.underlay }) });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Kernel observations, private resource paths and owner diagnostics never enter status.
    throw Error('backup_nas_kernel_unverified');
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } finally {
      if (parentFd !== undefined) fs.closeSync(parentFd);
    }
  }
}
