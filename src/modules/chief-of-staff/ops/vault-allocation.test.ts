import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { VAULT_BYTES, VAULT_FREE_FLOOR } from './vault-admission.js';
import {
  allocateVaultFile,
  inspectVaultAllocation,
  withVaultFile,
  type VaultAllocationControls,
} from './vault-allocation.js';
import type { VaultProvisionIdentity } from './vault-provision.js';
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-allocation-'));
  temporary.push(root);
  const paths = { stateRoot: path.join(root, 'control'), volume: path.join(root, 'vault.luks') };
  fs.mkdirSync(paths.stateRoot, { mode: 0o700 });
  const identity: VaultProvisionIdentity = {
    operationId: randomUUID(),
    targetDigest: 'b'.repeat(64),
    recoveryReference: randomUUID(),
    luksUuid: randomUUID(),
    filesystemUuid: randomUUID(),
  };
  const controls: VaultAllocationControls = {
    assertAuthority: vi.fn(async () => {}),
    assertMemory: vi.fn(),
    availableBytes: () => VAULT_BYTES + VAULT_FREE_FLOOR,
  };
  return { root, paths, identity, controls };
}
it('fully allocates exactly 1 GiB, pins the claimed inode and replays without changing existing contents', async () => {
  const f = fixture();
  expect(inspectVaultAllocation(f.paths, f.identity)).toBe('absent');
  await allocateVaultFile(f.paths, f.identity, f.controls);
  const before = fs.statSync(f.paths.volume);
  expect(before.size).toBe(VAULT_BYTES);
  expect(before.blocks * 512).toBeGreaterThanOrEqual(VAULT_BYTES);
  expect(before.mode & 0o777).toBe(0o600);
  withVaultFile(f.paths, f.identity, (fd) => fs.writeSync(fd, Buffer.from('SYNTHETIC_CANARY'), 0, 16, 0));
  await allocateVaultFile(f.paths, f.identity, f.controls);
  expect(inspectVaultAllocation(f.paths, f.identity)).toBe('matching');
  expect(fs.statSync(f.paths.volume).ino).toBe(before.ino);
  expect(
    withVaultFile(f.paths, f.identity, (fd) => {
      const bytes = Buffer.alloc(16);
      fs.readSync(fd, bytes, 0, 16, 0);
      return bytes.toString();
    }),
  ).toBe('SYNTHETIC_CANARY');
});
it('resumes an interrupted allocation only using its durable original inode claim', async () => {
  const f = fixture();
  f.controls.allocate = () => {
    throw Error('PRIVATE_INTERRUPTION');
  };
  await expect(allocateVaultFile(f.paths, f.identity, f.controls)).rejects.toThrow('vault_allocation_unavailable');
  const inode = fs.statSync(f.paths.volume).ino;
  expect(inspectVaultAllocation(f.paths, f.identity)).toBe('absent');
  delete f.controls.allocate;
  await allocateVaultFile(f.paths, f.identity, f.controls);
  expect(fs.statSync(f.paths.volume).ino).toBe(inode);
  expect(inspectVaultAllocation(f.paths, f.identity)).toBe('matching');
});
it.each(['existing', 'symlink', 'hardlink', 'claim-loss', 'identity', 'permissions', 'state-permissions'])(
  'refuses %s without adopting, deleting or overwriting another file',
  async (reason) => {
    const f = fixture();
    if (reason === 'existing') fs.writeFileSync(f.paths.volume, 'PRIVATE_EXISTING', { mode: 0o600 });
    if (reason === 'symlink') fs.symlinkSync('/dev/null', f.paths.volume);
    if (!['existing', 'symlink'].includes(reason)) {
      f.controls.allocate = () => {
        throw Error('stop_after_claim');
      };
      await expect(allocateVaultFile(f.paths, f.identity, f.controls)).rejects.toThrow('vault_allocation_unavailable');
      delete f.controls.allocate;
      if (reason === 'hardlink') fs.linkSync(f.paths.volume, path.join(f.root, 'unrelated'));
      if (reason === 'claim-loss') fs.unlinkSync(path.join(f.paths.stateRoot, 'allocation.json'));
      if (reason === 'identity') f.identity.operationId = randomUUID();
      if (reason === 'permissions') fs.chmodSync(f.paths.volume, 0o644);
      if (reason === 'state-permissions') fs.chmodSync(f.paths.stateRoot, 0o755);
    }
    expect(inspectVaultAllocation(f.paths, f.identity)).toBe('conflict');
    await expect(allocateVaultFile(f.paths, f.identity, f.controls)).rejects.toThrow('vault_allocation_unavailable');
    if (reason === 'existing') expect(fs.readFileSync(f.paths.volume, 'utf8')).toBe('PRIVATE_EXISTING');
    expect(fs.lstatSync(f.paths.volume)).toBeDefined();
  },
);
it('denies sparse allocation and capacity loss after reserving its file', async () => {
  const f = fixture();
  f.controls.allocate = (fd) => fs.ftruncateSync(fd, VAULT_BYTES);
  await expect(allocateVaultFile(f.paths, f.identity, f.controls)).rejects.toThrow('vault_allocation_unavailable');
  expect(inspectVaultAllocation(f.paths, f.identity)).toBe('absent');
  f.controls.availableBytes = () => VAULT_FREE_FLOOR - 1;
  await expect(allocateVaultFile(f.paths, f.identity, f.controls)).rejects.toThrow('vault_allocation_unavailable');
  expect(() => withVaultFile(f.paths, f.identity, () => {})).toThrow('vault_allocation_unavailable');
});
it.each(['authority', 'memory', 'capacity'])('refuses %s before creating any volume or claim', async (reason) => {
  const f = fixture();
  if (reason === 'authority')
    f.controls.assertAuthority = async () => {
      throw Error('PRIVATE_AUTHORITY');
    };
  if (reason === 'memory')
    f.controls.assertMemory = () => {
      throw Error('PRIVATE_MEMORY');
    };
  if (reason === 'capacity') f.controls.availableBytes = () => VAULT_BYTES + VAULT_FREE_FLOOR - 1;
  await expect(allocateVaultFile(f.paths, f.identity, f.controls)).rejects.toThrow('vault_allocation_unavailable');
  expect(fs.existsSync(f.paths.volume)).toBe(false);
  expect(fs.readdirSync(f.paths.stateRoot)).toEqual([]);
});
it('rejects replacement while an operation uses its pinned descriptor', async () => {
  const f = fixture();
  await allocateVaultFile(f.paths, f.identity, f.controls);
  expect(() =>
    withVaultFile(f.paths, f.identity, (fd) => {
      fs.renameSync(f.paths.volume, f.paths.volume + '.original');
      fs.writeFileSync(f.paths.volume, 'UNRELATED', { mode: 0o600 });
      fs.writeSync(fd, Buffer.from('SYNTHETIC'), 0, 9, 0);
    }),
  ).toThrow('vault_allocation_unavailable');
  expect(fs.readFileSync(f.paths.volume, 'utf8')).toBe('UNRELATED');
  expect(inspectVaultAllocation(f.paths, f.identity)).toBe('conflict');
});
