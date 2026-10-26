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
const releaseSlice = process.env.COS_BACKUP_FIXTURE_SLICE;
assert(['G02', 'G03', 'G04', 'G05', 'G06'].includes(releaseSlice));
const drafts = releaseSlice === 'G05',
  reviews = releaseSlice === 'G06',
  upgrade = drafts || reviews || releaseSlice === 'G04';
const manifest = fixtureVaultRelease(releaseSlice);
manifest.releaseId = 'release-fixture-' + releaseSlice.toLowerCase();
assert.equal(manifest.postgres.minimum, reviews ? 21 : drafts ? 20 : releaseSlice === 'G04' ? 19 : 18);
assert.equal(manifest.postgres.maximum, manifest.postgres.minimum);
const payloadFor = (release) => settings.releaseRoot + '/' + release.releaseId + '/payload';
// The installed command runs actual retained files. A symlinked entry has a
// different argv path from its module URL and does not exercise its main route.
const preparePayload = (release) => {
  const payload = payloadFor(release);
  fs.mkdirSync(payload + '/node/bin', { recursive: true, mode: 0o700 });
  fs.copyFileSync('/release/node/bin/node', payload + '/node/bin/node');
  fs.cpSync('/release/dist', payload + '/dist', { recursive: true });
  fs.copyFileSync('/release/package.json', payload + '/package.json');
  fs.symlinkSync('/release/node_modules', payload + '/node_modules');
};
preparePayload(manifest);
fs.writeFileSync(units + '/unrelated.service', '[Service]\nExecStart=/usr/bin/true\n', { mode: 0o600 });
let current = true,
  proofs = 0;
const assertCurrent = async () => {
  proofs++;
  if (!current) throw Error('fixture_scope_closed');
};
const controls = createBackupJobManagerControls(settings, assertCurrent);
assert.deepEqual(await controls.inspectManager(), {
  owned: true,
  jobsIdle: true,
  timersActive: false,
  timersRunning: false,
  definitionsLoaded: false,
});
const installer = createBackupJobInstaller(settings, manifest, controls);
let priorSettings,
  actualG03ToG04Upgrade = false,
  actualG04ToG05Upgrade = false,
  actualG05ToG06Upgrade = false;
if (upgrade) {
  const prior = fixtureVaultRelease(reviews ? 'G05' : drafts ? 'G04' : 'G03');
  prior.releaseId = reviews
    ? 'release-fixture-prior-g05'
    : drafts
      ? 'release-fixture-prior-g04'
      : 'release-fixture-prior-g03';
  preparePayload(prior);
  const priorInstaller = createBackupJobInstaller(settings, prior, controls);
  await priorInstaller.install();
  await priorInstaller.activate();
  const priorManager = await controls.inspectManager();
  assert(priorManager.timersActive);
  assert(priorManager.timersRunning);
  assert(priorManager.jobsIdle);
  assert(
    fs
      .readFileSync(units + '/nanoclaw-cos-backup-upload.service', 'utf8')
      .includes('/' + prior.releaseId + '/payload/'),
  );
  priorSettings = fs.readFileSync(config + '/backup-jobs-target.json');
}
const first = await installer.install();
assert.equal(first.status, 'backup_jobs_enabled');
assert((await controls.inspectManager()).definitionsLoaded);
assert(!(await controls.inspectManager()).timersRunning);
assert((await controls.inspectManager()).jobsIdle);
if (upgrade) {
  assert(
    fs
      .readFileSync(units + '/nanoclaw-cos-backup-upload.service', 'utf8')
      .includes('/' + manifest.releaseId + '/payload/'),
  );
  assert.deepEqual(fs.readFileSync(config + '/backup-jobs-target.json'), priorSettings);
  assert.equal(readPrivate(settings.stateRoot + '/backup-job-installation.json').releaseId, manifest.releaseId);
  actualG03ToG04Upgrade = releaseSlice === 'G04';
  actualG04ToG05Upgrade = drafts;
  actualG05ToG06Upgrade = reviews;
}
for (const name of ['nanoclaw-cos-backup-capture.timer', 'nanoclaw-cos-backup-upload.timer']) {
  const link = units + '/timers.target.wants/' + name;
  assert(fs.lstatSync(link).isSymbolicLink());
  assert([units + '/' + name, '../' + name].includes(fs.readlinkSync(link)));
}
assert.equal((await installer.activate()).status, 'backup_jobs_active');
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
    contract: reviews
      ? 'cos-backup-job-release-fixture/v4'
      : drafts
        ? 'cos-backup-job-release-fixture/v3'
        : 'cos-backup-job-release-fixture/v2',
    status: 'passed',
    cases: upgrade ? 8 : 7,
    releaseSlice,
    schemaVersion: manifest.postgres.minimum,
    actualG03ToG04Upgrade,
    ...(drafts ? { actualG04ToG05Upgrade } : {}),
    ...(reviews ? { actualG05ToG06Upgrade } : {}),
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
