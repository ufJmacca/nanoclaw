import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fixtureDatabaseConfig, selectedFixtureEnvironment } from './fixture-database.js';
import { verifyBackupPostgresReport } from './backup-postgres-report.js';

test('the compiled ARM64 host captures and imports through the separate admitted PostgreSQL database', async () => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'arm64');
  assert.equal(process.versions.node, '22.23.2');
  assert.equal(process.getuid?.(), 1000);
  assert.equal(process.env.COS_FIXTURE_DATABASE_PROFILE, 'test');
  assert.equal(JSON.parse(fs.readFileSync('/release/node_modules/vitest/package.json', 'utf8')).version, '4.1.4');
  const selected = selectedFixtureEnvironment(process.env, true);
  assert(selected.COS_TEST_TARGET_ID);
  assert.equal(selected.COS_TEST_PGSSLMODE, 'verify-full');
  await fixtureDatabaseConfig(selected, 'migration');
  const root = fs.mkdtempSync('/tmp/cos-backup-postgres-');
  fs.chmodSync(root, 0o700);
  const report = root + '/report.json',
    oldMask = process.umask(0o022);
  try {
    const result = spawnSync(
      '/release/node/bin/node',
      [
        '/release/node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        '/release/dist/contracts/chief-of-staff/backup-postgres-vitest.config.js',
        '--configLoader',
        'runner',
        '--no-cache',
        '--reporter=json',
        '--outputFile',
        report,
      ],
      {
        cwd: '/release',
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'Australia/Sydney', ...selected },
        stdio: 'ignore',
        timeout: 240000,
      },
    );
    assert.equal(result.error, undefined, 'backup_postgres_fixture_process_failed');
    assert.equal(result.status, 0, 'backup_postgres_fixture_process_failed');
    assert.equal(result.signal, null, 'backup_postgres_fixture_process_failed');
    const stat = fs.lstatSync(report);
    assert(stat.isFile() && stat.nlink === 1 && stat.uid === 1000 && stat.size <= 4 * 1024 ** 2);
    fs.chmodSync(report, 0o600);
    assert.deepEqual(verifyBackupPostgresReport(fs.readFileSync(report, 'utf8')), { actualDatabaseCases: 6 });
  } finally {
    process.umask(oldMask);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
