import { expect, it } from 'vitest';
import {
  MAIL_REVIEW_SCHEMA_RESULTS,
  MAIL_REVIEW_NATIVE_CASES,
  verifyMailReviewFixtureReport,
} from './mail-review-fixture-report.js';

function report(suite: 'database' | 'native') {
  const count = suite === 'database' ? 31 : 1;
  return [
    'TAP version 13',
    ...(suite === 'database'
      ? MAIL_REVIEW_SCHEMA_RESULTS.map(([depth, id, name]) => ' '.repeat(depth) + `ok ${id} - ${name}`)
      : [`ok 1 - ${MAIL_REVIEW_NATIVE_CASES[0]}`]),
    ...(suite === 'database' ? ['        1..21', '    1..8'] : []),
    suite === 'database' ? '1..2' : '1..1',
    `# tests ${count}`,
    '# suites 0',
    `# pass ${count}`,
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
  ].join('\n');
}
it.each(['database', 'native'] as const)(
  'requires every actual named G06 %s case without skipped or failed work',
  (suite) => {
    expect(verifyMailReviewFixtureReport(report(suite), suite)).toEqual({
      suite,
      actualCases: suite === 'database' ? 31 : 1,
    });
  },
);
it.each([
  'missing',
  'duplicate',
  'renamed',
  'depth',
  'id',
  'failed',
  'nested-failed',
  'skipped',
  'todo',
  'summary',
  'plan',
  'extra-plan',
  'extra-root',
  'oversize',
  'unknown-suite',
])('rejects %s review evidence', (mode) => {
  let text = report('database');
  if (mode === 'missing') text = text.replace(/^ {8}ok 1 - .*\n/m, '');
  if (mode === 'duplicate') text += '\n        ok 1 - revoked policy';
  if (mode === 'renamed') text = text.replace('revoked policy', 'unrelated assertion');
  if (mode === 'depth') text = text.replace('        ok 1 -', '    ok 1 -');
  if (mode === 'id') text = text.replace('        ok 2 -', '        ok 1 -');
  if (mode === 'failed') text = text.replace('ok 1 - G06', 'not ok 1 - G06');
  if (mode === 'nested-failed') text += '\n            not ok 1 - hidden';
  if (mode === 'skipped') text = text.replace('revoked policy', 'revoked policy # SKIP');
  if (mode === 'todo') text = text.replace('# todo 0', '# todo 1');
  if (mode === 'summary') text = text.replace('# tests 31', '# tests 30');
  if (mode === 'plan') text = text.replace('        1..21', '        1..20');
  if (mode === 'extra-plan') text += '\n        1..21';
  if (mode === 'extra-root') text += '\nok 2 - foreign';
  if (mode === 'oversize') text += 'x'.repeat(1024 ** 2);
  expect(() => verifyMailReviewFixtureReport(text, mode === 'unknown-suite' ? ('all' as never) : 'database')).toThrow(
    'mail_review_fixture_report_unverified',
  );
});
it('keeps database policy coverage distinct from the native worker conversation', () => {
  expect(() => verifyMailReviewFixtureReport(report('database'), 'native')).toThrow();
  expect(() => verifyMailReviewFixtureReport(report('native'), 'database')).toThrow();
});
