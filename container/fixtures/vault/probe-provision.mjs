import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { inspectVaultAllocation } from '/code/modules/chief-of-staff/ops/vault-allocation.js';
import { createVaultCrypto } from '/code/modules/chief-of-staff/ops/vault-crypto.js';
import { inspectVaultKey } from '/code/modules/chief-of-staff/ops/vault-key.js';
import { installVaultUtilities, vaultUtilitiesStatus } from '/code/modules/chief-of-staff/ops/vault-utilities.js';
import { verifyVaultMemory } from '/code/modules/chief-of-staff/ops/vault-memory.js';
import { createVaultMounts } from '/code/modules/chief-of-staff/ops/vault-mounts.js';
import { createVaultRootEffects } from '/code/modules/chief-of-staff/ops/vault-root-effects.js';
import { provisionVault } from '/code/modules/chief-of-staff/ops/vault-provision.js';
import { vaultUnits } from '/code/modules/chief-of-staff/ops/vault-units.js';
import { checkVaultAuthority } from '/code/modules/chief-of-staff/ops/vault-authority.js';
import { runtimeTestMessages, writeRuntimeTestMessage } from '/code/modules/chief-of-staff/ops/runtime-test-wire.js';
const mapping = `cos-vault-fixture-${randomUUID()}`;
const paths = {
  stateRoot: '/case/control',
  volume: '/case/vault.luks',
  bootKey: '/case/keys/vault.key',
  mapper: mapping,
};
let recovery,
  crypto,
  mounts,
  mounted = false,
  bound = false,
  race,
  authorityChild,
  authorityMessages,
  authorityExited,
  rootPorts;
let assertRootAuthority;
async function provisionRoot(identity, cryptoControls) {
  authorityChild = spawn(
    '/usr/bin/setpriv',
    [
      '--reuid=1000',
      '--regid=1000',
      '--clear-groups',
      process.execPath,
      '/probe/probe-authority.mjs',
      'owner',
      identity.operationId,
    ],
    {
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', NANOCLAW_COS_VAULT_FIXTURE: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 600000,
    },
  );
  authorityExited = new Promise((resolve, reject) => {
    authorityChild.once('error', reject);
    authorityChild.once('exit', (code, signal) =>
      code === 0 && !signal ? resolve() : reject(Error('root authority fixture unavailable')),
    );
  });
  authorityExited.catch(() => {});
  authorityMessages = runtimeTestMessages(authorityChild.stdout);
  const first = await authorityMessages.next();
  assert.equal(first.done, false);
  const grant = first.value;
  assert.equal(grant.scope.operationId, identity.operationId);
  assert.equal(grant.scope.targetDigest, identity.targetDigest);
  assertRootAuthority = () => checkVaultAuthority(grant, grant.scope, 1000);
  await assertRootAuthority();
  const input = {
    userId: 1000,
    groupId: 1000,
    service: 'nanoclaw-fixture.service',
    calendarRoot: '/home/fixture/.config/nanoclaw-cos/state/calendar',
  };
  const names = Object.keys(vaultUnits(input)).filter((name) => name !== 'owner-service.conf');
  let enabled = false;
  rootPorts = createVaultRootEffects(
    {
      ...paths,
      vaultRoot: '/case/vault',
      calendarRoot: input.calendarRoot,
      systemUnits: '/case/system',
      ownerUnits: '/case/owner-units',
    },
    identity,
    input,
    recovery,
    {
      assertAuthority: assertRootAuthority,
      assertMemory: verifyVaultMemory,
      crypto: cryptoControls,
      units: {
        run(tool, args) {
          // No systemd manager in this fixture. The compiler and file effects are real; activation is a target gate.
          if (tool === '/usr/bin/systemctl') {
            if (args[0] === 'is-enabled')
              return {
                status: enabled ? 0 : 1,
                output: names.map(() => (enabled ? 'enabled\n' : 'disabled\n')).join(''),
              };
            if (args[0] === 'daemon-reload') return { status: 0, output: '' };
            assert.deepEqual(args, ['enable', '--no-reload', ...names]);
            fs.mkdirSync('/case/system/multi-user.target.wants', { mode: 0o755 });
            for (const name of names) fs.symlinkSync('../' + name, '/case/system/multi-user.target.wants/' + name);
            enabled = true;
            return { status: 0, output: '' };
          }
          return { status: 0, output: run(tool, args) };
        },
      },
    },
  );
  console.log('{"stage":"root_orchestration"}');
  const write = rootPorts.writeJournal;
  rootPorts.writeJournal = (record) => {
    write(record);
    console.log(JSON.stringify({ step: record.step, phase: record.phase }));
  };
  try {
    assert.equal((await provisionVault(identity, rootPorts)).status, 'ready');
    assert.equal((await provisionVault(identity, rootPorts)).status, 'ready');
    assert.equal(fs.existsSync(paths.stateRoot + '/deploy.lock'), false);
    assert.equal(JSON.parse(fs.readFileSync(paths.stateRoot + '/provision.json', 'utf8')).phase, 'complete');
    console.log('{"rootOrchestration":"passed","managerActivation":"modeled","targetLeases":"not_exercised"}');
  } finally {
    const result = spawnSync('/usr/bin/findmnt', ['--noheadings', '--mountpoint', '/case/vault']);
    mounted = result.status === 0;
    bound = spawnSync('/usr/bin/findmnt', ['--noheadings', '--mountpoint', input.calendarRoot]).status === 0;
  }
}
function run(tool, args) {
  verifyVaultMemory();
  const result = spawnSync(tool, args, {
    cwd: '/',
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C', NANOCLAW_COS_VAULT_FIXTURE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30000,
    maxBuffer: 262144,
  });
  if (result.error || result.signal || result.status !== 0) throw Error('fixture utility unavailable');
  verifyVaultMemory();
  return result.stdout;
}
function owner(mode) {
  run('/usr/bin/setpriv', [
    '--reuid=1000',
    '--regid=1000',
    '--clear-groups',
    process.execPath,
    '/probe/probe.mjs',
    mode,
  ]);
}
function privateDirectory(directory, uid = 0, mode = 0o700) {
  fs.mkdirSync(directory, { mode });
  fs.chmodSync(directory, mode);
  fs.chownSync(directory, uid, uid);
}
function deviceNode() {
  const minor = run('/usr/sbin/dmsetup', ['info', '-c', '--noheadings', '-o', 'minor', mapping]).trim();
  assert.match(minor, /^[0-9]+$/);
  if (!fs.existsSync('/dev/dm-' + minor)) run('/usr/bin/mknod', ['-m', '0600', '/dev/dm-' + minor, 'b', '253', minor]);
  fs.chmodSync('/dev/mapper', 0o755);
  return minor;
}
function metadata() {
  const minor = deviceNode();
  const uuid = run('/usr/sbin/blkid', [
    '--probe',
    '--match-tag',
    'UUID',
    '--output',
    'value',
    '/dev/mapper/' + mapping,
  ]).trim();
  assert.match(uuid, /^[a-f0-9-]{36}$/);
  fs.mkdirSync('/run/udev/data', { recursive: true });
  fs.chmodSync('/run/udev', 0o755);
  fs.chmodSync('/run/udev/data', 0o755);
  const file = '/run/udev/data/b253:' + minor;
  fs.writeFileSync(file, `I:1\nE:ID_FS_UUID=${uuid}\nE:ID_FS_UUID_ENC=${uuid}\nE:ID_FS_TYPE=ext4\n`, { mode: 0o644 });
  fs.chmodSync(file, 0o644);
}
async function mount() {
  metadata();
  console.log(JSON.stringify({ stage: 'mount_adapter', status: mounts.inspect() }));
  try {
    await mounts.mount();
  } finally {
    const number = crypto.withMappedDevice((fd) => BigInt(fs.fstatSync(fd).rdev));
    const major = ((number >> 8n) & 0xfffn) | ((number >> 32n) & 0xfffff000n),
      minor = (number & 0xffn) | ((number >> 12n) & 0xffffff00n);
    const ownsMount = (directory, fsroot) => {
      const result = spawnSync(
        '/usr/bin/findmnt',
        ['--json', '--mountpoint', directory, '--output', 'TARGET,FSROOT,MAJ:MIN'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 262144 },
      );
      if (result.status === 1 && !result.stdout.trim()) return false;
      assert.equal(result.status, 0);
      const files = JSON.parse(result.stdout).filesystems;
      assert.equal(files.length, 1);
      assert.equal(files[0].target, directory);
      assert.equal(files[0].fsroot, fsroot);
      assert.equal(files[0]['maj:min'], `${major}:${minor}`);
      return true;
    };
    mounted = ownsMount('/case/vault', '/');
    bound = ownsMount('/home/fixture/.config/nanoclaw-cos/state/calendar', '/google/calendar');
  }
  assert.equal(mounts.inspect(), 'matching');
}
try {
  assert.equal(process.getuid(), 0);
  assert.equal(process.arch, 'arm64');
  assert.equal(process.env.NANOCLAW_COS_VAULT_FIXTURE, '1');
  verifyVaultMemory();
  // Remove only this disposable image's utility, then reinstall its cached pinned package offline.
  run('/usr/bin/dpkg', ['--remove', 'cryptsetup-bin']);
  const utilityControls = { assertAuthority: async () => {}, assertMemory: verifyVaultMemory };
  assert.equal(vaultUtilitiesStatus(utilityControls), 'absent');
  await installVaultUtilities(utilityControls);
  assert.equal(vaultUtilitiesStatus(utilityControls), 'matching');
  await installVaultUtilities(utilityControls);
  console.log('{"rootUtilityInstallation":"passed","offline":true,"unrelatedPackageUpgrade":false}');
  const units = JSON.parse(run(process.execPath, ['/probe/verify-units.mjs']));
  assert.equal(units.systemdUnitVerification, 'passed');
  console.log(JSON.stringify(units));
  assert.equal(fs.existsSync('/case'), false);
  assert.equal(fs.existsSync('/dev/mapper/' + mapping), false);
  privateDirectory('/case', 0, 0o711);
  for (const directory of ['control', 'keys']) privateDirectory('/case/' + directory);
  for (const directory of ['application', 'data']) privateDirectory('/case/' + directory, 1000);
  for (const directory of [
    '/home/fixture',
    '/home/fixture/.config',
    '/home/fixture/.config/nanoclaw-cos',
    '/home/fixture/.config/nanoclaw-cos/state',
  ])
    privateDirectory(directory, 1000);
  privateDirectory('/case/system');
  privateDirectory('/case/owner-units', 1000);
  const authority = JSON.parse(run(process.execPath, ['/probe/probe-authority.mjs', 'root']));
  assert.equal(authority.rootAuthority, 'passed');
  console.log(JSON.stringify(authority));
  if (process.env.NANOCLAW_COS_VAULT_KEYCHAIN_FIXTURE === '1') {
    const chunks = [];
    let length = 0;
    try {
      for await (const chunk of process.stdin) {
        length += chunk.length;
        chunks.push(chunk);
        if (length > 64) throw Error('invalid fixture key');
      }
      assert.equal(length, 64);
      recovery = Buffer.concat(chunks);
    } finally {
      for (const chunk of chunks) chunk.fill(0);
    }
  } else recovery = randomBytes(64);
  const identity = {
    operationId: randomUUID(),
    targetDigest: 'a'.repeat(64),
    recoveryReference: randomUUID(),
    luksUuid: randomUUID(),
    filesystemUuid: randomUUID(),
  };
  const cryptoControls = {
    assertMemory: verifyVaultMemory,
    disableKeyring: true,
    run(tool, args, volumeFd, keyFd, input) {
      const result = spawnSync(tool, args, {
        cwd: '/',
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
        input,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore', volumeFd, keyFd ?? 'ignore'],
        timeout: 120000,
        maxBuffer: 262144,
      });
      if (result.error || result.signal || result.status === null) throw Error('fixture crypto unavailable');
      // Docker has no udev daemon; publish the real device node before the adapter inspects it.
      if (result.status === 0 && args[0] === 'open' && !args.includes('--test-passphrase')) {
        deviceNode();
        const stat = fs.statSync('/dev/mapper/' + mapping);
        const device = BigInt(stat.rdev),
          major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n),
          minor = (device & 0xffn) | ((device >> 12n) & 0xffffff00n);
        const root = fs.realpathSync(`/sys/dev/block/${major}:${minor}`),
          slaves = fs.readdirSync(root + '/slaves');
        console.log(
          JSON.stringify({
            stage: 'mapper_proof',
            fixtureMapper: mapping,
            ownerUid: stat.uid,
            mode: stat.mode & 0o777,
            blockDevice: stat.isBlockDevice(),
            uuidMatches:
              fs.readFileSync(root + '/dm/uuid', 'utf8').trim() ===
              `CRYPT-LUKS2-${identity.luksUuid.replace(/-/g, '')}-${mapping}`,
            oneLoopSlave: slaves.length === 1 && /^loop[0-9]+$/.test(slaves[0]),
            backingFileMatches:
              slaves.length === 1 &&
              fs.readFileSync(root + '/slaves/' + slaves[0] + '/loop/backing_file', 'utf8').trim() === paths.volume,
            allocation: inspectVaultAllocation(paths, identity),
          }),
        );
      }
      if (result.status === 0 && tool === '/usr/sbin/mkfs.ext4') metadata();
      return { status: result.status, output: result.stdout ?? '' };
    },
  };
  crypto = createVaultCrypto(paths, identity, cryptoControls);
  await provisionRoot(identity, cryptoControls);
  assert.equal(inspectVaultKey(paths, identity), 'matching');
  assert.equal(inspectVaultAllocation(paths, identity), 'matching');
  assert.equal(crypto.recoveryStatus(recovery), 'matching');
  assert.equal(crypto.filesystemStatus(), 'matching');
  assert.throws(() => crypto.formatFilesystem(), /vault_crypto_unavailable/);
  mounts = createVaultMounts(
    {
      stateRoot: paths.stateRoot,
      vaultRoot: '/case/vault',
      calendarRoot: '/home/fixture/.config/nanoclaw-cos/state/calendar',
    },
    identity,
    { uid: 1000, gid: 1000 },
    {
      assertAuthority: assertRootAuthority,
      assertMemory: verifyVaultMemory,
      assertFilesystem() {
        assert.equal(crypto.filesystemStatus(), 'matching');
      },
      withMappedDevice(operation) {
        return crypto.withMappedDevice((fd) => operation(fd, fs.fstatSync(fd).rdev));
      },
    },
  );
  assert.equal(mounts.inspect(), 'matching');
  await mount();
  await mount();
  owner('capture');
  fs.chmodSync('/case/vault/google', 0o755);
  owner('denied');
  fs.chmodSync('/case/vault/google', 0o700);
  fs.chownSync('/case/vault/backup-credentials', 0, 0);
  owner('denied');
  fs.chownSync('/case/vault/backup-credentials', 1000, 1000);
  fs.renameSync('/case/vault/cache', '/case/vault/cache-original');
  fs.symlinkSync('google', '/case/vault/cache');
  owner('denied');
  fs.unlinkSync('/case/vault/cache');
  fs.renameSync('/case/vault/cache-original', '/case/vault/cache');
  race = spawn(
    '/usr/bin/setpriv',
    ['--reuid=1000', '--regid=1000', '--clear-groups', process.execPath, '/probe/probe.mjs', 'race'],
    { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' }, stdio: ['ignore', 'ignore', 'ignore'], timeout: 15000 },
  );
  const exited = new Promise((resolve, reject) => {
    race.once('error', reject);
    race.once('exit', (code, signal) =>
      code === 0 && !signal ? resolve() : reject(Error('fixture race unavailable')),
    );
  });
  exited.catch(() => {});
  for (
    let attempt = 0;
    attempt < 200 && !fs.existsSync('/home/fixture/.config/nanoclaw-cos/state/race-request');
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync('/home/fixture/.config/nanoclaw-cos/state/race-request'), true);
  run('/usr/bin/umount', ['/home/fixture/.config/nanoclaw-cos/state/calendar']);
  bound = false;
  run('/usr/bin/umount', ['-l', '/case/vault']);
  mounted = false;
  fs.writeFileSync('/home/fixture/.config/nanoclaw-cos/state/race-closed', 'synthetic', { mode: 0o600 });
  fs.chownSync('/home/fixture/.config/nanoclaw-cos/state/race-closed', 1000, 1000);
  await exited;
  race = undefined;
  assert.deepEqual(fs.readdirSync('/case/vault'), []);
  assert.deepEqual(fs.readdirSync('/home/fixture/.config/nanoclaw-cos/state/calendar'), []);
  crypto.close();
  fs.unlinkSync(paths.bootKey);
  const wrong = randomBytes(64);
  try {
    assert.throws(() => crypto.open(wrong), /vault_crypto_unavailable/);
  } finally {
    wrong.fill(0);
  }
  console.log('{"stage":"independent_recovery"}');
  crypto.open(recovery);
  await mount();
  owner('recovery');
  run('/usr/bin/umount', ['/home/fixture/.config/nanoclaw-cos/state/calendar']);
  bound = false;
  run('/usr/bin/umount', ['/case/vault']);
  mounted = false;
  owner('unavailable');
  assert.deepEqual(fs.readdirSync('/case/vault'), []);
  assert.deepEqual(fs.readdirSync('/home/fixture/.config/nanoclaw-cos/state/calendar'), []);
  await writeRuntimeTestMessage(authorityChild.stdin, { action: 'deny' });
  assert.deepEqual((await authorityMessages.next()).value, { stage: 'denied' });
  await assert.rejects(rootPorts.assertAuthority(), /vault_authority_unavailable/);
  await writeRuntimeTestMessage(authorityChild.stdin, { action: 'close' });
  authorityChild.stdin.end();
  await authorityExited;
  console.log(
    '{"kernelVault":"passed","volumeBytes":1073741824,"wrongKeyDenied":true,"recoveredCanary":true,"bootKeyRemoved":true,"ownershipDenied":true,"symlinkDenied":true,"mountRaceDenied":true,"memoryProtection":"verified","plaintextFallback":false,"allocationAdapter":"passed","cryptsetupAdapter":"passed","mountAdapter":"passed","recoveryKeyOnDisk":false}',
  );
} catch {
  console.error('{"code":"vault_provision_fixture_unavailable"}');
  process.exitCode = 1;
} finally {
  recovery?.fill(0);
  if (race) race.kill();
  if (authorityChild && authorityChild.exitCode === null && authorityChild.signalCode === null) authorityChild.kill();
  try {
    if (bound) run('/usr/bin/umount', ['/home/fixture/.config/nanoclaw-cos/state/calendar']);
    if (mounted) run('/usr/bin/umount', ['/case/vault']);
    if (crypto) crypto.close();
  } catch {
    console.error('{"code":"vault_fixture_cleanup_unavailable"}');
    process.exitCode = 1;
  }
}
