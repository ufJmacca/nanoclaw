import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { verifyVaultRootArtifact, type VaultRootArtifactSeal } from './vault-root-artifact.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-artifact-'));
  roots.push(root);
  const bytes = Buffer.from('isolated fixture payload\n');
  const seal: VaultRootArtifactSeal = {
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
    fs.writeFileSync(path.join(root, name), bytes, { mode: name === 'node' ? 0o555 : 0o444 });
  const save = () => {
    const file = path.join(root, 'artifact.json');
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, JSON.stringify(seal), { mode: 0o444 });
    fs.chmodSync(file, 0o444);
  };
  save();
  fs.chmodSync(root, 0o555);
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    installationRoot: '/home/fixture/app',
    dataRoot: '/home/fixture/app/data',
  };
  const config = vaultRootConfiguration({
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
    owner: { uid: 1000, gid: 1000, home: '/home/fixture', targetRoot: '/home/fixture/state' },
    artifact: { sourceCommit: seal.sourceCommit, sourceTree: seal.sourceTree, digest: digest(seal) },
  });
  const controls = {
    root,
    ownerUid: process.getuid!(),
    executable: path.join(root, 'node'),
    entrypoint: path.join(root, 'gateway.mjs'),
    runtimeVersion: '22.23.2',
    assertRole() {},
    assertMemory() {},
  };
  return { root, config, controls, seal, save };
}
it('verifies every pinned payload byte and source identity before returning a frozen seal', () => {
  const f = fixture();
  const seal = verifyVaultRootArtifact(f.config, f.controls);
  expect(seal).toEqual(f.seal);
  expect(Object.isFrozen(seal.files.node)).toBe(true);
});
it.each([
  'gateway-byte',
  'runtime-byte',
  'manifest-byte',
  'source',
  'tree',
  'runtime-version',
  'executable',
  'entrypoint',
  'directory-write',
  'file-write',
  'symlink',
  'hardlink',
  'extra-file',
  'wrong-length',
])('denies %s before root effects can use the artifact', (reason) => {
  const f = fixture(),
    file = path.join(f.root, 'gateway.mjs');
  fs.chmodSync(f.root, 0o755);
  if (reason === 'gateway-byte' || reason === 'runtime-byte') {
    const changed = reason === 'runtime-byte' ? path.join(f.root, 'node') : file;
    fs.chmodSync(changed, 0o600);
    fs.writeFileSync(changed, 'PRIVATE_ARTIFACT_BYTES');
    fs.chmodSync(changed, reason === 'runtime-byte' ? 0o555 : 0o444);
  }
  if (reason === 'manifest-byte') {
    fs.chmodSync(path.join(f.root, 'artifact.json'), 0o600);
    fs.writeFileSync(path.join(f.root, 'artifact.json'), 'PRIVATE_MANIFEST');
    fs.chmodSync(path.join(f.root, 'artifact.json'), 0o444);
  }
  if (reason === 'source') {
    f.seal.sourceCommit = 'f'.repeat(40);
    f.save();
  }
  if (reason === 'tree') {
    f.seal.sourceTree = 'f'.repeat(40);
    f.save();
  }
  if (reason === 'runtime-version') f.controls.runtimeVersion = '24.0.0';
  if (reason === 'executable') f.controls.executable = '/usr/bin/node';
  if (reason === 'entrypoint') f.controls.entrypoint = '/tmp/foreign-gateway.mjs';
  if (reason === 'file-write') fs.chmodSync(file, 0o644);
  if (reason === 'symlink') {
    fs.renameSync(file, path.join(f.root, 'foreign'));
    fs.symlinkSync('foreign', file);
  }
  if (reason === 'hardlink') fs.linkSync(file, path.join(f.root, 'foreign'));
  if (reason === 'extra-file') fs.writeFileSync(path.join(f.root, 'private.env'), 'PRIVATE_ENV');
  if (reason === 'wrong-length') {
    f.seal.files.node.bytes++;
    f.save();
  }
  if (reason !== 'directory-write') fs.chmodSync(f.root, 0o555);
  expect(() => verifyVaultRootArtifact(f.config, f.controls)).toThrow('vault_root_artifact_unavailable');
});
it('checks actual memory and role before reading even a missing artifact', () => {
  const f = fixture(),
    calls: string[] = [];
  expect(() =>
    verifyVaultRootArtifact(f.config, {
      ...f.controls,
      root: '/missing',
      assertMemory() {
        calls.push('memory');
        throw Error('PRIVATE_MEMORY_DIAGNOSTIC');
      },
      assertRole() {
        calls.push('role');
      },
    }),
  ).toThrow('vault_root_artifact_unavailable');
  expect(calls).toEqual(['memory']);
});
