import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { allocateVaultFile, inspectVaultAllocation } from '/code/modules/chief-of-staff/ops/vault-allocation.js';
import { createVaultCrypto } from '/code/modules/chief-of-staff/ops/vault-crypto.js';
import { createVaultKey, inspectVaultKey } from '/code/modules/chief-of-staff/ops/vault-key.js';
import { verifyVaultMemory } from '/code/modules/chief-of-staff/ops/vault-memory.js';
const mapping = `cos-vault-fixture-${randomUUID()}`;
const paths = {
  stateRoot: '/case/control',
  volume: '/case/vault.luks',
  bootKey: '/case/keys/vault.key',
  mapper: mapping,
};
let recovery,
  crypto,
  mounted = false,
  bound = false,
  race;
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
function mount() {
  metadata();
  run('/usr/bin/mount', ['-t', 'ext4', '-o', 'nosuid,nodev,noexec', '/dev/mapper/' + mapping, '/case/vault']);
  mounted = true;
  run('/usr/bin/mount', ['-o', 'bind,nosuid,nodev,noexec', '/case/vault/google/calendar', '/case/target/calendar']);
  bound = true;
}
try {
  assert.equal(process.getuid(), 0);
  assert.equal(process.arch, 'arm64');
  assert.equal(process.env.NANOCLAW_COS_VAULT_FIXTURE, '1');
  verifyVaultMemory();
  assert.equal(fs.existsSync('/case'), false);
  assert.equal(fs.existsSync('/dev/mapper/' + mapping), false);
  privateDirectory('/case', 0, 0o711);
  for (const directory of ['control', 'keys']) privateDirectory('/case/' + directory);
  for (const directory of ['target', 'application', 'data']) privateDirectory('/case/' + directory, 1000);
  const authority = JSON.parse(run(process.execPath, ['/probe/probe-authority.mjs', 'root']));
  assert.equal(authority.rootAuthority, 'passed');
  console.log(JSON.stringify(authority));
  privateDirectory('/case/vault', 0, 0);
  privateDirectory('/case/target/calendar', 0, 0);
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
  await createVaultKey(paths, identity, { assertAuthority: async () => {}, assertMemory: verifyVaultMemory });
  assert.equal(inspectVaultKey(paths, identity), 'matching');
  await allocateVaultFile(paths, identity, { assertAuthority: async () => {}, assertMemory: verifyVaultMemory });
  assert.equal(inspectVaultAllocation(paths, identity), 'matching');
  crypto = createVaultCrypto(paths, identity, {
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
      return { status: result.status, output: result.stdout ?? '' };
    },
  });
  console.log('{"stage":"format"}');
  crypto.format();
  crypto.addRecovery(recovery);
  crypto.addRecovery(recovery);
  assert.equal(crypto.recoveryStatus(recovery), 'matching');
  console.log('{"stage":"open"}');
  crypto.open();
  console.log('{"stage":"filesystem"}');
  crypto.formatFilesystem();
  assert.equal(crypto.filesystemStatus(), 'matching');
  assert.throws(() => crypto.formatFilesystem(), /vault_crypto_unavailable/);
  metadata();
  run('/usr/bin/mount', ['-t', 'ext4', '-o', 'nosuid,nodev,noexec', '/dev/mapper/' + mapping, '/case/vault']);
  mounted = true;
  fs.chmodSync('/case/vault', 0o700);
  fs.chownSync('/case/vault', 1000, 1000);
  for (const area of [
    'google',
    'google/calendar',
    'backup-credentials',
    'journals',
    'staging',
    'cache',
    'calendar-backups',
  ])
    privateDirectory('/case/vault/' + area, 1000);
  run('/usr/bin/mount', ['-o', 'bind,nosuid,nodev,noexec', '/case/vault/google/calendar', '/case/target/calendar']);
  bound = true;
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
  for (let attempt = 0; attempt < 200 && !fs.existsSync('/case/target/race-request'); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync('/case/target/race-request'), true);
  run('/usr/bin/umount', ['/case/target/calendar']);
  bound = false;
  run('/usr/bin/umount', ['-l', '/case/vault']);
  mounted = false;
  fs.writeFileSync('/case/target/race-closed', 'synthetic', { mode: 0o600 });
  fs.chownSync('/case/target/race-closed', 1000, 1000);
  await exited;
  race = undefined;
  assert.deepEqual(fs.readdirSync('/case/vault'), []);
  assert.deepEqual(fs.readdirSync('/case/target/calendar'), []);
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
  mount();
  owner('recovery');
  run('/usr/bin/umount', ['/case/target/calendar']);
  bound = false;
  run('/usr/bin/umount', ['/case/vault']);
  mounted = false;
  owner('unavailable');
  assert.deepEqual(fs.readdirSync('/case/vault'), []);
  assert.deepEqual(fs.readdirSync('/case/target/calendar'), []);
  console.log(
    '{"kernelVault":"passed","volumeBytes":1073741824,"wrongKeyDenied":true,"recoveredCanary":true,"bootKeyRemoved":true,"ownershipDenied":true,"symlinkDenied":true,"mountRaceDenied":true,"memoryProtection":"verified","plaintextFallback":false,"allocationAdapter":"passed","cryptsetupAdapter":"passed","recoveryKeyOnDisk":false}',
  );
} catch {
  console.error('{"code":"vault_provision_fixture_unavailable"}');
  process.exitCode = 1;
} finally {
  recovery?.fill(0);
  if (race) race.kill();
  try {
    if (bound) run('/usr/bin/umount', ['/case/target/calendar']);
    if (mounted) run('/usr/bin/umount', ['/case/vault']);
    if (crypto) crypto.close();
  } catch {
    console.error('{"code":"vault_fixture_cleanup_unavailable"}');
    process.exitCode = 1;
  }
}
