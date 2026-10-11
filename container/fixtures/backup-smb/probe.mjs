import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve4 } from 'node:dns/promises';
import { backupNasMountCommand } from '/release/dist/modules/chief-of-staff/ops/backup-nas-units.js';
import { verifySignedBackupMount } from '/release/dist/modules/chief-of-staff/ops/backup-policy.js';
import { withSignedBackupRepository } from '/release/dist/modules/chief-of-staff/ops/backup-nas-access.js';
import {
  withVerifiedResticBinary,
  verifyResticRepositoryIdentity,
} from '/release/dist/modules/chief-of-staff/ops/restic-artifact.js';

process.umask(0o077);
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'arm64');
// Docker resolves only the fixed server alias on this fixture's owned internal network.
// No endpoint or credential selector is accepted from a caller or environment.
const addresses = await resolve4('cos-backup-smb-server');
assert.equal(addresses.length, 1);
const host = addresses[0],
  mount = '/var/lib/nanoclaw-cos/nas';
backupNasMountCommand({ host, userId: 1000, groupId: 1000 });
const binding = Object.freeze({ host, share: 'nanoclaw-cos-backups', mount });
const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'Australia/Sydney' };
const binary = '/release/libexec/restic';
const ram = '/run/fixture';
const canary = 'COS_G02_SIGNED_SMB_ENCRYPTION_CANARY_997dbc41';
let phase = 'admission';
const kernelMount = () =>
  execFileSync('/usr/bin/findmnt', ['--json', '--mountpoint', mount, '--output', 'TARGET,SOURCE,FSTYPE,OPTIONS,ID'], {
    env,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 262144,
  });

async function owner() {
  phase = 'owner_admission';
  assert.equal(process.getuid(), 1000);
  assert.equal(process.getgid(), 1000);
  assert.deepEqual(process.getgroups(), [1000]);
  assert.equal(fs.statfsSync(ram, { bigint: true }).type, 0x01021994n);
  fs.mkdirSync(mount + '/restic', { mode: 0o700 });
  const password = ram + '/owner/password';
  fs.writeFileSync(password, 'public-synthetic-restic-fixture-password\n', { mode: 0o600 });
  const passwordFd = fs.openSync(password, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const restore = ram + '/owner/restore';
  fs.mkdirSync(restore, { mode: 0o700 });
  try {
    phase = 'pinned_executable';
    await withVerifiedResticBinary(binary, async (executable) => {
      let released;
      phase = 'signed_repository';
      await withSignedBackupRepository(binding, async (repository) => {
        released = repository;
        const run = (operation, input) => {
          executable.assertCurrent();
          repository.assertCurrent();
          const out = execFileSync(
            '/proc/self/fd/3',
            ['--repo', '/proc/self/fd/5', '--password-file', '/proc/self/fd/4', '--no-cache', '--json', ...operation],
            {
              cwd: ram + '/owner',
              env,
              input,
              encoding: 'utf8',
              timeout: 45000,
              maxBuffer: 1048576,
              stdio: ['pipe', 'pipe', 'pipe', executable.fd, passwordFd, repository.fd],
            },
          );
          executable.assertCurrent();
          repository.assertCurrent();
          return out;
        };
        phase = 'encrypted_repository_initialization';
        const initialized = JSON.parse(run(['init', '--repository-version', '2']));
        assert.match(initialized.id, /^[a-f0-9]{64}$/);
        const config = run(['cat', 'config']);
        verifyResticRepositoryIdentity(config, initialized.id);
        phase = 'encrypted_backup';
        const output = run(
          [
            'backup',
            '--stdin',
            '--stdin-filename',
            'checkpoint.json',
            '--host',
            'synthetic-g02-owner',
            '--tag',
            'kind:state',
          ],
          Buffer.from(canary + '\n'),
        );
        const summary = output
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .find((value) => value.message_type === 'summary');
        assert.match(summary.snapshot_id, /^[a-f0-9]{8,64}$/);
        const snapshots = JSON.parse(run(['snapshots']));
        assert.equal(snapshots.length, 1);
        assert.equal(snapshots[0].hostname, 'synthetic-g02-owner');
        phase = 'repository_integrity';
        run(['check', '--read-data']);
        phase = 'isolated_restore';
        run(['restore', snapshots[0].id, '--target', restore]);
        assert.equal(fs.readFileSync(restore + '/checkpoint.json', 'utf8'), canary + '\n');
        assert.deepEqual(
          JSON.parse(run(['snapshots'])).map((value) => value.id),
          snapshots.map((value) => value.id),
        );
      });
      phase = 'released_lease_refusal';
      assert.throws(() => released.assertCurrent(), /^Error: backup_repository_mount_unverified$/);
    });
  } finally {
    fs.closeSync(passwordFd);
    fs.rmSync(password);
  }
}

async function root() {
  phase = 'root_admission';
  assert.equal(process.getuid(), 0);
  assert.equal(process.argv.length, 2);
  assert.equal(fs.statfsSync(ram, { bigint: true }).type, 0x01021994n);
  fs.mkdirSync('/var/lib/nanoclaw-cos', { recursive: true, mode: 0o711 });
  fs.chmodSync('/var/lib/nanoclaw-cos', 0o711);
  fs.mkdirSync(mount, { mode: 0 });
  fs.mkdirSync(ram + '/owner', { mode: 0o700 });
  fs.chownSync(ram + '/owner', 1000, 1000);
  fs.chmodSync(ram, 0o711);
  const credentials = ram + '/smb-credentials';
  fs.writeFileSync(credentials, 'username=nanoclaw-cos-backup\npassword=public-synthetic-smb-fixture-password\n', {
    mode: 0o600,
  });
  const fd = fs.openSync(credentials, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const command = backupNasMountCommand({ host, userId: 1000, groupId: 1000 });
  let mounted = false;
  try {
    phase = 'unrelated_share_refusal';
    const denied = ram + '/denied';
    fs.mkdirSync(denied, { mode: 0 });
    const deniedResult = spawnSync(
      command.command,
      ['//' + host + '/unrelated-denied', denied, '-o', command.args[3]],
      { env, timeout: 15000, stdio: ['ignore', 'ignore', 'ignore', fd] },
    );
    assert.equal(deniedResult.signal, null);
    assert(!deniedResult.error);
    assert.notEqual(deniedResult.status, 0);
    assert.equal(fs.readdirSync(denied).length, 0);
    phase = 'signed_mount';
    const result = spawnSync(command.command, command.args, {
      env,
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe', fd],
    });
    assert.equal(result.signal, null);
    assert(!result.error);
    assert.equal(result.status, 0, 'signed_cifs_mount_failed');
    mounted = true;
    phase = 'kernel_mount_proof';
    const proof = verifySignedBackupMount(binding, kernelMount());
    assert.equal(proof.protocol, 'SMB2.1');
    assert.equal(proof.signing, 'required');
    phase = 'owner_transport';
    const child = spawnSync(process.execPath, ['/fixture/probe.mjs', '--owner'], {
      cwd: '/',
      env,
      uid: 1000,
      gid: 1000,
      timeout: 180000,
      maxBuffer: 65536,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(child.signal, null);
    assert(!child.error);
    const diagnostic = child.stderr?.toString('utf8').trim();
    if (diagnostic && /^signed_smb_fixture_failed:[a-z_]+$/.test(diagnostic)) console.error(diagnostic);
    assert.equal(child.status, 0, 'signed_cifs_owner_checks_failed');
    phase = 'owned_mount_closure';
    execFileSync('/usr/bin/umount', [mount], { env, timeout: 10000, stdio: 'ignore' });
    mounted = false;
    assert.equal(fs.lstatSync(mount).mode & 0o777, 0);
    assert.deepEqual(fs.readdirSync(mount), []);
    phase = 'closed_underlay_refusal';
    await assert.rejects(
      withSignedBackupRepository(binding, async () => {
        throw Error('closed_underlay_was_admitted');
      }),
      /^Error: backup_repository_mount_unverified$/,
    );
    console.log(
      JSON.stringify({
        contract: 'cos-g02-signed-smb-fixture/v1',
        status: 'passed',
        cases: 8,
        actualKernelCifs: true,
        protocol: 'SMB2.1',
        signing: 'required',
        dedicatedNonAdminAccount: true,
        unrelatedShareDenied: true,
        actualPinnedRestic: true,
        actualEncryptedRepositoryV2: true,
        actualReadDataCheck: true,
        actualIsolatedRamRestore: true,
        releasedLeaseDenied: true,
        closedUnderlayDenied: true,
        compiledHostCode: true,
        ownerCredentialsUsed: false,
        liveNasAcceptance: false,
        capacityAcceptance: false,
        finalArtifact: false,
      }),
    );
  } finally {
    if (mounted)
      try {
        execFileSync('/usr/bin/umount', [mount], { env, timeout: 10000, stdio: 'ignore' });
      } catch {}
    fs.closeSync(fd);
    fs.rmSync(credentials);
  }
}

try {
  if (process.argv.length === 3 && process.argv[2] === '--owner') await owner();
  else await root();
} catch {
  console.error('signed_smb_fixture_failed:' + phase);
  process.exitCode = 1;
}
