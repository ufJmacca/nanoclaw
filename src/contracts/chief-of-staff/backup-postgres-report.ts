export const BACKUP_POSTGRES_FILES = [
  '/release/dist/modules/chief-of-staff/ops/backup-state-capture.test.js',
  '/release/dist/modules/chief-of-staff/ops/backup-recovered-import.test.js',
  '/release/dist/modules/chief-of-staff/ops/backup-test-database.test.js',
] as const;
export const BACKUP_POSTGRES_CASES = [
  [
    'captures the admitted separate PostgreSQL scope through real producers without exposing foreign records or resetting native state (scheduled=false)',
    'captures the admitted separate PostgreSQL scope through real producers without exposing foreign records or resetting native state (scheduled=true)',
    'imports a complete real-producer capture through the default recovery composition into the admitted separate test database',
  ],
  [
    'uses the admitted separate PostgreSQL target for owned recovered import and retained-commit reconciliation (sameDatabase=false)',
    'uses the admitted separate PostgreSQL target for owned recovered import and retained-commit reconciliation (sameDatabase=true)',
  ],
  ['refuses an actual admitted test database selected again under a runtime connection alias'],
] as const;
/** A zero exit or skipped database cases cannot establish actual recovery coverage. */
export function verifyBackupPostgresReport(text: string): { actualDatabaseCases: 6 } {
  try {
    if (Buffer.byteLength(text) > 4 * 1024 ** 2) throw Error('bounds');
    const value = JSON.parse(text);
    if (
      !value ||
      value.success !== true ||
      value.numPassedTests !== 6 ||
      value.numFailedTests !== 0 ||
      value.numFailedTestSuites !== 0 ||
      !Array.isArray(value.testResults) ||
      value.testResults.length !== BACKUP_POSTGRES_FILES.length
    )
      throw Error('coverage');
    for (const [index, name] of BACKUP_POSTGRES_FILES.entries()) {
      const files = value.testResults.filter((file: { name?: unknown }) => file?.name === name);
      if (files.length !== 1) throw Error('identity');
      const file = files[0];
      if (file.status !== 'passed' || !Array.isArray(file.assertionResults) || file.assertionResults.length > 128)
        throw Error('file');
      if (
        file.assertionResults.some(
          (result: { status?: unknown }) => !result || !['passed', 'skipped'].includes(String(result.status)),
        )
      )
        throw Error('assertion');
      const passed = file.assertionResults
        .filter((result: { status?: unknown }) => result?.status === 'passed')
        .map((result: { title?: unknown }) => result.title)
        .sort();
      if (JSON.stringify(passed) !== JSON.stringify([...BACKUP_POSTGRES_CASES[index]].sort())) throw Error('cases');
    }
    return { actualDatabaseCases: 6 };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Database fixture diagnostics and private endpoint paths are not public output.
    throw Error('backup_postgres_fixture_unverified');
  }
}
