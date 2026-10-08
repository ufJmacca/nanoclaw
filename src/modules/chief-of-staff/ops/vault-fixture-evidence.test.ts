import { expect, it } from 'vitest';
import { verifyVaultWireEvidence, verifyVaultFixtureImage } from './vault-fixture-evidence.js';
const source = 'a'.repeat(40),
  image = 'sha256:' + 'b'.repeat(64);
function evidence() {
  return [
    { vaultFixtureImage: image, sourceCommit: source, mode: 'kernel' },
    { rootOrchestration: 'passed', managerActivation: 'modeled', targetLeases: 'not_exercised' },
    { rootRecoveryWire: 'passed', liveOwnerProof: 'verified', realRecoverySlot: 'verified', recoveryKeyOnDisk: false },
    {
      kernelVault: 'passed',
      volumeBytes: 1073741824,
      bootKeyRemoved: true,
      recoveredCanary: true,
      wrongKeyDenied: true,
      mountRaceDenied: true,
      plaintextFallback: false,
      memoryProtection: 'verified',
      recoveryKeyOnDisk: false,
    },
  ];
}
it('accepts wire evidence only from the same successful immutable kernel fixture', () => {
  expect(() => verifyVaultWireEvidence(evidence(), source, image)).not.toThrow();
});
it.each(['source', 'image', 'missing-wire', 'disk-key', 'recovery', 'kernel', 'duplicate'])(
  'denies %s evidence instead of manufacturing a separate wire pass',
  (reason) => {
    const records = evidence();
    if (reason === 'source') Object.assign(records[0]!, { sourceCommit: 'c'.repeat(40) });
    if (reason === 'image') Object.assign(records[0]!, { vaultFixtureImage: 'sha256:' + 'd'.repeat(64) });
    if (reason === 'missing-wire') records.splice(2, 1);
    if (reason === 'disk-key') Object.assign(records[2]!, { recoveryKeyOnDisk: true });
    if (reason === 'recovery') Object.assign(records[2]!, { realRecoverySlot: 'not_exercised' });
    if (reason === 'kernel') Object.assign(records[3]!, { kernelVault: 'failed' });
    if (reason === 'duplicate') records.push(records[2]!);
    expect(() => verifyVaultWireEvidence(records, source, image)).toThrow('vault_wire_evidence_unavailable');
  },
);
function inspection() {
  return [
    {
      Id: image,
      Os: 'linux',
      Architecture: 'arm64',
      Config: {
        Labels: {
          'nanoclaw.release-role': 'vault-fixture',
          'org.opencontainers.image.revision': source,
          'nanoclaw.tested-host': 'sha256:' + 'c'.repeat(64),
        },
      },
    },
  ];
}
it('binds an immutable ARM64 vault fixture to its exact tested host and source', () => {
  expect(verifyVaultFixtureImage(inspection(), source, 'sha256:' + 'c'.repeat(64))).toBe(image);
});
it.each(['source', 'host', 'role', 'platform', 'architecture', 'image', 'duplicate'])(
  'denies a foreign %s fixture before recording any vault checks',
  (reason) => {
    const value = inspection();
    if (reason === 'source') value[0].Config.Labels['org.opencontainers.image.revision'] = 'd'.repeat(40);
    if (reason === 'host') value[0].Config.Labels['nanoclaw.tested-host'] = 'sha256:' + 'd'.repeat(64);
    if (reason === 'role') value[0].Config.Labels['nanoclaw.release-role'] = 'host';
    if (reason === 'platform') value[0].Os = 'darwin';
    if (reason === 'architecture') value[0].Architecture = 'amd64';
    if (reason === 'image') value[0].Id = 'mutable:latest';
    if (reason === 'duplicate') value.push(value[0]);
    expect(() => verifyVaultFixtureImage(value, source, 'sha256:' + 'c'.repeat(64))).toThrow(
      'vault_fixture_identity_mismatch',
    );
  },
);
