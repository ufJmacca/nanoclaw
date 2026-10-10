import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { digest } from '/code/modules/chief-of-staff/domain/contracts.js';
import { readVaultRootConfiguration, fixedVaultRootPaths } from '/code/modules/chief-of-staff/ops/vault-root-config.js';
import { verifyVaultMemory } from '/code/modules/chief-of-staff/ops/vault-memory.js';
try {
  assert.equal(process.getuid(), 0);
  assert.equal(process.arch, 'arm64');
  assert.equal(process.env.NANOCLAW_COS_VAULT_FIXTURE, '1');
  verifyVaultMemory();
  const root = '/etc/nanoclaw-cos',
    file = root + '/vault-root.json';
  assert.equal(fs.existsSync(root), false);
  fs.mkdirSync(root, { mode: 0o700 });
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'nanoclaw-fixture.service',
    installationRoot: '/home/fixture/nanoclaw',
    dataRoot: '/home/fixture/nanoclaw/data',
  };
  const value = {
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
    owner: { uid: 1000, gid: 1000, home: '/home/fixture', targetRoot: '/home/fixture/.config/nanoclaw-cos/state' },
    artifact: { sourceCommit: 'c'.repeat(40), sourceTree: 'd'.repeat(40), digest: 'e'.repeat(64) },
  };
  fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  assert.deepEqual(readVaultRootConfiguration(), value);
  assert.equal(fixedVaultRootPaths(readVaultRootConfiguration()).volume, '/var/lib/nanoclaw-cos/vault.luks');
  fs.chmodSync(file, 0o644);
  assert.throws(() => readVaultRootConfiguration(), /vault_root_configuration_unavailable/);
  fs.chmodSync(file, 0o600);
  fs.renameSync(file, root + '/owned-original.json');
  fs.symlinkSync(root + '/owned-original.json', file);
  assert.throws(() => readVaultRootConfiguration(), /vault_root_configuration_unavailable/);
  fs.unlinkSync(file);
  fs.renameSync(root + '/owned-original.json', file);
  fs.chmodSync(root, 0o755);
  assert.throws(() => readVaultRootConfiguration(), /vault_root_configuration_unavailable/);
  fs.chmodSync(root, 0o700);
  assert.deepEqual(readVaultRootConfiguration(), value);
  console.log(
    '{"rootConfiguration":"passed","rootOwnership":"verified","fixedPaths":"verified","exposedConfigDenied":true,"symlinkDenied":true,"artifactIntegrity":"not_exercised"}',
  );
} catch {
  console.error('{"code":"vault_configuration_fixture_unavailable"}');
  process.exitCode = 1;
}
