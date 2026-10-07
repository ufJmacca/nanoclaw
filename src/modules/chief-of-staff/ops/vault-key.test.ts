import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createVaultKey, inspectVaultKey, type VaultKeyControls } from './vault-key.js';
import type { VaultProvisionIdentity } from './vault-provision.js';
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-key-'));
  temporary.push(root);
  const paths = { stateRoot: path.join(root, 'control'), bootKey: path.join(root, 'keys/vault.key') };
  fs.mkdirSync(paths.stateRoot, { mode: 0o700 });
  fs.mkdirSync(path.dirname(paths.bootKey), { mode: 0o700 });
  const identity: VaultProvisionIdentity = {
    operationId: randomUUID(),
    targetDigest: 'd'.repeat(64),
    recoveryReference: randomUUID(),
    luksUuid: randomUUID(),
    filesystemUuid: randomUUID(),
  };
  const controls: VaultKeyControls = { assertAuthority: vi.fn(async () => {}), assertMemory: vi.fn() };
  return { root, paths, identity, controls };
}
it('creates a private 64-byte boot key and preserves its inode and bytes on replay', async () => {
  const f = fixture();
  expect(inspectVaultKey(f.paths, f.identity)).toBe('absent');
  await createVaultKey(f.paths, f.identity, f.controls);
  const before = fs.statSync(f.paths.bootKey),
    bytes = fs.readFileSync(f.paths.bootKey);
  try {
    expect(before.size).toBe(64);
    expect(before.mode & 0o777).toBe(0o600);
    await createVaultKey(f.paths, f.identity, f.controls);
    expect(fs.statSync(f.paths.bootKey).ino).toBe(before.ino);
    expect(fs.readFileSync(f.paths.bootKey).equals(bytes)).toBe(true);
    expect(inspectVaultKey(f.paths, f.identity)).toBe('matching');
    const claim = JSON.parse(fs.readFileSync(path.join(f.paths.stateRoot, 'keys.json'), 'utf8'));
    expect(Object.keys(claim).sort()).toEqual(['contract', 'device', 'identityDigest', 'inode', 'pathDigest']);
  } finally {
    bytes.fill(0);
  }
});
it.each([
  'existing',
  'claim-loss',
  'identity',
  'permissions',
  'hardlink',
  'symlink',
  'truncated',
  'parent-permissions',
])('refuses %s and never overwrites or removes the key', async (reason) => {
  const f = fixture();
  if (reason === 'existing') fs.writeFileSync(f.paths.bootKey, 'PRIVATE_EXISTING', { mode: 0o600 });
  else {
    await createVaultKey(f.paths, f.identity, f.controls);
    if (reason === 'claim-loss') fs.unlinkSync(path.join(f.paths.stateRoot, 'keys.json'));
    if (reason === 'identity') f.identity.operationId = randomUUID();
    if (reason === 'permissions') fs.chmodSync(f.paths.bootKey, 0o644);
    if (reason === 'hardlink') fs.linkSync(f.paths.bootKey, path.join(f.root, 'other-key'));
    if (reason === 'symlink') {
      fs.renameSync(f.paths.bootKey, f.paths.bootKey + '.original');
      fs.symlinkSync(f.paths.bootKey + '.original', f.paths.bootKey);
    }
    if (reason === 'truncated') fs.truncateSync(f.paths.bootKey, 63);
    if (reason === 'parent-permissions') fs.chmodSync(path.dirname(f.paths.bootKey), 0o755);
  }
  expect(inspectVaultKey(f.paths, f.identity)).toBe('conflict');
  await expect(createVaultKey(f.paths, f.identity, f.controls)).rejects.toThrow('vault_key_unavailable');
  expect(fs.lstatSync(f.paths.bootKey)).toBeDefined();
  if (reason === 'existing') expect(fs.readFileSync(f.paths.bootKey, 'utf8')).toBe('PRIVATE_EXISTING');
});
it.each(['authority', 'memory'])('checks %s before writing any key or claim', async (reason) => {
  const f = fixture();
  if (reason === 'authority')
    f.controls.assertAuthority = async () => {
      throw Error('PRIVATE_AUTHORITY');
    };
  if (reason === 'memory')
    f.controls.assertMemory = () => {
      throw Error('PRIVATE_MEMORY');
    };
  await expect(createVaultKey(f.paths, f.identity, f.controls)).rejects.toThrow('vault_key_unavailable');
  expect(fs.readdirSync(path.dirname(f.paths.bootKey))).toEqual([]);
  expect(fs.readdirSync(f.paths.stateRoot)).toEqual([]);
});
it('does not adopt a key whose durable claim was interrupted by authority loss', async () => {
  const f = fixture();
  f.controls.assertAuthority = vi.fn(async () => {
    if (fs.existsSync(f.paths.bootKey)) throw Error('authority_lost');
  });
  await expect(createVaultKey(f.paths, f.identity, f.controls)).rejects.toThrow('vault_key_unavailable');
  expect(fs.statSync(f.paths.bootKey).size).toBe(64);
  expect(fs.readdirSync(f.paths.stateRoot)).toEqual([]);
  f.controls.assertAuthority = vi.fn(async () => {});
  await expect(createVaultKey(f.paths, f.identity, f.controls)).rejects.toThrow('vault_key_unavailable');
});
