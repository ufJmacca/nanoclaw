import { expect, it } from 'vitest';
import { BACKUP_POSTGRES_CASES, BACKUP_POSTGRES_FILES, verifyBackupPostgresReport } from './backup-postgres-report.js';

function report() {
  return {
    success: true,
    numPassedTests: 6,
    numFailedTests: 0,
    numRuntimeErrorTestSuites: 0,
    testResults: BACKUP_POSTGRES_FILES.map((name, index) => ({
      name: String(name),
      status: 'passed',
      assertionResults: BACKUP_POSTGRES_CASES[index].map((title) => ({ title: String(title), status: 'passed' })),
    })),
  };
}
it('requires all six actual database cases from the exact compiled host tests', () => {
  expect(verifyBackupPostgresReport(JSON.stringify(report()))).toEqual({ actualDatabaseCases: 6 });
});
it.each([
  'missing-case',
  'skipped-case',
  'duplicate-case',
  'unexpected-case',
  'wrong-file',
  'file-error',
  'zero-tests',
])('refuses the successful process report when it contains %s', (reason) => {
  const value = report();
  if (reason === 'missing-case') value.testResults[0].assertionResults.pop();
  if (reason === 'skipped-case') value.testResults[0].assertionResults[0].status = 'pending';
  if (reason === 'duplicate-case') value.testResults[0].assertionResults.push(value.testResults[0].assertionResults[0]);
  if (reason === 'unexpected-case') value.testResults[0].assertionResults[0].title = 'mock-only substitute';
  if (reason === 'wrong-file') value.testResults[0].name = '/workspace/src/checkout-override.test.ts';
  if (reason === 'file-error') value.testResults[0].status = 'failed';
  if (reason === 'zero-tests') value.numPassedTests = 0;
  expect(() => verifyBackupPostgresReport(JSON.stringify(value))).toThrow('backup_postgres_fixture_unverified');
});
it.each(['failed-test', 'runtime-error', 'unsuccessful', 'hidden-failed-assertion'])(
  'refuses %s even when six passing names are present',
  (reason) => {
    const value = report();
    if (reason === 'failed-test') value.numFailedTests = 1;
    if (reason === 'runtime-error') value.numRuntimeErrorTestSuites = 1;
    if (reason === 'unsuccessful') value.success = false;
    if (reason === 'hidden-failed-assertion')
      value.testResults[0].assertionResults.push({ title: 'additional failed case', status: 'failed' });
    expect(() => verifyBackupPostgresReport(JSON.stringify(value))).toThrow('backup_postgres_fixture_unverified');
  },
);
it.each(['null', '{', JSON.stringify({ success: true }), ' '.repeat(4 * 1024 ** 2 + 1)])(
  'refuses incomplete or oversized reports',
  (value) => {
    expect(() => verifyBackupPostgresReport(value)).toThrow('backup_postgres_fixture_unverified');
  },
);
