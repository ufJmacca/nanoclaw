import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createBackupJobInstaller } from '/code/modules/chief-of-staff/ops/backup-job-install.js';
import { createBackupJobManagerControls } from '/code/modules/chief-of-staff/ops/backup-job-install-effects.js';
import { readPrivate } from '/code/modules/chief-of-staff/ops/target-state.js';
process.umask(0o077);
assert.equal(process.getuid(), 1000);
const home = '/home/fixture', config = home + '/.config/nanoclaw-cos', units = home + '/.config/systemd/user';
const settings = {
  version: 1, target: 'pi', sshAlias: 'fixture', hostFingerprint: 'a'.repeat(64), databaseFingerprint: 'b'.repeat(64),
  service: 'fixture-native.service', userHome: home, installationRoot: home + '/app', dataRoot: home + '/app/data',
  stateRoot: home + '/state', releaseRoot: home + '/releases', stagingRoot: home + '/staging', sourceRoot: home + '/sources',
  runtimeEnvironment: home + '/.config/runtime', migrationEnvironment: home + '/.config/migration',
};
for (const root of [config, units, settings.stateRoot, settings.installationRoot]) fs.mkdirSync(root, {recursive: true, mode: 0o700});
const manifest = JSON.parse(fs.readFileSync('/fixture/manifest.json', 'utf8'));
// Supply the real retained entry/executable paths for static verification. These
// are sealed copies of the compiled schedule entry. There is no target, vault,
// database or credential profile in this fixture; that entry must fail closed.
const payload = settings.releaseRoot + '/' + manifest.releaseId + '/payload';
fs.mkdirSync(payload + '/node/bin', {recursive: true, mode: 0o700});
fs.symlinkSync('/usr/local/bin/node', payload + '/node/bin/node');
fs.symlinkSync('/code', payload + '/dist');
fs.writeFileSync(units + '/unrelated.service', '[Service]\nExecStart=/usr/bin/true\n', {mode: 0o600});
let current = true, proofs = 0;
const assertCurrent = async () => { proofs++; if (!current) throw Error('fixture_scope_closed'); };
const controls = createBackupJobManagerControls(settings, assertCurrent);
assert.deepEqual(await controls.inspectManager(), {owned:true,jobsIdle:true,timersActive:false,timersRunning:false,definitionsLoaded:false});
const installer = createBackupJobInstaller(settings, manifest, controls);
assert.equal((await installer.install()).status, 'backup_jobs_enabled');
const enabled = await controls.inspectManager();
assert(enabled.definitionsLoaded && enabled.jobsIdle && !enabled.timersRunning);
for (const name of ['nanoclaw-cos-backup-capture.timer', 'nanoclaw-cos-backup-upload.timer']) {
  const link = units + '/timers.target.wants/' + name;
  assert(fs.lstatSync(link).isSymbolicLink());
  assert([units + '/' + name, '../' + name].includes(fs.readlinkSync(link)));
}
assert.equal((await installer.activate()).status, 'backup_jobs_active');
assert((await controls.inspectManager()).timersActive);
await controls.stopTimers();
assert(!(await controls.inspectManager()).timersRunning);
const upload = units + '/nanoclaw-cos-backup-upload.service', inode = fs.statSync(upload).ino;
await installer.install();
assert.equal(fs.statSync(upload).ino, inode);
assert.equal(readPrivate(settings.stateRoot + '/backup-job-installation.json').phase, 'enabled');
current = false;
await assert.rejects(installer.activate(), /^Error: backup_job_installation_unavailable$/);
assert(!(await createBackupJobManagerControls(settings, async () => {}).inspectManager()).timersRunning);
assert.equal(fs.readFileSync(units + '/unrelated.service', 'utf8'), '[Service]\nExecStart=/usr/bin/true\n');
console.log(JSON.stringify({contract:'cos-g02-backup-job-manager-fixture/v1',status:'passed',cases:6,
  actualUserManager:true,actualStaticCompiler:true,actualEnablementLinks:2,actualTimerActivation:true,actualTimerStop:true,
  idempotentFiles:true,withdrawnScopeDenied:true,compiledProductionInstallerAndAdapter:true,syntheticReleaseAuthority:true,
  installedOwnerCommandAcceptance:false,actualScheduledCapture:false,actualRemoteUpload:false,ownerCredentialsUsed:false,
  finalArtifact:false,proofs}));
