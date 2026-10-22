import { expect, it } from 'vitest';
import {
  identity,
  mailRecoveryEvidenceFixture,
} from '../../../contracts/chief-of-staff/mail-recovery-evidence-fixture.js';
import { verifyMailDraftVaultFixtureEvidence } from './mail-vault-fixture-evidence.js';
import { verifyMailDraftRecoveryFixtureEvidence } from './mail-recovery-fixture-evidence.js';
import { verifyMailDraftReleaseEvidence } from './mail-artifact-fixture-evidence.js';
const report = (rows = mailRecoveryEvidenceFixture(true)) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
it('requires the separate compose profile and unchanged readonly reader in the same actual kernel run', () => {
  const rows = mailRecoveryEvidenceFixture(true).filter(
    (row) => !('encryptedMailDraftCheckpoint' in row) && !('completeMailDraftCredentialRecovery' in row),
  );
  rows[0].mode = 'draft-credentials-kernel';
  expect(verifyMailDraftVaultFixtureEvidence(report(rows), identity)).toEqual({
    credentialGeneration: 2,
    journalEvents: 3,
    deniedDirectoryCases: 7,
  });
  expect(() => verifyMailDraftRecoveryFixtureEvidence(report(rows), identity)).toThrow();
});
it('requires all four complete profiles and schema20 recovery without restoring current authority', () => {
  expect(verifyMailDraftRecoveryFixtureEvidence(report(), identity)).toEqual({
    actualDatabaseCases: 2,
    actualSources: 14,
    actualProfiles: 4,
    actualPayloadFiles: 32,
  });
  expect(() => verifyMailDraftVaultFixtureEvidence(report(), identity)).toThrow();
  expect(() => verifyMailDraftRecoveryFixtureEvidence(report(mailRecoveryEvidenceFixture()), identity)).toThrow();
});
it.each(mailRecoveryEvidenceFixture(true).map((_, index) => index))(
  'rejects missing or duplicated draft kernel record %i',
  (index) => {
    const rows = mailRecoveryEvidenceFixture(true);
    const missing = rows.filter((_, i) => i !== index);
    expect(() => verifyMailDraftRecoveryFixtureEvidence(report(missing), identity)).toThrow();
    expect(() => verifyMailDraftRecoveryFixtureEvidence(report([...rows, rows[index]]), identity)).toThrow();
  },
);
it.each([
  [4, 'credentialProfile', 'mail_reader'],
  [5, 'readerProfilePreserved', false],
  [5, 'readerOnlyScope', false],
  [5, 'readerJournalEvents', 2],
  [6, 'deniedCases', 6],
  [10, 'sourceCommit', 'c'.repeat(40)],
  [10, 'databaseProfile', 'runtime-disposable'],
  [10, 'databaseTls', 'require'],
  [10, 'tap', 'mocked checkpoint'],
  [11, 'actualProfiles', 3],
  [11, 'actualSources', 13],
  [11, 'actualPayloadFiles', 31],
  [11, 'actualScheduledPageSources', 9],
  [11, 'restoredAuthorityActivated', true],
  [11, 'ownerCredentialsUsed', true],
  [11, 'privateWorkspaceRemoved', false],
] as const)('rejects changed draft kernel record %i/%s', (index, key, value) => {
  const rows = mailRecoveryEvidenceFixture(true);
  rows[index][key] = value;
  expect(() => verifyMailDraftRecoveryFixtureEvidence(report(rows), identity)).toThrow();
});
it('binds both draft kernel gates to the observed source, fixture and immutable host', () => {
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
            'nanoclaw.release-role': 'vault-fixture',
            'org.opencontainers.image.revision': identity.sourceCommit,
            'nanoclaw.tested-host': 'sha256:' + 'd'.repeat(64),
          },
        },
      },
    ],
  };
  expect(verifyMailDraftReleaseEvidence('draft_recovery', report(), expected)).toMatchObject({ actualProfiles: 4 });
  const rows = mailRecoveryEvidenceFixture(true).filter(
    (row) => !('encryptedMailDraftCheckpoint' in row) && !('completeMailDraftCredentialRecovery' in row),
  );
  rows[0].mode = 'draft-credentials-kernel';
  expect(verifyMailDraftReleaseEvidence('draft_credentials', report(rows), expected)).toMatchObject({
    journalEvents: 3,
  });
  expected.fixtureInspection[0].Config.Labels['nanoclaw.tested-host'] = 'sha256:' + 'e'.repeat(64);
  for (const gate of ['draft_recovery', 'draft_credentials'])
    expect(() => verifyMailDraftReleaseEvidence(gate, report(), expected)).toThrow('vault_fixture_identity_mismatch');
});
