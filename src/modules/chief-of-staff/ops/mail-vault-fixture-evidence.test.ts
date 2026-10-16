import { expect, it } from 'vitest';
import { verifyMailVaultFixtureEvidence } from './mail-vault-fixture-evidence.js';
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
it.each(['sourceCommit', 'sourceTree', 'fixtureImage'] as const)('refuses a foreign %s', (field) => {
  expect(() =>
    verifyMailVaultFixtureEvidence(report(), {
      ...identity,
      [field]: field === 'fixtureImage' ? 'sha256:' + 'd'.repeat(64) : 'd'.repeat(40),
    }),
  ).toThrow('mail_vault_evidence_unavailable');
});
it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])('refuses missing or duplicate required record %i', (index) => {
  const missing = records();
  missing.splice(index, 1);
  expect(() => verifyMailVaultFixtureEvidence(report(missing), identity)).toThrow();
  const duplicate = records();
  duplicate.push(duplicate[index]);
  expect(() => verifyMailVaultFixtureEvidence(report(duplicate), identity)).toThrow();
});
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
