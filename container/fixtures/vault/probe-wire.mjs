import assert from 'node:assert/strict';
import { readVaultRootRequest } from '/code/modules/chief-of-staff/ops/vault-root-wire.js';
import { checkVaultAuthority } from '/code/modules/chief-of-staff/ops/vault-authority.js';
import { createVaultCrypto } from '/code/modules/chief-of-staff/ops/vault-crypto.js';
import { verifyVaultMemory } from '/code/modules/chief-of-staff/ops/vault-memory.js';
let request;
try {
  assert.equal(process.getuid(), 0);
  assert.equal(process.arch, 'arm64');
  assert.equal(process.env.NANOCLAW_COS_VAULT_FIXTURE, '1');
  verifyVaultMemory();
  request = await readVaultRootRequest(process.stdin);
  assert.equal(request.header.configurationDigest, 'b'.repeat(64));
  assert.equal(request.header.scope.targetDigest, request.header.identity.targetDigest);
  await checkVaultAuthority(request.header.authority, request.header.scope, 1000);
  const crypto = createVaultCrypto(
    {
      stateRoot: '/case/control',
      volume: '/case/vault.luks',
      bootKey: '/case/keys/vault.key',
      mapper: 'cos-vault-wire-fixture',
    },
    request.header.identity,
    { assertMemory: verifyVaultMemory },
  );
  assert.equal(crypto.recoveryStatus(request.recovery), 'matching');
  console.log(
    '{"rootRecoveryWire":"passed","liveOwnerProof":"verified","realRecoverySlot":"verified","recoveryKeyOnDisk":false}',
  );
} catch {
  console.error('{"code":"vault_wire_fixture_unavailable"}');
  process.exitCode = 1;
} finally {
  request?.recovery.fill(0);
}
