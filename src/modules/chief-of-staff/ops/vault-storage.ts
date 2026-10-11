import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import {
  verifyEncryptedCalendarDirectory,
  type StorageInspection,
  type StorageProof,
} from '../calendar/storage-protection.js';
import { digest } from '../domain/contracts.js';
import { readPrivate, writeAtomic } from './target-state.js';
import { verifyVaultMemory } from './vault-memory.js';
import { pinKernelMountTable } from './kernel-mount-guard.js';
export const VAULT_DIRECTORIES = [
  'google',
  'google/calendar',
  'backup-credentials',
  'journals',
  'staging',
  'cache',
  'calendar-backups',
] as const;
export type VaultArea = (typeof VAULT_DIRECTORIES)[number];
export type VaultPolicy = {
  contract: 'cos-vault-storage/v1';
  targetDigest: string;
  vaultRoot: string;
  volume: StorageProof;
  directories: Record<VaultArea, StorageProof>;
  calendar: StorageProof;
};
const filename = 'vault-storage.json';
const inspection: StorageInspection = (command, args) =>
  execFileSync(command, args, {
    cwd: '/',
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 262144,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
function privateRoot(root: string) {
  const stat = fs.lstatSync(root);
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    fs.realpathSync(root) !== root ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('unsafe_vault_root');
  return stat;
}
function rootsGuard(roots: CalendarStorageRoots, vaultRoot: string) {
  privateRoot(roots.targetRoot);
  for (const root of [...Object.values(roots), vaultRoot])
    if (!path.isAbsolute(root) || path.resolve(root) !== root || /[\0\r\n]/.test(root) || root === '/')
      throw new Error('unsafe_vault_root');
  const overlap = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
  if (Object.values(roots).some((root) => overlap(root, vaultRoot))) throw new Error('vault_root_overlap');
}
function currentPolicy(roots: CalendarStorageRoots, vaultRoot: string, inspect: StorageInspection): VaultPolicy {
  rootsGuard(roots, vaultRoot);
  const volume = verifyEncryptedCalendarDirectory(vaultRoot, inspect);
  if (volume.filesystem !== 'ext4' || volume.mountDigest !== digest(vaultRoot)) throw new Error('vault_mount_mismatch');
  const directories = Object.fromEntries(
    VAULT_DIRECTORIES.map((area) => {
      const proof = verifyEncryptedCalendarDirectory(path.join(vaultRoot, area), inspect);
      if (
        proof.filesystemUuid !== volume.filesystemUuid ||
        proof.filesystem !== 'ext4' ||
        proof.mountDigest !== volume.mountDigest
      )
        throw new Error('vault_filesystem_mismatch');
      return [area, proof];
    }),
  ) as Record<VaultArea, StorageProof>;
  const calendarRoot = path.join(roots.targetRoot, 'calendar');
  const calendar = verifyEncryptedCalendarDirectory(calendarRoot, inspect);
  if (calendar.filesystemUuid !== volume.filesystemUuid || calendar.mountDigest !== digest(calendarRoot))
    throw new Error('vault_calendar_mismatch');
  const text = inspect('/usr/bin/findmnt', ['--json', '--mountpoint', calendarRoot, '--output', 'TARGET,FSROOT,UUID']);
  if (Buffer.byteLength(text) > 262144) throw new Error('vault_bind_bounds');
  const mounts = JSON.parse(text).filesystems;
  if (
    !Array.isArray(mounts) ||
    mounts.length !== 1 ||
    mounts[0].target !== calendarRoot ||
    mounts[0].fsroot !== '/google/calendar' ||
    (mounts[0].uuid != null && mounts[0].uuid !== volume.filesystemUuid)
  )
    throw new Error('vault_calendar_bind_missing');
  return {
    contract: 'cos-vault-storage/v1',
    targetDigest: digest(roots.targetRoot),
    vaultRoot,
    volume,
    directories,
    calendar,
  };
}
function existingPolicy(roots: CalendarStorageRoots): VaultPolicy {
  privateRoot(roots.targetRoot);
  const file = path.join(roots.targetRoot, filename),
    stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe_vault_policy');
  const value = readPrivate<VaultPolicy>(file, 16384);
  if (
    !value ||
    value.contract !== 'cos-vault-storage/v1' ||
    value.targetDigest !== digest(roots.targetRoot) ||
    typeof value.vaultRoot !== 'string' ||
    Object.keys(value).sort().join(',') !== 'calendar,contract,directories,targetDigest,vaultRoot,volume'
  )
    throw new Error('invalid_vault_policy');
  return value;
}
/** Trusted provisioning completion only. It records already-mounted storage; it creates no credential directory. */
export function configureVaultStorage(
  roots: CalendarStorageRoots,
  vaultRoot: string,
  inspect: StorageInspection = inspection,
): VaultPolicy {
  try {
    const current = currentPolicy(roots, vaultRoot, inspect);
    if (
      fs.lstatSync(path.join(roots.targetRoot, filename), { throwIfNoEntry: false }) &&
      digest(existingPolicy(roots)) !== digest(current)
    )
      throw new Error('vault_policy_conflict');
    if (digest(currentPolicy(roots, vaultRoot, inspect)) !== digest(current)) throw new Error('vault_changed');
    writeAtomic(roots.targetRoot, filename, current);
    return verifyVaultStorage(roots, inspect);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Never disclose credential/storage paths or inspection diagnostics.
    throw new Error('vault_storage_unavailable');
  }
}
/** Runtime inspection never repairs a missing mount, policy or directory. */
export function verifyVaultStorage(roots: CalendarStorageRoots, inspect: StorageInspection = inspection): VaultPolicy {
  try {
    const expected = existingPolicy(roots);
    if (digest(currentPolicy(roots, expected.vaultRoot, inspect)) !== digest(expected))
      throw new Error('vault_changed');
    return expected;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Fixed error is safe for owner status and model-independent diagnostics.
    throw new Error('vault_storage_unavailable');
  }
}
/** Credential callers use only this descriptor path during awaited reads/writes.
 * The guard freshly verifies kernel mount continuity, all admitted directory
 * identities, policy and memory protection without spawning tools per block.
 * Full encryption/topology inspection remains mandatory at entry and exit. */
export async function withVaultDirectory<T>(
  roots: CalendarStorageRoots,
  area: VaultArea,
  operation: (directory: string, assertCurrent: () => void) => Promise<T>,
  inspect: StorageInspection = inspection,
  memory: () => void = verifyVaultMemory,
): Promise<T> {
  let fd: number | undefined,
    active = false;
  try {
    if (!VAULT_DIRECTORIES.includes(area)) throw new Error('unknown_vault_area');
    roots = Object.freeze({ ...roots });
    memory();
    const assertKernel = pinKernelMountTable();
    const policy = verifyVaultStorage(roots, inspect),
      directory = path.join(policy.vaultRoot, area),
      before = privateRoot(directory);
    fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const pinned = fs.fstatSync(fd);
    if (pinned.dev !== before.dev || pinned.ino !== before.ino) throw new Error('vault_changed');
    const directories = [
      roots.targetRoot,
      policy.vaultRoot,
      ...VAULT_DIRECTORIES.map((area) => path.join(policy.vaultRoot, area)),
      path.join(roots.targetRoot, 'calendar'),
    ].map((file) => ({ file, stat: privateRoot(file) }));
    const policyDigest = digest(policy);
    active = true;
    const assertCurrent = () => {
      try {
        if (!active) throw Error('vault_scope_released');
        memory();
        assertKernel();
        if (digest(existingPolicy(roots)) !== policyDigest) throw Error('vault_policy_changed');
        for (const { file, stat } of directories) {
          const named = privateRoot(file);
          if (named.dev !== stat.dev || named.ino !== stat.ino) throw Error('vault_directory_changed');
        }
        const held = fs.fstatSync(fd!);
        if (
          !held.isDirectory() ||
          held.dev !== pinned.dev ||
          held.ino !== pinned.ino ||
          held.uid !== pinned.uid ||
          (held.mode & 0o7777) !== 0o700
        )
          throw Error('vault_directory_changed');
        assertKernel();
      } catch {
        // eslint-disable-next-line preserve-caught-error -- Streaming proofs include private policy paths and process diagnostics.
        throw Error('vault_storage_unavailable');
      }
    };
    assertCurrent();
    const result = await operation('/proc/self/fd/' + fd, assertCurrent);
    assertCurrent();
    const after = privateRoot(directory);
    if (
      after.dev !== pinned.dev ||
      after.ino !== pinned.ino ||
      digest(verifyVaultStorage(roots, inspect)) !== digest(policy)
    )
      throw new Error('vault_changed');
    memory();
    assertCurrent();
    return result;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Awaited credential operations may fail with secrets or private paths.
    throw new Error('vault_storage_unavailable');
  } finally {
    active = false;
    if (fd !== undefined) fs.closeSync(fd);
  }
}
export function vaultStorageStatus(
  roots: CalendarStorageRoots,
  inspect?: StorageInspection,
  memory: () => void = verifyVaultMemory,
): Record<string, unknown> {
  try {
    const policy = verifyVaultStorage(roots, inspect);
    memory();
    return {
      status: 'ready',
      encryption: 'dm-crypt',
      filesystem: 'ext4',
      memoryProtection: 'verified',
      googleCredentials: 'available',
      areas: VAULT_DIRECTORIES.length,
      policyDigest: digest(policy),
    };
    // eslint-disable-next-line no-catch-all/no-catch-all -- Status contains no private paths, account data or provider error bodies.
  } catch {
    return { status: 'unavailable', googleCredentials: 'unavailable', code: 'vault_storage_unavailable' };
  }
}
