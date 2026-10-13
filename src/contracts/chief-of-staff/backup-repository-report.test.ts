import { expect, it } from 'vitest';
import { BACKUP_REPOSITORY_CASES, verifyBackupRepositoryReport } from './backup-repository-report.js';
const report = () =>
  [
    'TAP version 13',
    ...BACKUP_REPOSITORY_CASES.map((name, index) => `ok ${index + 1} - ${name}`),
    '1..49',
    '# tests 49',
    '# suites 0',
    '# pass 49',
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
    '# duration_ms 312921',
  ].join('\n');
it('requires the actual encrypted transfer, retention, recovery and killed-publication cases', () => {
  expect(verifyBackupRepositoryReport(report())).toEqual({ actualRepositoryCases: 49 });
});
it.each([
  'missing',
  'duplicate',
  'wrong-name',
  'failed',
  'skipped',
  'todo',
  'wrong-plan',
  'wrong-summary',
  'oversized',
])('refuses %s repository coverage', (change) => {
  let text = report();
  if (change === 'missing') text = text.replace(/^ok 49 - .*\n/m, '');
  if (change === 'duplicate') text = text.replace(/^ok 49 - .*$/m, 'ok 1 - ' + BACKUP_REPOSITORY_CASES[0]);
  if (change === 'wrong-name') text = text.replace(BACKUP_REPOSITORY_CASES[39], 'unrelated mocked maintenance');
  if (change === 'failed') text = text.replace('ok 2 -', 'not ok 2 -');
  if (change === 'skipped')
    text = text.replace('ok 3 - ' + BACKUP_REPOSITORY_CASES[2], 'ok 3 - ' + BACKUP_REPOSITORY_CASES[2] + ' # SKIP');
  if (change === 'todo') text = text.replace('# todo 0', '# todo 1');
  if (change === 'wrong-plan') text = text.replace('1..49', '1..48');
  if (change === 'wrong-summary') text += '\n# fail 1';
  if (change === 'oversized') text += 'x'.repeat(512 * 1024);
  expect(() => verifyBackupRepositoryReport(text)).toThrow('backup_repository_fixture_unverified');
});
it.each(['valid', 'owner', 'nonce', 'source-release'])(
  'requires the actual predeployment %s recovery case in the release evidence',
  (identity) => {
    const title =
      identity === 'valid'
        ? 'real encrypted predeployment recovery validates the complete captured payload without importing live authority'
        : `real encrypted predeployment recovery refuses an authentic archive with a foreign ${identity}`;
    const text = report().replace(title, 'unrelated fixture without predeployment recovery');
    expect(() => verifyBackupRepositoryReport(text)).toThrow('backup_repository_fixture_unverified');
  },
);
