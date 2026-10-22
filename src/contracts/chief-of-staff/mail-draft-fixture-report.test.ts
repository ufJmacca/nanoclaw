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
