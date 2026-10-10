export type VaultAllocationPaths = { stateRoot: string; volume: string };
export type VaultAllocationControls = {
  assertAuthority(): Promise<void>;
  assertMemory(): void;
  availableBytes?(): number;
  allocate?(fd: number): void;
};
type Claim = {
  contract: 'cos-vault-allocation/v1';
  identityDigest: string;
  pathDigest: string;
  device: number;
  inode: number;
};
const claimName = 'allocation.json';
function directory(root: string, mode?: number) {
  const stat = fs.lstatSync(root);
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    fs.realpathSync(root) !== root ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (mode !== undefined && (stat.mode & 0o777) !== mode)
  )
    throw Error('unsafe_allocation_directory');
  return stat;
}
function pathsGuard(paths: VaultAllocationPaths) {
  const state = directory(paths.stateRoot, 0o700);
  directory(path.dirname(paths.volume));
  if (
    !path.isAbsolute(paths.volume) ||
    path.resolve(paths.volume) !== paths.volume ||
    path.basename(paths.volume) !== 'vault.luks' ||
    /[\0\r\n]/.test(paths.volume) ||
    paths.volume.startsWith(paths.stateRoot + '/')
  )
    throw Error('unsafe_volume_path');
  return state;
}
function claim(paths: VaultAllocationPaths, identity: VaultProvisionIdentity): Claim | null {
  const file = path.join(paths.stateRoot, claimName),
    stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.nlink !== 1) throw Error('unsafe_allocation_claim');
  const value = readPrivate<Claim>(file, 2048);
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'contract,device,identityDigest,inode,pathDigest' ||
    value.contract !== 'cos-vault-allocation/v1' ||
    value.identityDigest !== digest(identity) ||
    value.pathDigest !== digest(paths.volume) ||
    !Number.isSafeInteger(value.device) ||
    !Number.isSafeInteger(value.inode) ||
    value.device < 0 ||
    value.inode < 1
  )
    throw Error('allocation_claim_conflict');
  return value;
}
function fileGuard(stat: fs.Stats, expected: Claim) {
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.nlink !== 1 ||
    stat.dev !== expected.device ||
    stat.ino !== expected.inode ||
    !Number.isSafeInteger(stat.size) ||
    stat.size < 0 ||
    stat.size > VAULT_BYTES
  )
    throw Error('allocation_file_conflict');
}
function complete(stat: fs.Stats) {
  return stat.size === VAULT_BYTES && Number.isSafeInteger(stat.blocks) && stat.blocks * 512 >= VAULT_BYTES;
}
export function inspectVaultAllocation(
  paths: VaultAllocationPaths,
  identity: VaultProvisionIdentity,
): 'absent' | 'matching' | 'conflict' {
  try {
    pathsGuard(paths);
    const expected = claim(paths, identity),
      stat = fs.lstatSync(paths.volume, { throwIfNoEntry: false });
    if (!expected && !stat) return 'absent';
    if (!expected || !stat) return 'conflict';
    fileGuard(stat, expected);
    return complete(stat) ? 'matching' : 'absent';
    // eslint-disable-next-line no-catch-all/no-catch-all -- Inspection exposes no paths or private operation records.
  } catch {
    return 'conflict';
  }
}
/** Exclusive creation, then a durable inode claim, then real allocation. A lost claim never permits adoption. */
export async function allocateVaultFile(
  paths: VaultAllocationPaths,
  identity: VaultProvisionIdentity,
  controls: VaultAllocationControls,
): Promise<void> {
  let fd: number | undefined;
  try {
    const authority = async () => {
      controls.assertMemory();
      await controls.assertAuthority();
      controls.assertMemory();
    };
    await authority();
    const state = pathsGuard(paths);
    let expected = claim(paths, identity);
    const observed = fs.lstatSync(paths.volume, { throwIfNoEntry: false });
    if (!!observed !== !!expected) throw Error('allocation_claim_missing');
    if (observed) fileGuard(observed, expected!);
    const free =
      controls.availableBytes ??
      (() => {
        const facts = fs.statfsSync(path.dirname(paths.volume), { bigint: true });
        const bytes = facts.bavail * facts.bsize;
        if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('allocation_capacity_bounds');
        return Number(bytes);
      });
    const capacity = (reserve: number) => {
      const bytes = free();
      if (!Number.isSafeInteger(bytes) || bytes - reserve < VAULT_FREE_FLOOR)
        throw Error('allocation_capacity_insufficient');
    };
    capacity(observed && complete(observed) ? 0 : VAULT_BYTES);
    fd = fs.openSync(
      paths.volume,
      fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | (observed ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL),
      0o600,
    );
    if (!expected) {
      const created = fs.fstatSync(fd);
      expected = {
        contract: 'cos-vault-allocation/v1',
        identityDigest: digest(identity),
        pathDigest: digest(paths.volume),
        device: created.dev,
        inode: created.ino,
      };
      fileGuard(created, expected);
      fs.fsyncSync(fd);
      const parentFd = fs.openSync(
        path.dirname(paths.volume),
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
      try {
        fs.fsyncSync(parentFd);
      } finally {
        fs.closeSync(parentFd);
      }
      await authority();
      if (fs.lstatSync(path.join(paths.stateRoot, claimName), { throwIfNoEntry: false }))
        throw Error('allocation_claim_collision');
      const current = pathsGuard(paths);
      if (current.dev !== state.dev || current.ino !== state.ino) throw Error('allocation_directory_changed');
      writeAtomic(paths.stateRoot, claimName, expected);
    }
    fileGuard(fs.fstatSync(fd), expected);
    fileGuard(fs.lstatSync(paths.volume), expected);
    if (!complete(fs.fstatSync(fd))) {
      await authority();
      (
        controls.allocate ??
        ((pinned: number) => {
          const result = spawnSync('/usr/bin/fallocate', ['--length', String(VAULT_BYTES), '/proc/self/fd/3'], {
            cwd: '/',
            env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
            stdio: ['ignore', 'ignore', 'ignore', pinned],
            timeout: 120000,
          });
          if (result.error || result.status !== 0) throw Error('allocation_failed');
        })
      )(fd);
      fs.fsyncSync(fd);
    }
    await authority();
    capacity(0);
    fileGuard(fs.fstatSync(fd), expected);
    if (!complete(fs.fstatSync(fd)) || inspectVaultAllocation(paths, identity) !== 'matching')
      throw Error('allocation_unverified');
    const current = pathsGuard(paths);
    if (current.dev !== state.dev || current.ino !== state.ino) throw Error('allocation_directory_changed');
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Allocation failures may contain host paths or private lease diagnostics.
    throw Error('vault_allocation_unavailable');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
/** Only the exact fully allocated, operation-owned inode can be passed to a formatting utility. */
export function withVaultFile<T>(
  paths: VaultAllocationPaths,
  identity: VaultProvisionIdentity,
  operation: (fd: number) => T,
): T {
  let fd: number | undefined;
  try {
    const state = pathsGuard(paths),
      expected = claim(paths, identity);
    if (!expected || inspectVaultAllocation(paths, identity) !== 'matching') throw Error('allocation_unverified');
    fd = fs.openSync(paths.volume, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    fileGuard(fs.fstatSync(fd), expected);
    const result = operation(fd);
    if (result && typeof (result as { then?: unknown }).then === 'function')
      throw Error('synchronous_descriptor_operation_required');
    fileGuard(fs.fstatSync(fd), expected);
    if (inspectVaultAllocation(paths, identity) !== 'matching') throw Error('allocation_changed');
    const current = pathsGuard(paths);
    if (current.dev !== state.dev || current.ino !== state.ino) throw Error('allocation_directory_changed');
    return result;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Never disclose the utility's private diagnostics or volume paths.
    throw Error('vault_allocation_unavailable');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest } from '../domain/contracts.js';
import { readPrivate, writeAtomic } from './target-state.js';
import { VAULT_BYTES, VAULT_FREE_FLOOR } from './vault-admission.js';
import type { VaultProvisionIdentity } from './vault-provision.js';
