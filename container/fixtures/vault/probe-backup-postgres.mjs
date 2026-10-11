// Actual selected PostgreSQL and native files; no owner data or source overrides.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { verifyVaultMemory } from '/code/modules/chief-of-staff/ops/vault-memory.js';
import { verifyVaultStorage, withVaultDirectory } from '/code/modules/chief-of-staff/ops/vault-storage.js';
import { fixtureDatabaseConfig, selectedFixtureEnvironment } from '/code/contracts/chief-of-staff/fixture-database.js';
import { verifyBackupPostgresReport } from '/code/contracts/chief-of-staff/backup-postgres-report.js';
process.umask(0o077);
assert.equal(process.getuid(), 1000);
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'arm64');
assert.equal(process.version, 'v22.23.2');
assert.equal(process.env.COS_FIXTURE_DATABASE_PROFILE, 'test');
const source = JSON.parse(fs.readFileSync('/release/build-info.json', 'utf8'));
assert.match(source.commit, /^[a-f0-9]{40}$/);
assert.match(source.tree, /^[a-f0-9]{40}$/);
const selected = selectedFixtureEnvironment(process.env, true);
assert(selected.COS_TEST_TARGET_ID);
assert.equal(selected.COS_TEST_PGSSLMODE, 'verify-full');
assert.equal(selected.COS_TEST_PGSSLROOTCERT, '/selected-ca.pem');
await fixtureDatabaseConfig(selected, 'migration');
assert.equal(JSON.parse(fs.readFileSync('/node_modules/vitest/package.json', 'utf8')).version, '4.1.4');
const roots = {
  targetRoot: '/home/fixture/.config/nanoclaw-cos/state',
  installationRoot: '/case/application',
  dataRoot: '/case/data',
};
verifyVaultMemory();
const policy = verifyVaultStorage(roots);
assert.equal(policy.vaultRoot, '/case/vault');
assert.equal(policy.volume.filesystem, 'ext4');
await withVaultDirectory(roots, 'staging', async (directory, current) => {
  current();
  const physical = fs.realpathSync(directory);
  assert.equal(physical, '/case/vault/staging');
  const root = fs.mkdtempSync(physical + '/g02-postgres-'),
    initial = fs.lstatSync(root),
    report = root + '/report.json';
  assert.equal(initial.uid, 1000);
  assert.equal(initial.mode & 0o7777, 0o700);
  assert.equal(initial.dev, fs.statSync(physical).dev);
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
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          LANG: 'C',
          LC_ALL: 'C',
          TZ: 'Australia/Sydney',
          TMPDIR: root,
          ...selected,
        },
        stdio: 'ignore',
        timeout: 240000,
      },
    );
    current();
    assert.equal(result.error, undefined, 'encrypted_postgres_process_failed');
    assert.equal(result.signal, null, 'encrypted_postgres_process_failed');
    assert.equal(result.status, 0, 'encrypted_postgres_process_failed');
    const stat = fs.lstatSync(report);
    assert(
      stat.isFile() && stat.nlink === 1 && stat.uid === 1000 && stat.dev === initial.dev && stat.size <= 4 * 1024 ** 2,
    );
    fs.chmodSync(report, 0o600);
    assert.deepEqual(verifyBackupPostgresReport(fs.readFileSync(report, 'utf8')), { actualDatabaseCases: 6 });
    assert.equal(fs.lstatSync(root).ino, initial.ino);
    current();
  } finally {
    current();
    assert.equal(fs.lstatSync(root).ino, initial.ino);
    assert.equal(fs.lstatSync(root).dev, initial.dev);
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false);
  }
  current();
});
verifyVaultMemory();
assert.equal(verifyVaultStorage(roots).volume.filesystemUuid, policy.volume.filesystemUuid);
console.log(
  JSON.stringify({
    encryptedPostgresCapture: 'passed',
    actualDatabaseCases: 6,
    actualKernelVault: true,
    actualPinnedStaging: true,
    actualMemoryProtection: true,
    compiledProductionPayload: true,
    actualScheduledAndManualCapture: true,
    actualCompleteImport: true,
    privateTemporaryRootsRemoved: true,
    runtimeProfileUsed: false,
    sourceOverrides: false,
    ownerCredentialsUsed: false,
    targetAndServiceAdmission: 'fixture',
    innerStorageAdmission: 'fixture',
    outerStorageAdmission: 'actual_kernel',
    sealedSourceCommit: source.commit,
    sealedSourceTree: source.tree,
    installedAcceptance: false,
    finalArtifact: false,
  }),
);
