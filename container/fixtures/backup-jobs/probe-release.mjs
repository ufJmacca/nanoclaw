import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createBackupJobInstaller } from '/release/dist/modules/chief-of-staff/ops/backup-job-install.js';
import { createBackupJobManagerControls } from '/release/dist/modules/chief-of-staff/ops/backup-job-install-effects.js';
import { readPrivate } from '/release/dist/modules/chief-of-staff/ops/target-state.js';
import { fixtureVaultRelease } from '/release/dist/contracts/chief-of-staff/release-fixture.js';
import { verifyResticReleasePayload } from '/release/dist/modules/chief-of-staff/ops/restic-release-payload.js';
process.umask(0o077);
assert.equal(process.getuid(), 1000);
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'arm64');
assert.equal(process.version, 'v22.23.2');
const source = JSON.parse(fs.readFileSync('/release/build-info.json', 'utf8'));
assert.equal(source.commit, process.env.COS_BACKUP_FIXTURE_SOURCE_COMMIT);
assert.equal(source.tree, process.env.COS_BACKUP_FIXTURE_SOURCE_TREE);
const backupArtifact = verifyResticReleasePayload('/release/libexec');
const home = '/home/fixture',
  config = home + '/.config/nanoclaw-cos',
  units = home + '/.config/systemd/user';
const settings = {
  version: 1,
  target: 'pi',
  sshAlias: 'fixture',
  hostFingerprint: 'a'.repeat(64),
  databaseFingerprint: 'b'.repeat(64),
  service: 'fixture-native.service',
  userHome: home,
  installationRoot: home + '/app',
  dataRoot: home + '/app/data',
  stateRoot: home + '/state',
  releaseRoot: home + '/releases',
  stagingRoot: home + '/staging',
  sourceRoot: home + '/sources',
  runtimeEnvironment: home + '/.config/runtime',
  migrationEnvironment: home + '/.config/migration',
};
for (const root of [config, units, settings.stateRoot, settings.installationRoot])
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
// Only release authority is synthetic. Code, executable, fixed unit compiler,
// installation effects and the isolated user manager are the selected host's.
const manifest = fixtureVaultRelease('G02');
const payload = settings.releaseRoot + '/' + manifest.releaseId + '/payload';
fs.mkdirSync(payload + '/node/bin', { recursive: true, mode: 0o700 });
// The installed command runs actual retained files. A symlinked entry has a
// different argv path from its module URL and does not exercise its main route.
fs.copyFileSync('/release/node/bin/node', payload + '/node/bin/node');
fs.cpSync('/release/dist', payload + '/dist', { recursive: true });
fs.copyFileSync('/release/package.json', payload + '/package.json');
fs.symlinkSync('/release/node_modules', payload + '/node_modules');
fs.writeFileSync(units + '/unrelated.service', '[Service]\nExecStart=/usr/bin/true\n', { mode: 0o600 });
let current = true,
  proofs = 0;
const assertCurrent = async () => {
  proofs++;
  if (!current) throw Error('fixture_scope_closed');
};
const controls = createBackupJobManagerControls(settings, assertCurrent);
const installer = createBackupJobInstaller(settings, manifest, controls);
const first = await installer.install();
assert.equal(first.phase, 'enabled');
assert((await controls.inspectManager()).definitionsLoaded);
assert(!(await controls.inspectManager()).timersRunning);
assert.equal((await installer.activate()).phase, 'active');
assert((await controls.inspectManager()).timersActive);
await controls.stopTimers();
assert(!(await controls.inspectManager()).timersRunning);
const upload = units + '/nanoclaw-cos-backup-upload.service',
  inode = fs.statSync(upload).ino;
await installer.install();
assert.equal(fs.statSync(upload).ino, inode);
assert.equal(readPrivate(settings.stateRoot + '/backup-job-installation.json').phase, 'enabled');
const environment = {
  PATH: '/usr/bin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
  HOME: home,
  XDG_RUNTIME_DIR: '/run/user/1000',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
};
const start = spawnSync('/usr/bin/systemctl', ['--user', 'start', 'nanoclaw-cos-backup-upload.service'], {
  cwd: settings.installationRoot,
  env: environment,
  encoding: 'utf8',
  timeout: 60000,
  maxBuffer: 16384,
});
assert.equal(start.error, undefined);
assert.equal(start.signal, null);
assert.notEqual(start.status, 0);
const observed = spawnSync(
  '/usr/bin/systemctl',
  ['--user', 'show', 'nanoclaw-cos-backup-upload.service', '--property=MainPID,Result,ExecMainStatus'],
  { env: environment, encoding: 'utf8', timeout: 10000, maxBuffer: 16384 },
);
assert.equal(observed.status, 0);
assert.match(observed.stdout, /^MainPID=0$/m);
assert.match(observed.stdout, /^Result=exit-code$/m);
assert.match(observed.stdout, /^ExecMainStatus=1$/m);
current = false;
await assert.rejects(installer.activate(), /^Error: backup_job_installation_unavailable$/);
assert(!(await createBackupJobManagerControls(settings, async () => {}).inspectManager()).timersRunning);
assert.equal(fs.readFileSync(units + '/unrelated.service', 'utf8'), '[Service]\nExecStart=/usr/bin/true\n');
console.log(
  JSON.stringify({
    contract: 'cos-g02-backup-job-release-fixture/v1',
    status: 'passed',
    cases: 7,
    sealedSourceCommit: source.commit,
    sealedSourceTree: source.tree,
    backupArtifact,
    actualUserManager: true,
    actualStaticCompiler: true,
    actualEnablementLinks: 2,
    actualTimerActivation: true,
    actualTimerStop: true,
    idempotentFiles: true,
    withdrawnScopeDenied: true,
    compiledProductionInstallerAndAdapter: true,
    actualScheduledEntryFailsClosed: true,
    unrelatedUnitPreserved: true,
    syntheticReleaseAuthority: true,
    installedOwnerCommandAcceptance: false,
    actualScheduledCapture: false,
    actualRemoteUpload: false,
    ownerCredentialsUsed: false,
    finalArtifact: false,
    proofs,
  }),
);
