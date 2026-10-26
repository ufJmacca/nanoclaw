import { expect, it } from 'vitest';
import {
  MAIL_DRAFT_DATABASE_CASES,
  MAIL_DRAFT_NATIVE_CASES,
  MAIL_DRAFT_CHECKPOINT_CASES,
  verifyMailDraftFixtureReport,
} from './mail-draft-fixture-report.js';
const names = (suite: 'database' | 'native' | 'checkpoint' | 'all') =>
  suite === 'database'
    ? [...MAIL_DRAFT_DATABASE_CASES]
    : suite === 'native'
      ? [...MAIL_DRAFT_NATIVE_CASES]
      : suite === 'checkpoint'
        ? [...MAIL_DRAFT_CHECKPOINT_CASES]
        : [...MAIL_DRAFT_DATABASE_CASES, ...MAIL_DRAFT_NATIVE_CASES, ...MAIL_DRAFT_CHECKPOINT_CASES];
const report = (suite: 'database' | 'native' | 'checkpoint' | 'all') => {
  const cases = names(suite),
    n = cases.length;
  return [
    'TAP version 13',
    ...cases.map((name, index) => `ok ${index + 1} - ${name}`),
    `1..${n}`,
    `# tests ${n}`,
    '# suites 0',
    `# pass ${n}`,
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
  ].join('\n');
};
it.each(['database', 'native', 'checkpoint', 'all'] as const)(
  'requires every distinct actual %s draft case with no failed, skipped or missing execution',
  (suite) => {
    expect(verifyMailDraftFixtureReport(report(suite), suite)).toEqual({ suite, actualCases: names(suite).length });
  },
);
it.each([
  'missing',
  'duplicate',
  'unknown',
  'failed',
  'nested',
  'skipped',
  'summary',
  'foreign-suite',
  'unknown-suite',
  'oversized',
  'empty',
] as const)('rejects %s draft execution evidence', (change) => {
  let text = report('all');
  if (change === 'missing') text = text.replace('ok 1 - ' + names('all')[0] + '\n', '');
  if (change === 'duplicate') text = text.replace('ok 2 - ' + names('all')[1], 'ok 1 - ' + names('all')[0]);
  if (change === 'unknown') text = text.replace(names('all')[0], 'mocked policy receipt');
  if (change === 'failed') text = text.replace('ok 2 -', 'not ok 2 -');
  if (change === 'nested') text += '\n    not ok 1 - hidden failure';
  if (change === 'skipped') text = text.replace('# skipped 0', '# skipped 1');
  if (change === 'summary') text += '\n# pass 999';
  if (change === 'foreign-suite') text = report('native');
  if (change === 'oversized') text += 'x'.repeat(1024 ** 2);
  if (change === 'empty') text = '';
  expect(() => verifyMailDraftFixtureReport(text, change === 'unknown-suite' ? ('unknown' as never) : 'all')).toThrow(
    'mail_draft_fixture_report_unverified',
  );
});

// Flat execution fields captured from the 16 passing cases in the immutable D8D host.
const capturedCompiledDraftDatabaseReport = `TAP version 13
ok 1 - G05 actual owner policy transaction installs one immutable revision and reconciles identical metadata
ok 2 - G05 actual owner policy rollback preserves a failed final authority check without creating policy rows
ok 3 - G05 actual owner policy refuses a changed reader and never enables another scope
ok 4 - G05 runtime policy reads do not require or grant policy mutation rights
ok 5 - G05 real writer discovery exposes only current owner-bound identifiers without provider work
ok 6 - G05 real PostgreSQL policies and published read-only source admit one verified draft; retries recheck edits
ok 7 - G05 concurrent retries and an older PostgreSQL request snapshot cannot erase the independent effect reservation
ok 8 - G05 checked draft answers preserve the exact host receipt and stop publication after an observed edit
ok 9 - G05 a draft changing during answer publication denies the staged success rather than publishing stale confirmation
ok 10 - G05 real admission denies disabled_policy without any provider draft write
ok 11 - G05 real admission denies foreign_owner without any provider draft write
ok 12 - G05 real admission denies expired_source without any provider draft write
ok 13 - G05 real admission denies withdrawn_source without any provider draft write
ok 14 - G05 real admission denies processing_denied without any provider draft write
ok 15 - G05 real admission denies reader_revoked without any provider draft write
ok 16 - G05 real admission denies native_paused without any provider draft write
1..16
# tests 16
# suites 0
# pass 16
# fail 0
# cancelled 0
# skipped 0
# todo 0`;

it('requires the review regressions before a historical sixteen-case database report can supply current release evidence', () => {
  expect(() => verifyMailDraftFixtureReport(capturedCompiledDraftDatabaseReport, 'database')).toThrow(
    'mail_draft_fixture_report_unverified',
  );
});

it('requires both checked-draft publication cases rather than accepting the old fourteen-case inventory', () => {
  const oldReport = capturedCompiledDraftDatabaseReport
    .split('\n')
    .filter(
      (line) =>
        !line.includes('G05 checked draft answers preserve the exact host receipt') &&
        !line.includes('G05 a draft changing during answer publication'),
    )
    .map((line) =>
      line.replace(/^ok (\d+) -/, (_, number: string) => `ok ${Number(number) >= 10 ? Number(number) - 2 : number} -`),
    )
    .join('\n')
    .replace('1..16', '1..14')
    .replace('# tests 16', '# tests 14')
    .replace('# pass 16', '# pass 14');
  expect(() => verifyMailDraftFixtureReport(oldReport, 'database')).toThrow('mail_draft_fixture_report_unverified');
});
