import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { initializeVaultRootState, vaultRootStateDigest } from './vault-root-state.js';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-root-state-'));
  roots.push(root);
  const configRoot = root + '/config',
    storageRoot = root + '/storage',
    stateRoot = configRoot + '/control';
  fs.mkdirSync(configRoot, { mode: 0o700 });
  const identityDigest = 'a'.repeat(64),
    paths = { configRoot, storageRoot, stateRoot };
  const controls = { assertRole() {}, assertMemory() {}, async assertAuthority() {} };
  return { root, paths, identityDigest, controls };
}
it('keeps resource ownership stable across reviewed-source upgrades and authority generation changes', () => {
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    installationRoot: '/home/fixture/app',
    dataRoot: '/home/fixture/app/data',
  };
  const config = vaultRootConfiguration({
    contract: 'cos-vault-root-config/v1',
    identity: {
      operationId: randomUUID(),
      targetDigest: digest(binding),
      recoveryReference: randomUUID(),
      luksUuid: randomUUID(),
      filesystemUuid: randomUUID(),
    },
    target: { binding, lifecycle: 'protected', minimumGeneration: 1 },
    owner: { uid: 1000, gid: 1000, home: '/home/fixture', targetRoot: '/home/fixture/state' },
    artifact: { sourceCommit: 'c'.repeat(40), sourceTree: 'd'.repeat(40), digest: 'e'.repeat(64) },
  });
  const upgraded = vaultRootConfiguration({
    ...config,
    artifact: { sourceCommit: 'f'.repeat(40), sourceTree: '0'.repeat(40), digest: '1'.repeat(64) },
    target: { ...config.target, minimumGeneration: 4 },
  });
  expect(digest(config)).not.toBe(digest(upgraded));
  expect(vaultRootStateDigest(config)).toBe(vaultRootStateDigest(upgraded));
  expect(vaultRootStateDigest({ ...config, identity: { ...config.identity, operationId: randomUUID() } })).not.toBe(
    vaultRootStateDigest(config),
  );
  expect(vaultRootStateDigest({ ...config, owner: { ...config.owner, targetRoot: '/home/fixture/foreign' } })).not.toBe(
    vaultRootStateDigest(config),
  );
});
it('exclusively claims root control and volume parents, persists inodes, and verifies replay', async () => {
  const f = fixture();
  await initializeVaultRootState(f.identityDigest, f.controls, f.paths);
  const record = JSON.parse(fs.readFileSync(f.paths.configRoot + '/vault-bootstrap.json', 'utf8'));
  expect(record.contract).toBe('cos-vault-root-state/v1');
  expect(record.identityDigest).toBe(f.identityDigest);
  expect(record.phase).toBe('complete');
  expect(fs.statSync(f.paths.stateRoot).mode & 0o777).toBe(0o700);
  expect(fs.statSync(f.paths.storageRoot).mode & 0o777).toBe(0o711);
  const inode = fs.statSync(f.paths.stateRoot).ino;
  await initializeVaultRootState(f.identityDigest, f.controls, f.paths);
  expect(fs.statSync(f.paths.stateRoot).ino).toBe(inode);
});
it.each(['storage', 'control', 'key', 'symlink'])(
  'refuses an existing unclaimed %s before creating programme roots',
  async (reason) => {
    const f = fixture();
    if (reason === 'storage') fs.mkdirSync(f.paths.storageRoot, { mode: 0o711 });
    if (reason === 'control') fs.mkdirSync(f.paths.stateRoot, { mode: 0o700 });
    if (reason === 'key') fs.writeFileSync(f.paths.configRoot + '/vault.key', 'PRIVATE_KEY');
    if (reason === 'symlink') fs.symlinkSync(f.root, f.paths.storageRoot);
    await expect(initializeVaultRootState(f.identityDigest, f.controls, f.paths)).rejects.toThrow(
      'vault_root_state_unavailable',
    );
    expect(fs.existsSync(f.paths.configRoot + '/vault-bootstrap.json')).toBe(false);
  },
);
it('denies a foreign configuration or changed claimed inode without repairing it', async () => {
  const f = fixture();
  await initializeVaultRootState(f.identityDigest, f.controls, f.paths);
  await expect(initializeVaultRootState('b'.repeat(64), f.controls, f.paths)).rejects.toThrow(
    'vault_root_state_unavailable',
  );
  fs.renameSync(f.paths.storageRoot, f.root + '/' + randomUUID());
  fs.mkdirSync(f.paths.storageRoot, { mode: 0o700 });
  await expect(initializeVaultRootState(f.identityDigest, f.controls, f.paths)).rejects.toThrow(
    'vault_root_state_unavailable',
  );
  expect(fs.statSync(f.paths.storageRoot).mode & 0o777).toBe(0o700);
});
it('reconciles only durably claimed directories after an interrupted authority check', async () => {
  const f = fixture();
  let calls = 0;
  f.controls.assertAuthority = async () => {
    if (++calls === 3) throw Error('PRIVATE_AUTHORITY');
  };
  await expect(initializeVaultRootState(f.identityDigest, f.controls, f.paths)).rejects.toThrow(
    'vault_root_state_unavailable',
  );
  f.controls.assertAuthority = async () => {};
  await initializeVaultRootState(f.identityDigest, f.controls, f.paths);
  expect(JSON.parse(fs.readFileSync(f.paths.configRoot + '/vault-bootstrap.json', 'utf8')).phase).toBe('complete');
});
it('refuses a root parent replaced during an authority await', async () => {
  const f = fixture();
  f.controls.assertAuthority = async () => {
    fs.renameSync(f.paths.configRoot, f.root + '/original');
    fs.mkdirSync(f.paths.configRoot, { mode: 0o700 });
  };
  await expect(initializeVaultRootState(f.identityDigest, f.controls, f.paths)).rejects.toThrow(
    'vault_root_state_unavailable',
  );
  expect(fs.readdirSync(f.paths.configRoot)).toEqual([]);
});
it('refuses an earlier claimed directory replaced during a later authority await', async () => {
  const f = fixture();
  let calls = 0;
  f.controls.assertAuthority = async () => {
    if (++calls === 3) {
      fs.renameSync(f.paths.stateRoot, f.paths.configRoot + '/original');
      fs.mkdirSync(f.paths.stateRoot, { mode: 0o700 });
    }
  };
  await expect(initializeVaultRootState(f.identityDigest, f.controls, f.paths)).rejects.toThrow(
    'vault_root_state_unavailable',
  );
  expect(fs.existsSync(f.paths.storageRoot)).toBe(false);
});
