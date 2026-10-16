import { expect, it } from 'vitest';
import {
  MAIL_STORE_CASES,
  MAIL_CHECKPOINT_CASES,
  MAIL_NATIVE_CASES,
  verifyMailFixtureReport,
} from './mail-fixture-report.js';
const cases = (suite: 'database' | 'native' | 'all' | 'checkpoint') =>
  suite === 'native'
    ? [...MAIL_NATIVE_CASES]
    : suite === 'checkpoint'
      ? [...MAIL_CHECKPOINT_CASES]
      : [...MAIL_STORE_CASES, ...MAIL_CHECKPOINT_CASES, ...(suite === 'all' ? MAIL_NATIVE_CASES : [])];
const report = (suite: 'database' | 'native' | 'all' | 'checkpoint' = 'all') => {
  const names = cases(suite),
    n = names.length;
  return [
    'TAP version 13',
    ...names.map((name, i) => `ok ${i + 1} - ${name}`),
    `1..${n}`,
    `# tests ${n}`,
    '# suites 0',
    `# pass ${n}`,
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
    '# duration_ms 12000',
  ].join('\n');
};
it.each(['database', 'native', 'all', 'checkpoint'] as const)(
  'requires every named %s mail case with complete non-skipped TAP',
  (suite) => {
    expect(verifyMailFixtureReport(report(suite), suite)).toEqual({ suite, actualCases: cases(suite).length });
  },
);
it.each([
  'missing',
  'duplicate',
  'unknown',
  'zero-id',
  'malformed',
  'failed',
  'nested-failed',
  'skip',
  'todo',
  'summary',
  'plan',
  'duplicate-summary',
  'foreign-suite',
  'unknown-suite',
  'oversize',
  'empty',
  'non-text',
])('refuses %s mail evidence', (change) => {
  let text = report();
  if (change === 'missing') text = text.replace(/^ok 46 - .*\n/m, '');
  if (change === 'duplicate') text = text.replace(/^ok 46 - .*$/m, 'ok 1 - ' + MAIL_STORE_CASES[0]);
  if (change === 'unknown') text = text.replace(MAIL_CHECKPOINT_CASES[1], 'mocked empty recovery');
  if (change === 'zero-id') text = text.replace('ok 1 -', 'ok 0 -');
  if (change === 'malformed') text += '\nok 00 - invented';
  if (change === 'failed') text = text.replace('ok 2 -', 'not ok 2 -');
  if (change === 'nested-failed') text += '\n    not ok 1 - hidden failure';
  if (change === 'skip')
    text = text.replace('ok 2 - ' + MAIL_STORE_CASES[1], 'ok 2 - ' + MAIL_STORE_CASES[1] + ' # SKIP');
  if (change === 'todo') text = text.replace('# todo 0', '# todo 1');
  if (change === 'summary') text = text.replace('# pass 46', '# pass 45');
  if (change === 'plan') text = text.replace('1..46', '1..45');
  if (change === 'duplicate-summary') text += '\n# fail 0';
  if (change === 'foreign-suite') text = report('native');
  if (change === 'oversize') text += 'x'.repeat(1024 ** 2);
  if (change === 'empty') text = '';
  if (change === 'non-text') text = undefined as never;
  expect(() => verifyMailFixtureReport(text, change === 'unknown-suite' ? ('fixture' as never) : 'all')).toThrow(
    'mail_fixture_report_unverified',
  );
});
it('cannot use database-only coverage as a native conversation or a single conversation as database recovery', () => {
  expect(() => verifyMailFixtureReport(report('database'), 'native')).toThrow('mail_fixture_report_unverified');
  expect(() => verifyMailFixtureReport(report('native'), 'database')).toThrow('mail_fixture_report_unverified');
});
it('keeps the exact encrypted checkpoint sub-suite separate from broader database and native coverage', () => {
  for (const suite of ['database', 'native', 'all'] as const) {
    expect(() => verifyMailFixtureReport(report(suite), 'checkpoint')).toThrow('mail_fixture_report_unverified');
    expect(() => verifyMailFixtureReport(report('checkpoint'), suite)).toThrow('mail_fixture_report_unverified');
  }
  expect(() =>
    verifyMailFixtureReport(report('checkpoint').replace(MAIL_CHECKPOINT_CASES[1], 'empty restore'), 'checkpoint'),
  ).toThrow();
});
