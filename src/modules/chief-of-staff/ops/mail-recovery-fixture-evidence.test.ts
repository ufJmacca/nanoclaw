import { expect, it } from 'vitest';
import { MAIL_CHECKPOINT_CASES } from '../../../contracts/chief-of-staff/mail-fixture-report.js';
import { verifyMailRecoveryFixtureEvidence } from './mail-recovery-fixture-evidence.js';
import { verifyMailReleaseEvidence } from './mail-artifact-fixture-evidence.js';
import {
  identity,
  tap,
  mailRecoveryEvidenceFixture as records,
} from '../../../contracts/chief-of-staff/mail-recovery-evidence-fixture.js';
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
it.each(records().map((_, index) => index))('refuses missing or duplicated required record %i', (index) => {
  const missing = records();
  missing.splice(index, 1);
  expect(() => verifyMailRecoveryFixtureEvidence(report(missing), identity)).toThrow(
    'mail_recovery_evidence_unavailable',
  );
  const duplicate = records();
  duplicate.push(duplicate[index]);
  expect(() => verifyMailRecoveryFixtureEvidence(report(duplicate), identity)).toThrow();
});
it.each([10, 11, 12].flatMap((index) => Object.keys(records()[index]).map((key) => ({ index, key }))))(
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
