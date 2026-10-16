import { expect, it } from 'vitest';
import { MAIL_CHECKPOINT_CASES } from '../../../contracts/chief-of-staff/mail-fixture-report.js';
import { verifyMailRecoveryFixtureEvidence } from './mail-recovery-fixture-evidence.js';
import { verifyMailReleaseEvidence } from './mail-artifact-fixture-evidence.js';
const identity = { sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), fixtureImage: 'sha256:' + 'c'.repeat(64) };
const tap = [
  'TAP version 13',
  ...MAIL_CHECKPOINT_CASES.map((name, index) => `ok ${index + 1} - ${name}`),
  '1..2',
  '# tests 2',
  '# suites 0',
  '# pass 2',
  '# fail 0',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
].join('\n');
function records(): Record<string, unknown>[] {
  return [
    { vaultFixtureImage: identity.fixtureImage, sourceCommit: identity.sourceCommit, mode: 'mail-recovery-kernel' },
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
      encryptedMailCheckpoint: 'passed',
      sourceCommit: identity.sourceCommit,
      sourceTree: identity.sourceTree,
      actualDatabaseCases: 2,
      tap,
      actualKernelVault: true,
      actualPinnedStaging: true,
      actualMemoryProtection: true,
      compiledProductionPayload: true,
      sourceOverrides: false,
      databaseProfile: 'test',
      databaseTls: 'verify-full',
      runtimeProfileUsed: false,
      ownerCredentialsUsed: false,
      liveAccountAcceptance: false,
      installedAcceptance: false,
    },
    {
      completeMailCredentialRecovery: 'passed',
      sourceCommit: identity.sourceCommit,
      sourceTree: identity.sourceTree,
      actualSources: 11,
      actualProfiles: 3,
      actualPayloadFiles: 25,
      actualScheduledPageSources: 8,
      actualFixedProducer: true,
      actualPinnedRestic: true,
      actualEncryptedJournal: true,
      actualKernelWriter: true,
      actualIsolatedRestore: true,
      actualMemoryProtection: true,
      actualKernelVault: true,
      productionStorageOverrides: false,
      productionMemoryOverrides: false,
      offlinePendingPreserved: true,
      repeatedUploadReconciled: true,
      unchangedPageReused: true,
      pendingRetired: false,
      completeArchiveStaged: false,
      protectedAuthorityUnchanged: true,
      restoredAuthorityActivated: false,
      privateWorkspaceRemoved: true,
      targetAndServiceAdmission: 'fixture',
      repositoryAdmission: 'fixture',
      liveNasAcceptance: false,
      ownerCredentialsUsed: false,
      liveAccountAcceptance: false,
      installedAcceptance: false,
      compiledProductionPayload: true,
    },
  ];
}
const report = (values = records()) => values.map((value) => JSON.stringify(value)).join('\n') + '\n';
it('requires actual encrypted checkpoint coverage and complete credential recovery in the same successful kernel run', () => {
  expect(verifyMailRecoveryFixtureEvidence(report(), identity)).toEqual({
    actualDatabaseCases: 2,
    actualSources: 11,
    actualProfiles: 3,
    actualPayloadFiles: 25,
  });
});
it('admits recovery only through the matching host/fixture dispatch and never reuses it as a credential run', () => {
  const expected = {
    ...identity,
    hostImage: 'sha256:' + 'd'.repeat(64),
    fixtureInspection: [
      {
        Id: identity.fixtureImage,
        Os: 'linux',
        Architecture: 'arm64',
        Config: {
          Labels: {
            'org.opencontainers.image.revision': identity.sourceCommit,
            'nanoclaw.release-role': 'vault-fixture',
            'nanoclaw.tested-host': 'sha256:' + 'd'.repeat(64),
          },
        },
      },
    ],
  };
  expect(verifyMailReleaseEvidence('mail_recovery', report(), expected)).toEqual({
    actualDatabaseCases: 2,
    actualSources: 11,
    actualProfiles: 3,
    actualPayloadFiles: 25,
  });
  expect(() => verifyMailReleaseEvidence('mail_credentials', report(), expected)).toThrow(
    'mail_vault_evidence_unavailable',
  );
  expected.fixtureInspection[0].Config.Labels['nanoclaw.tested-host'] = 'sha256:' + 'e'.repeat(64);
  expect(() => verifyMailReleaseEvidence('mail_recovery', report(), expected)).toThrow(
    'vault_fixture_identity_mismatch',
  );
});
it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])('refuses missing or duplicated required record %i', (index) => {
  const missing = records();
  missing.splice(index, 1);
  expect(() => verifyMailRecoveryFixtureEvidence(report(missing), identity)).toThrow(
    'mail_recovery_evidence_unavailable',
  );
  const duplicate = records();
  duplicate.push(duplicate[index]);
  expect(() => verifyMailRecoveryFixtureEvidence(report(duplicate), identity)).toThrow();
});
it.each([10, 11].flatMap((index) => Object.keys(records()[index]).map((key) => ({ index, key }))))(
  'refuses altered $index/$key recovery proof',
  ({ index, key }) => {
    const changed = records();
    changed[index][key] = 'not_verified';
    expect(() => verifyMailRecoveryFixtureEvidence(report(changed), identity)).toThrow(
      'mail_recovery_evidence_unavailable',
    );
  },
);
it.each([
  'missing-case',
  'wrong-case',
  'skipped',
  'failed',
  'native-report',
  'runtime',
  'foreign-tree',
  'credential-mode',
  'truncated',
  'error-record',
])('refuses %s recovery evidence', (reason) => {
  const changed = records();
  if (reason === 'missing-case') changed[10].tap = tap.replace(/^ok 2 - .*\n/m, '');
  if (reason === 'wrong-case') changed[10].tap = tap.replace(MAIL_CHECKPOINT_CASES[1], 'empty mock restore');
  if (reason === 'skipped') changed[10].tap = tap.replace('# skipped 0', '# skipped 1');
  if (reason === 'failed') changed[10].tap = tap.replace('ok 2 -', 'not ok 2 -');
  if (reason === 'native-report') changed[10].tap = 'TAP version 13\nok 1 - native\n1..1';
  if (reason === 'runtime') changed[10].databaseProfile = 'runtime-disposable';
  if (reason === 'foreign-tree') changed[11].sourceTree = 'e'.repeat(40);
  if (reason === 'credential-mode') changed[0].mode = 'mail-credentials-kernel';
  if (reason === 'error-record') changed.push({ code: 'private_fixture_failed' });
  const text = report(changed);
  expect(() =>
    verifyMailRecoveryFixtureEvidence(reason === 'truncated' ? text.slice(0, -4) : text, identity),
  ).toThrow();
});
