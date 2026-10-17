import { expect, it } from 'vitest';
import { verifyMailVaultFixtureEvidence } from './mail-vault-fixture-evidence.js';
import { verifyMailReleaseEvidence } from './mail-artifact-fixture-evidence.js';
const identity = { sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), fixtureImage: 'sha256:' + 'c'.repeat(64) };
function records(): Record<string, unknown>[] {
  return [
    { vaultFixtureImage: identity.fixtureImage, sourceCommit: identity.sourceCommit, mode: 'mail-credentials-kernel' },
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
      keychainRecovery: 'verified',
    },
    {
      contract: 'cos-g04-mail-vault-fixture/v1',
      sourceCommit: identity.sourceCommit,
      sourceTree: identity.sourceTree,
      compiledProductionPayload: true,
      actualKernelVault: true,
      actualMemoryProtection: true,
      storageOverrides: false,
      memoryOverrides: false,
      journalOverrides: false,
      ownerCredentialsUsed: false,
      oauthTransport: 'fixture',
      setupAuthority: 'fixture',
      liveAccountAcceptance: false,
      installedAcceptance: false,
    },
    {
      mailVaultStage: 'install',
      separateClient: true,
      retryPreserved: true,
      credentialGeneration: 2,
      actualEncryptedJournal: true,
      journalEvents: 3,
      deniedCrossAccount: true,
      denialPreserved: true,
    },
    { mailVaultStage: 'directory_races', deniedCases: 7, replacementWrites: 0 },
    {
      mailVaultStage: 'mount_loss',
      heldHostDenied: true,
      tokenDenied: true,
      denialWriteDenied: true,
      journalDenied: true,
      setupDenied: true,
      closeSettled: true,
    },
    { mailVaultStage: 'recovered', credentialsPreserved: true, denialPreserved: true, journalPreserved: true },
    { mailVaultStage: 'unavailable', openDenied: true, setupDenied: true, plaintextWrites: 0 },
    {
      mailVaultStage: 'unrelated_worker_mount',
      actualKernelChange: true,
      sameHeldMailHost: true,
      credentialsUsableMountedAndUnmounted: true,
      ownerCredentialsUsed: false,
    },
  ];
}
const report = (values = records()) => values.map((value) => JSON.stringify(value)).join('\n') + '\n';
it('requires the complete source-bound actual encrypted Mail credential run', () => {
  expect(verifyMailVaultFixtureEvidence(report(), identity)).toEqual({
    credentialGeneration: 2,
    journalEvents: 3,
    deniedDirectoryCases: 7,
  });
});
const releaseIdentity = () => ({
  ...identity,
  hostImage: 'sha256:' + 'd'.repeat(64),
  fixtureInspection: [
    {
      Id: identity.fixtureImage,
      Os: 'linux',
      Architecture: 'arm64',
      Config: {
        Labels: {
          'nanoclaw.release-role': 'vault-fixture',
          'org.opencontainers.image.revision': identity.sourceCommit,
          'nanoclaw.tested-host': 'sha256:' + 'd'.repeat(64),
        },
      },
    },
  ],
});
it('routes the credential release gate through its actual host-bound kernel consumer', () => {
  expect(verifyMailReleaseEvidence('mail_credentials', report(), releaseIdentity())).toEqual({
    credentialGeneration: 2,
    journalEvents: 3,
    deniedDirectoryCases: 7,
  });
  expect(() => verifyMailReleaseEvidence('mail_recovery', report(), releaseIdentity())).toThrow(
    'mail_recovery_evidence_unavailable',
  );
  for (const gate of ['mail_capture', 'mail_evidence', 'mail_retention'])
    expect(() => verifyMailReleaseEvidence(gate, report(), releaseIdentity())).toThrow(
      'mail_release_check_unavailable',
    );
});
it.each(['image', 'source', 'host', 'role', 'platform', 'architecture', 'duplicate'])(
  'refuses the %s fixture mismatch before recording credential release success',
  (reason) => {
    const expected = releaseIdentity(),
      inspection = expected.fixtureInspection[0];
    if (reason === 'image') inspection.Id = 'sha256:' + 'e'.repeat(64);
    if (reason === 'source') inspection.Config.Labels['org.opencontainers.image.revision'] = 'e'.repeat(40);
    if (reason === 'host') inspection.Config.Labels['nanoclaw.tested-host'] = 'sha256:' + 'e'.repeat(64);
    if (reason === 'role') inspection.Config.Labels['nanoclaw.release-role'] = 'host';
    if (reason === 'platform') inspection.Os = 'darwin';
    if (reason === 'architecture') inspection.Architecture = 'amd64';
    if (reason === 'duplicate') expected.fixtureInspection.push(inspection);
    expect(() => verifyMailReleaseEvidence('mail_credentials', report(), expected)).toThrow(
      'vault_fixture_identity_mismatch',
    );
  },
);
it.each(['sourceCommit', 'sourceTree', 'fixtureImage'] as const)('refuses a foreign %s', (field) => {
  expect(() =>
    verifyMailVaultFixtureEvidence(report(), {
      ...identity,
      [field]: field === 'fixtureImage' ? 'sha256:' + 'd'.repeat(64) : 'd'.repeat(40),
    }),
  ).toThrow('mail_vault_evidence_unavailable');
});
it.each(records().map((_, index) => index))('refuses missing or duplicate required record %i', (index) => {
  const missing = records();
  missing.splice(index, 1);
  expect(() => verifyMailVaultFixtureEvidence(report(missing), identity)).toThrow();
  const duplicate = records();
  duplicate.push(duplicate[index]);
  expect(() => verifyMailVaultFixtureEvidence(report(duplicate), identity)).toThrow();
});
it.each(['actualKernelChange', 'sameHeldMailHost', 'credentialsUsableMountedAndUnmounted', 'ownerCredentialsUsed'])(
  'refuses an unverified unrelated worker mount %s claim',
  (key) => {
    const changed = records(),
      proof = changed.find((record) => record.mailVaultStage === 'unrelated_worker_mount')!;
    proof[key] = !proof[key];
    expect(() => verifyMailVaultFixtureEvidence(report(changed), identity)).toThrow('mail_vault_evidence_unavailable');
  },
);
it.each(records().flatMap((record, index) => Object.keys(record).map((key) => ({ index, key }))))(
  'refuses altered $index/$key evidence',
  ({ index, key }) => {
    const altered = records();
    altered[index][key] = 'not_verified';
    expect(() => verifyMailVaultFixtureEvidence(report(altered), identity)).toThrow('mail_vault_evidence_unavailable');
  },
);
it.each([
  '',
  '{broken}\n',
  report() + 'non-json\n',
  report() + '{"code":"fixture_failed"}\n',
  ' '.repeat(2 * 1024 ** 2 + 1),
])('refuses malformed, failed or oversized reports', (text) => {
  expect(() => verifyMailVaultFixtureEvidence(text, identity)).toThrow('mail_vault_evidence_unavailable');
});
