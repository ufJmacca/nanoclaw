import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { backupNasRootConfiguration, readBackupNasRootConfiguration } from './backup-nas-root-config.js';
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-nas-config-'));
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    installationRoot: '/home/fixture/app',
    dataRoot: '/home/fixture/app/data',
  };
  const vault = vaultRootConfiguration({
    contract: 'cos-vault-root-config/v2',
    authority: { operationId: randomUUID() },
    identity: {
      operationId: randomUUID(),
      targetDigest: digest(binding),
      recoveryReference: randomUUID(),
      luksUuid: randomUUID(),
      filesystemUuid: randomUUID(),
    },
    target: { binding, lifecycle: 'protected', minimumGeneration: 3 },
    owner: { uid: 1000, gid: 1000, home: '/home/fixture', targetRoot: '/home/fixture/state' },
    artifact: { sourceCommit: 'c'.repeat(40), sourceTree: 'd'.repeat(40), digest: 'e'.repeat(64) },
  });
  const config = {
    contract: 'cos-backup-nas-root-config/v1',
    host: '192.168.56.12',
    credentialReference: randomUUID() as string,
    vaultStateDigest: vaultRootStateDigest(vault),
  };
  const file = path.join(root, 'backup-nas.json');
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const controls = { root, ownerUid: process.getuid?.(), assertMemory: vi.fn(), assertRole: vi.fn() };
  return { root, file, vault, config, controls };
}
it('selects only the dedicated private NAS and immutable vault/owner scope', () => {
  const s = fixture(),
    value = backupNasRootConfiguration(s.config, s.vault);
  expect(value).toEqual(s.config);
  expect(Object.isFrozen(value)).toBe(true);
  const updated = vaultRootConfiguration({
    ...s.vault,
    authority: { operationId: randomUUID() },
    target: { ...s.vault.target, minimumGeneration: 4 },
    artifact: { ...s.vault.artifact, digest: 'f'.repeat(64), sourceCommit: '0'.repeat(40) },
  });
  expect(backupNasRootConfiguration(s.config, updated)).toEqual(s.config);
});
it.each([
  'contract',
  'public-host',
  'host-injection',
  'reference',
  'scope',
  'owner',
  'vault',
  'share',
  'mount',
  'credentials',
  'command',
])('refuses configuration %s without alternate endpoints or credential sources', (reason) => {
  const s = fixture(),
    config = { ...s.config };
  let vault = s.vault;
  if (reason === 'contract') config.contract = 'foreign';
  if (reason === 'public-host') config.host = '8.8.8.8';
  if (reason === 'host-injection') config.host = '192.168.56.12\nOptions=guest';
  if (reason === 'reference') config.credentialReference = 'foreign';
  if (reason === 'scope') config.vaultStateDigest = 'f'.repeat(64);
  if (reason === 'owner')
    vault = vaultRootConfiguration({ ...vault, owner: { ...vault.owner, targetRoot: '/home/fixture/foreign' } });
  if (reason === 'vault')
    vault = vaultRootConfiguration({ ...vault, identity: { ...vault.identity, filesystemUuid: randomUUID() } });
  if (reason === 'share') Object.assign(config, { share: 'homes' });
  if (reason === 'mount') Object.assign(config, { mount: '/tmp/foreign' });
  if (reason === 'credentials') Object.assign(config, { password: 'PRIVATE_VALUE' });
  if (reason === 'command') Object.assign(config, { command: '/bin/sh' });
  expect(() => backupNasRootConfiguration(config, vault)).toThrow(/^backup_nas_configuration_unavailable$/);
});
it('reads only the held private configuration under current root and memory protections', () => {
  const s = fixture();
  expect(readBackupNasRootConfiguration(s.vault, s.controls)).toEqual(s.config);
  expect(s.controls.assertMemory.mock.calls.length).toBeGreaterThan(1);
  expect(s.controls.assertRole.mock.calls.length).toBeGreaterThan(1);
});
it.each([
  'missing',
  'symlink',
  'hardlink',
  'permissions',
  'parent',
  'oversized',
  'truncated',
  'memory',
  'role',
  'changed-file',
  'changed-parent',
])('refuses unsafe private configuration %s', (reason) => {
  const s = fixture();
  if (reason === 'missing') fs.unlinkSync(s.file);
  if (reason === 'symlink') {
    fs.renameSync(s.file, s.file + '.old');
    fs.symlinkSync(s.file + '.old', s.file);
  }
  if (reason === 'hardlink') fs.linkSync(s.file, s.file + '.other');
  if (reason === 'permissions') fs.chmodSync(s.file, 0o644);
  if (reason === 'parent') fs.chmodSync(s.root, 0o755);
  if (reason === 'oversized') fs.writeFileSync(s.file, Buffer.alloc(4097, 0x61));
  if (reason === 'truncated') fs.writeFileSync(s.file, '{');
  if (reason === 'memory')
    s.controls.assertMemory.mockImplementation(() => {
      throw Error('PRIVATE_MEMORY');
    });
  if (reason === 'role')
    s.controls.assertRole.mockImplementation(() => {
      throw Error('PRIVATE_ROLE');
    });
  if (reason === 'changed-file' || reason === 'changed-parent') {
    const read = fs.readSync;
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const result = read(...args);
      if (reason === 'changed-file') {
        fs.renameSync(s.file, s.file + '.old');
        fs.writeFileSync(s.file, JSON.stringify(s.config), { mode: 0o600 });
      } else {
        fs.renameSync(s.root, s.root + '.old');
        fs.mkdirSync(s.root, { mode: 0o700 });
        cleanups.push(() => fs.rmSync(s.root + '.old', { recursive: true, force: true }));
      }
      return result;
    }) as typeof fs.readSync);
  }
  expect(() => readBackupNasRootConfiguration(s.vault, s.controls)).toThrow(/^backup_nas_configuration_unavailable$/);
});
