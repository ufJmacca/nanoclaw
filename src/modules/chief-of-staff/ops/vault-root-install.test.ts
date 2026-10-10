import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import type { VaultRootArtifactSeal } from './vault-root-artifact.js';
import { installVaultRoot } from './vault-root-install.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    // Synthetic owned directories only; production installation never removes an artifact.
    const writable = (directory: string) => {
      fs.chmodSync(directory, 0o700);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        if (entry.isDirectory()) writable(path.join(directory, entry.name));
    };
    writable(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-install-'));
  roots.push(root);
  const sourceRoot = root + '/source';
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  const bytes = Buffer.from('synthetic sealed code\n'),
    seal: VaultRootArtifactSeal = {
      contract: 'cos-vault-root-artifact/v1',
      sourceCommit: 'c'.repeat(40),
      sourceTree: 'd'.repeat(40),
      runtime: { name: 'node', version: '22.23.2', architecture: 'arm64' },
      files: {
        'gateway.mjs': { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
        node: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      },
    };
  for (const name of ['gateway.mjs', 'node'])
    fs.writeFileSync(sourceRoot + '/' + name, bytes, { mode: name === 'node' ? 0o555 : 0o444 });
  fs.writeFileSync(sourceRoot + '/artifact.json', JSON.stringify(seal), { mode: 0o444 });
  fs.chmodSync(sourceRoot, 0o555);
  const binding = {
      hostFingerprint: 'a'.repeat(64),
      databaseFingerprint: 'b'.repeat(64),
      service: 'fixture.service',
      installationRoot: '/home/fixture/app',
      dataRoot: '/home/fixture/app/data',
    },
    configuration = vaultRootConfiguration({
      contract: 'cos-vault-root-config/v2',
      authority: { operationId: randomUUID() },
      identity: {
        operationId: randomUUID(),
        targetDigest: digest(binding),
        recoveryReference: randomUUID(),
        luksUuid: randomUUID(),
        filesystemUuid: randomUUID(),
      },
      target: { binding, lifecycle: 'protected', minimumGeneration: 1 },
      owner: {
        uid: process.getuid!(),
        gid: process.getgid!(),
        home: '/home/fixture',
        targetRoot: '/home/fixture/state',
      },
      artifact: { sourceCommit: seal.sourceCommit, sourceTree: seal.sourceTree, digest: digest(seal) },
    });
  const paths = { configRoot: root + '/config', artifactRoot: root + '/opt', vaultRoot: root + '/opt/vault' },
    controls = {
      paths,
      assertRole() {},
      assertMemory() {},
      assertAuthority: vi.fn(async () => {}),
      runtimeVersion: '22.23.2',
    };
  return {
    root,
    sourceRoot,
    configuration,
    seal,
    paths,
    controls,
    install: () => installVaultRoot({ sourceRoot, configuration }, controls),
  };
}
it('claims fixed installation parents, copies exact sealed bytes and replays without replacing inodes', async () => {
  const f = fixture(),
    result = await f.install();
  expect(result).toMatchObject({ status: 'installed', artifactDigest: f.configuration.artifact.digest });
  const artifact = f.paths.vaultRoot + '/' + f.configuration.artifact.digest,
    before = fs.statSync(artifact + '/node').ino;
  expect(fs.statSync(artifact).mode & 0o777).toBe(0o555);
  expect(fs.statSync(artifact + '/node').mode & 0o777).toBe(0o555);
  expect(fs.statSync(artifact + '/gateway.mjs').mode & 0o777).toBe(0o444);
  expect(JSON.parse(fs.readFileSync(f.paths.configRoot + '/vault-root.json', 'utf8'))).toEqual(f.configuration);
  expect(fs.statSync(f.paths.configRoot + '/vault-root.json').mode & 0o777).toBe(0o600);
  await f.install();
  expect(fs.statSync(artifact + '/node').ino).toBe(before);
  expect(f.controls.assertAuthority.mock.calls.length).toBeGreaterThan(4);
});
it('updates only the claimed configuration for a fresh operation and retains the installed artifact', async () => {
  const f = fixture();
  await f.install();
  const inode = fs.statSync(f.paths.vaultRoot + '/' + f.configuration.artifact.digest).ino;
  const next = vaultRootConfiguration({
    ...f.configuration,
    authority: { operationId: randomUUID() },
    target: { ...f.configuration.target, minimumGeneration: 2 },
  });
  await installVaultRoot({ sourceRoot: f.sourceRoot, configuration: next }, f.controls);
  expect(fs.statSync(f.paths.vaultRoot + '/' + f.configuration.artifact.digest).ino).toBe(inode);
  expect(JSON.parse(fs.readFileSync(f.paths.configRoot + '/vault-root.json', 'utf8'))).toEqual(next);
  await expect(f.install()).rejects.toThrow('vault_root_installation_unavailable');
});
it('keeps installation traversal permissions under the trusted private umask', async () => {
  const f = fixture(),
    previous = process.umask(0o077);
  try {
    await f.install();
  } finally {
    process.umask(previous);
  }
  expect(fs.statSync(f.paths.artifactRoot).mode & 0o777).toBe(0o755);
  expect(fs.statSync(f.paths.vaultRoot).mode & 0o777).toBe(0o755);
});
it('installs a new source artifact without replacing the retained sealed runtime', async () => {
  const f = fixture();
  await f.install();
  const old = f.paths.vaultRoot + '/' + f.configuration.artifact.digest,
    before = fs.statSync(old + '/node').ino;
  fs.chmodSync(f.sourceRoot + '/artifact.json', 0o600);
  const seal = { ...f.seal, sourceCommit: 'f'.repeat(40), sourceTree: '0'.repeat(40) };
  fs.writeFileSync(f.sourceRoot + '/artifact.json', JSON.stringify(seal));
  fs.chmodSync(f.sourceRoot + '/artifact.json', 0o444);
  const next = vaultRootConfiguration({
    ...f.configuration,
    authority: { operationId: randomUUID() },
    target: { ...f.configuration.target, minimumGeneration: 2 },
    artifact: { sourceCommit: seal.sourceCommit, sourceTree: seal.sourceTree, digest: digest(seal) },
  });
  await installVaultRoot({ sourceRoot: f.sourceRoot, configuration: next }, f.controls);
  expect(fs.statSync(old + '/node').ino).toBe(before);
  expect(fs.existsSync(f.paths.vaultRoot + '/' + next.artifact.digest + '/node')).toBe(true);
});
it('reconciles a lost atomic configuration reply only from its persisted installation intent', async () => {
  const f = fixture(),
    original = fs.renameSync;
  const renamed = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    original(from, to);
    if (to === f.paths.configRoot + '/vault-root.json') throw Error('PRIVATE_LOST_REPLY');
  });
  try {
    await expect(f.install()).rejects.toThrow('vault_root_installation_unavailable');
  } finally {
    renamed.mockRestore();
  }
  const inode = fs.statSync(f.paths.configRoot + '/vault-root.json').ino;
  await f.install();
  expect(fs.statSync(f.paths.configRoot + '/vault-root.json').ino).toBe(inode);
});
it.each(['config-parent', 'artifact-parent', 'parent-symlink', 'source-byte', 'source-link', 'authority', 'memory'])(
  'denies initial %s without changing foreign resources',
  async (reason) => {
    const f = fixture();
    if (reason === 'config-parent') fs.mkdirSync(f.paths.configRoot, { mode: 0o700 });
    if (reason === 'artifact-parent') fs.mkdirSync(f.paths.artifactRoot, { mode: 0o755 });
    if (reason === 'parent-symlink') fs.symlinkSync(f.root, f.paths.configRoot);
    if (reason === 'source-byte') {
      fs.chmodSync(f.sourceRoot + '/gateway.mjs', 0o600);
      fs.writeFileSync(f.sourceRoot + '/gateway.mjs', 'PRIVATE_FOREIGN_BYTES');
      fs.chmodSync(f.sourceRoot + '/gateway.mjs', 0o444);
    }
    if (reason === 'source-link') {
      fs.chmodSync(f.sourceRoot, 0o755);
      fs.renameSync(f.sourceRoot + '/node', f.sourceRoot + '/foreign');
      fs.symlinkSync('foreign', f.sourceRoot + '/node');
      fs.chmodSync(f.sourceRoot, 0o555);
    }
    if (reason === 'authority') f.controls.assertAuthority.mockRejectedValue(Error('PRIVATE_PROOF'));
    if (reason === 'memory')
      f.controls.assertMemory = () => {
        throw Error('PRIVATE_MEMORY');
      };
    await expect(f.install()).rejects.toThrow('vault_root_installation_unavailable');
    expect(fs.existsSync(f.paths.configRoot + '/vault-root.json')).toBe(false);
  },
);
it.each([
  'identity',
  'config-link',
  'config-replacement',
  'artifact-byte',
  'directory-replacement',
  'reused-operation',
])('denies replay after %s without repair or adoption', async (reason) => {
  const f = fixture();
  await f.install();
  let configuration = f.configuration;
  const file = f.paths.configRoot + '/vault-root.json',
    artifact = f.paths.vaultRoot + '/' + configuration.artifact.digest;
  if (reason === 'identity')
    configuration = vaultRootConfiguration({
      ...configuration,
      identity: { ...configuration.identity, operationId: randomUUID() },
    });
  if (reason === 'config-link') {
    fs.renameSync(file, file + '.owned');
    fs.symlinkSync(file + '.owned', file);
  }
  if (reason === 'config-replacement') {
    fs.renameSync(file, file + '.owned');
    fs.writeFileSync(file, JSON.stringify(configuration), { mode: 0o600 });
  }
  if (reason === 'artifact-byte') {
    fs.chmodSync(artifact + '/node', 0o600);
    fs.writeFileSync(artifact + '/node', 'PRIVATE_BYTES');
    fs.chmodSync(artifact + '/node', 0o555);
  }
  if (reason === 'directory-replacement') {
    fs.renameSync(f.paths.vaultRoot, f.paths.vaultRoot + '.owned');
    fs.mkdirSync(f.paths.vaultRoot, { mode: 0o755 });
  }
  if (reason === 'reused-operation')
    configuration = vaultRootConfiguration({
      ...configuration,
      target: { ...configuration.target, minimumGeneration: 2 },
    });
  await expect(installVaultRoot({ sourceRoot: f.sourceRoot, configuration }, f.controls)).rejects.toThrow(
    'vault_root_installation_unavailable',
  );
});
it('rechecks already claimed parent inodes after owner authority awaits', async () => {
  const f = fixture();
  await f.install();
  f.controls.assertAuthority.mockImplementationOnce(async () => {
    fs.renameSync(f.paths.artifactRoot, f.paths.artifactRoot + '.owned');
    fs.mkdirSync(f.paths.artifactRoot, { mode: 0o755 });
  });
  await expect(f.install()).rejects.toThrow('vault_root_installation_unavailable');
  expect(fs.readdirSync(f.paths.artifactRoot)).toEqual([]);
});
