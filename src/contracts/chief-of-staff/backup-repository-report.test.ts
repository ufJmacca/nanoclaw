import { expect, it } from 'vitest';
import { BACKUP_REPOSITORY_CASES, verifyBackupRepositoryReport } from './backup-repository-report.js';
const report = () =>
  [
    'TAP version 13',
    ...BACKUP_REPOSITORY_CASES.map((name, index) => `ok ${index + 1} - ${name}`),
    '1..45',
    '# tests 45',
    '# suites 0',
    '# pass 45',
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
    '# duration_ms 312921',
  ].join('\n');
it('requires the actual encrypted transfer, retention, recovery and killed-publication cases', () => {
  expect(verifyBackupRepositoryReport(report())).toEqual({ actualRepositoryCases: 45 });
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
  if (change === 'missing') text = text.replace(/^ok 45 - .*\n/m, '');
  if (change === 'duplicate') text = text.replace(/^ok 45 - .*$/m, 'ok 1 - ' + BACKUP_REPOSITORY_CASES[0]);
  if (change === 'wrong-name') text = text.replace(BACKUP_REPOSITORY_CASES[39], 'unrelated mocked maintenance');
  if (change === 'failed') text = text.replace('ok 2 -', 'not ok 2 -');
  if (change === 'skipped')
    text = text.replace('ok 3 - ' + BACKUP_REPOSITORY_CASES[2], 'ok 3 - ' + BACKUP_REPOSITORY_CASES[2] + ' # SKIP');
  if (change === 'todo') text = text.replace('# todo 0', '# todo 1');
  if (change === 'wrong-plan') text = text.replace('1..45', '1..44');
  if (change === 'wrong-summary') text += '\n# fail 1';
  if (change === 'oversized') text += 'x'.repeat(512 * 1024);
  expect(() => verifyBackupRepositoryReport(text)).toThrow('backup_repository_fixture_unverified');
});
