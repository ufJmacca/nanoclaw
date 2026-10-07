import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { allocateVaultFile, withVaultFile } from './vault-allocation.js';
import { createVaultCrypto, type VaultCryptoControls } from './vault-crypto.js';
import type { VaultProvisionIdentity } from './vault-provision.js';
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-crypto-'));
  temporary.push(root);
  const keys = path.join(root, 'keys');
  fs.mkdirSync(keys, { mode: 0o700 });
  const paths = {
    stateRoot: path.join(root, 'control'),
    volume: path.join(root, 'vault.luks'),
    bootKey: path.join(keys, 'vault.key'),
    mapper: 'cos-vault-test',
  };
  fs.mkdirSync(paths.stateRoot, { mode: 0o700 });
  fs.writeFileSync(paths.bootKey, Buffer.alloc(64, 45), { mode: 0o600 });
  const identity: VaultProvisionIdentity = {
    operationId: randomUUID(),
    targetDigest: 'c'.repeat(64),
    recoveryReference: randomUUID(),
    luksUuid: randomUUID(),
    filesystemUuid: randomUUID(),
  };
  await allocateVaultFile(paths, identity, { assertAuthority: async () => {}, assertMemory: () => {} });
  let filesystem = false;
  let formatted = false,
    recovery: Buffer | null = null,
    mapped = false;
  const controls: VaultCryptoControls = {
    assertMemory: vi.fn(),
    mapping: () => (mapped ? 'matching' : 'absent'),
    run: vi.fn((command, args, volumeFd, keyFd, input) => {
      expect(fs.fstatSync(volumeFd).ino).toBe(fs.statSync(paths.volume).ino);
      if (command === '/usr/sbin/blkid')
        return { status: filesystem ? 0 : 2, output: filesystem ? `UUID=${identity.filesystemUuid}\nTYPE=ext4\n` : '' };
      if (command === '/usr/sbin/mkfs.ext4') {
        filesystem = true;
        return { status: 0, output: '' };
      }
      expect(command).toBe('/usr/sbin/cryptsetup');
      if (keyFd !== null) expect(fs.fstatSync(keyFd).ino).toBe(fs.statSync(paths.bootKey).ino);
      expect(args.join(' ')).not.toContain(Buffer.alloc(64, 45).toString());
      if (args[0] === 'isLuks') return { status: formatted ? 0 : 1, output: '' };
      if (args[0] === 'luksFormat') {
        formatted = true;
        return { status: 0, output: '' };
      }
      if (args[0] === 'luksUUID') return { status: 0, output: identity.luksUuid + '\n' };
      if (args[0] === 'luksDump')
        return {
          status: 0,
          output: JSON.stringify({ keyslots: recovery ? { '0': {}, '1': {} } : { '0': {} }, tokens: {} }),
        };
      if (args[0] === 'luksAddKey') {
        recovery = Buffer.from(input!);
        return { status: 0, output: '' };
      }
      if (args[0] === 'open' && args.includes('--test-passphrase'))
        return { status: args.includes('1') && !input?.equals(recovery ?? Buffer.alloc(0)) ? 2 : 0, output: '' };
      if (args[0] === 'open') {
        mapped = true;
        return { status: 0, output: '' };
      }
      if (args[0] === 'close') {
        mapped = false;
        return { status: 0, output: '' };
      }
      throw Error('unexpected_fixture_command');
    }),
  };
  controls.withMappedDevice = (operation) => withVaultFile(paths, identity, operation);
  return {
    root,
    paths,
    identity,
    controls,
    crypto: createVaultCrypto(paths, identity, controls),
    setFormatted() {
      formatted = true;
    },
    setRecovery(key: Buffer) {
      recovery = key;
    },
  };
}
it('formats only its claimed descriptor, verifies the exact LUKS UUID and does not replay a successful format', async () => {
  const f = await fixture();
  expect(f.crypto.inspect()).toBe('absent');
  f.crypto.format();
  expect(f.crypto.inspect()).toBe('matching');
  expect(() => f.crypto.format()).toThrow('vault_crypto_unavailable');
  expect(vi.mocked(f.controls.run!).mock.calls.filter((c) => c[1][0] === 'luksFormat')).toHaveLength(1);
});
it('adds an independent recovery slot through private input, verifies it and reconciles an already-added slot', async () => {
  const f = await fixture(),
    key = Buffer.alloc(64, 123);
  f.setFormatted();
  expect(f.crypto.recoveryStatus(key)).toBe('absent');
  f.crypto.addRecovery(key);
  f.crypto.addRecovery(key);
  expect(f.crypto.recoveryStatus(key)).toBe('matching');
  const calls = vi.mocked(f.controls.run!).mock.calls.filter((c) => c[1][0] === 'luksAddKey');
  expect(calls).toHaveLength(1);
  expect(calls[0][1]).toContain('-');
  expect(calls[0][4]).toEqual(key);
  expect(calls[0][1].join(' ')).not.toContain(key.toString());
  expect(fs.readdirSync(path.dirname(f.paths.bootKey))).toEqual(['vault.key']);
});
it('refuses an occupied recovery slot with another key without overwriting it', async () => {
  const f = await fixture();
  f.setFormatted();
  f.setRecovery(Buffer.alloc(64, 77));
  expect(f.crypto.recoveryStatus(Buffer.alloc(64, 78))).toBe('conflict');
  expect(() => f.crypto.addRecovery(Buffer.alloc(64, 78))).toThrow('vault_crypto_unavailable');
  expect(vi.mocked(f.controls.run!).mock.calls.some((c) => c[1][0] === 'luksAddKey')).toBe(false);
});
it('opens and closes only its verified mapping and supports the independent recovery input', async () => {
  const f = await fixture(),
    key = Buffer.alloc(64, 81);
  f.setFormatted();
  f.setRecovery(key);
  f.crypto.open();
  f.crypto.open();
  f.crypto.close();
  f.crypto.open(key);
  f.crypto.close();
  const calls = vi
    .mocked(f.controls.run!)
    .mock.calls.filter((c) => c[1][0] === 'open' && !c[1].includes('--test-passphrase'));
  expect(calls).toHaveLength(2);
  expect(calls[0][4]).toBeUndefined();
  expect(calls[1][4]).toEqual(key);
  f.controls.mapping = () => 'conflict';
  expect(() => f.crypto.close()).toThrow('vault_crypto_unavailable');
});
it('formats only a proven empty mapper descriptor and verifies the predetermined ext4 UUID without replay', async () => {
  const f = await fixture();
  f.setFormatted();
  f.crypto.open();
  expect(f.crypto.filesystemStatus()).toBe('absent');
  f.crypto.formatFilesystem();
  expect(f.crypto.filesystemStatus()).toBe('matching');
  expect(() => f.crypto.formatFilesystem()).toThrow('vault_crypto_unavailable');
  const calls = vi.mocked(f.controls.run!).mock.calls.filter((c) => c[0] === '/usr/sbin/mkfs.ext4');
  expect(calls).toHaveLength(1);
  expect(calls[0][1]).toEqual(['-q', '-U', f.identity.filesystemUuid, '/proc/self/fd/3']);
});
it.each(['uuid', 'filesystem', 'ambiguous', 'mapping'])(
  'refuses %s conflict before formatting a filesystem',
  async (reason) => {
    const f = await fixture();
    f.setFormatted();
    f.crypto.open();
    const run = f.controls.run!;
    if (reason === 'mapping') f.controls.mapping = () => 'conflict';
    else
      f.controls.run = (command, args, ...rest) =>
        command === '/usr/sbin/blkid'
          ? {
              status: 0,
              output: `TYPE=${reason === 'filesystem' ? 'xfs' : 'ext4'}\nUUID=${reason === 'uuid' ? randomUUID() : f.identity.filesystemUuid}\n${reason === 'ambiguous' ? 'UUID=' + randomUUID() + '\n' : ''}`,
            }
          : run(command, args, ...rest);
    expect(f.crypto.filesystemStatus()).toBe('conflict');
    expect(() => f.crypto.formatFilesystem()).toThrow('vault_crypto_unavailable');
    expect(vi.mocked(run).mock.calls.some((c) => c[0] === '/usr/sbin/mkfs.ext4')).toBe(false);
  },
);
it.each([
  'memory',
  'key-permissions',
  'key-symlink',
  'key-hardlink',
  'key-length',
  'uuid',
  'unexpected-slot',
  'utility-error',
  'volume-replaced',
])('fails closed on %s without leaking utility diagnostics', async (reason) => {
  const f = await fixture();
  f.setFormatted();
  if (reason === 'memory')
    f.controls.assertMemory = () => {
      throw Error('PRIVATE_MEMORY');
    };
  if (reason === 'key-permissions') fs.chmodSync(f.paths.bootKey, 0o644);
  if (reason === 'key-symlink') {
    fs.renameSync(f.paths.bootKey, f.paths.bootKey + '.original');
    fs.symlinkSync(f.paths.bootKey + '.original', f.paths.bootKey);
  }
  if (reason === 'key-hardlink') fs.linkSync(f.paths.bootKey, f.paths.bootKey + '.extra');
  if (reason === 'key-length') fs.truncateSync(f.paths.bootKey, 63);
  if (reason === 'volume-replaced') {
    fs.renameSync(f.paths.volume, f.paths.volume + '.original');
    fs.writeFileSync(f.paths.volume, 'PRIVATE_EXISTING', { mode: 0o600 });
  }
  if (['uuid', 'unexpected-slot', 'utility-error'].includes(reason)) {
    const run = f.controls.run!;
    f.controls.run = (command, args, ...rest) => {
      if (reason === 'uuid' && args[0] === 'luksUUID') return { status: 0, output: randomUUID() };
      if (reason === 'unexpected-slot' && args[0] === 'luksDump')
        return { status: 0, output: JSON.stringify({ keyslots: { '0': {}, '9': {} }, tokens: {} }) };
      if (reason === 'utility-error') throw Error('PRIVATE_UTILITY');
      return run(command, args, ...rest);
    };
  }
  expect(f.crypto.inspect()).toBe('conflict');
  expect(() => f.crypto.addRecovery(Buffer.alloc(64, 99))).toThrow('vault_crypto_unavailable');
});
