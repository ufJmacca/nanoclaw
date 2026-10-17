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
import { checkVaultRecovery } from '/code/modules/chief-of-staff/ops/vault-recovery.js';
import { vaultUnits } from '/code/modules/chief-of-staff/ops/vault-units.js';
import { checkVaultAuthority } from '/code/modules/chief-of-staff/ops/vault-authority.js';
import { runtimeTestMessages, writeRuntimeTestMessage } from '/code/modules/chief-of-staff/ops/runtime-test-wire.js';
import { writeVaultRootRequest } from '/code/modules/chief-of-staff/ops/vault-root-wire.js';
import { selectedFixtureEnvironment } from '/code/contracts/chief-of-staff/fixture-database.js';
const mapping = `cos-vault-fixture-${randomUUID()}`;
const paths = {
  stateRoot: '/case/control',
  volume: '/case/vault.luks',
  bootKey: '/case/keys/vault.key',
  mapper: mapping,
};
let recoveryOpens = 0;
let recovery,
  crypto,
  mounts,
  mounted = false,
  bound = false,
  race,
  mailRace,
  authorityChild,
  authorityMessages,
  authorityExited,
  rootPorts;
let assertRootAuthority;
async function provisionRoot(identity, cryptoControls) {
  let enabled = false,
    normalUnlockActive = false;
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
  assertRootAuthority = async () => {
    await checkVaultAuthority(grant, grant.scope, 1000);
    // Model BindsTo: normal mount units cannot remain mounted with their unlock service inactive.
    if (enabled && !normalUnlockActive) {
      const calendar = '/home/fixture/.config/nanoclaw-cos/state/calendar';
      if (spawnSync('/usr/bin/findmnt', ['--noheadings', '--mountpoint', calendar]).status === 0)
        run('/usr/bin/umount', [calendar]);
      bound = false;
      if (spawnSync('/usr/bin/findmnt', ['--noheadings', '--mountpoint', '/case/vault']).status === 0)
        run('/usr/bin/umount', ['/case/vault']);
      mounted = false;
    }
  };
  await assertRootAuthority();
  const input = {
    userId: 1000,
    groupId: 1000,
    service: 'nanoclaw-fixture.service',
    calendarRoot: '/home/fixture/.config/nanoclaw-cos/state/calendar',
  };
  const names = Object.keys(vaultUnits(input)).filter((name) => name !== 'owner-service.conf');
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
            if (args[0] === 'is-active') {
              const active = [
                normalUnlockActive,
                spawnSync('/usr/bin/findmnt', ['--noheadings', '--mountpoint', '/case/vault']).status === 0,
                spawnSync('/usr/bin/findmnt', ['--noheadings', '--mountpoint', input.calendarRoot]).status === 0,
              ];
              return {
                status: active.every(Boolean) ? 0 : 3,
                output: active.map((value) => (value ? 'active\n' : 'inactive\n')).join(''),
              };
            }
            if (args[0] === 'stop') {
              assert.deepEqual(args, ['stop', ...names]);
              if (spawnSync('/usr/bin/findmnt', ['--noheadings', '--mountpoint', input.calendarRoot]).status === 0)
                run('/usr/bin/umount', [input.calendarRoot]);
              bound = false;
              if (spawnSync('/usr/bin/findmnt', ['--noheadings', '--mountpoint', '/case/vault']).status === 0)
                run('/usr/bin/umount', ['/case/vault']);
              mounted = false;
              crypto.close();
              normalUnlockActive = false;
              return { status: 0, output: '' };
            }
            if (args[0] === 'start') {
              assert.deepEqual(args, ['start', ...names]);
              crypto.open();
              normalUnlockActive = true;
              metadata();
              run('/usr/bin/mount', [
                '-t',
                'ext4',
                '-o',
                'nosuid,nodev,noexec',
                '/dev/mapper/' + mapping,
                '/case/vault',
              ]);
              mounted = true;
              run('/usr/bin/mount', [
                '-o',
                'bind,nosuid,nodev,noexec',
                '/case/vault/google/calendar',
                input.calendarRoot,
              ]);
              bound = true;
              return { status: 0, output: '' };
            }
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
    const receiver = spawn(process.execPath, ['/probe/probe-wire.mjs'], {
      cwd: '/',
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', NANOCLAW_COS_VAULT_FIXTURE: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 15000,
    });
    const exited = new Promise((resolve, reject) => {
      receiver.once('error', reject);
      receiver.once('exit', (code, signal) =>
        code === 0 && !signal ? resolve() : reject(Error('wire fixture unavailable')),
      );
    });
    exited.catch(() => {});
    try {
      await writeVaultRootRequest(
        receiver.stdin,
        {
          contract: 'cos-vault-root-request/v1',
          configurationDigest: 'b'.repeat(64),
          identity,
          scope: grant.scope,
          authority: { socket: grant.socket, token: grant.token },
        },
        recovery,
      );
      receiver.stdin.end();
      const messages = [];
      for await (const message of runtimeTestMessages(receiver.stdout)) messages.push(message);
      await exited;
      assert.equal(messages.length, 1);
      assert.deepEqual(messages[0], {
        rootRecoveryWire: 'passed',
        liveOwnerProof: 'verified',
        realRecoverySlot: 'verified',
        recoveryKeyOnDisk: false,
      });
      console.log(JSON.stringify(messages[0]));
    } finally {
      if (receiver.exitCode === null && receiver.signalCode === null) receiver.kill();
    }
  } finally {
    const result = spawnSync('/usr/bin/findmnt', ['--noheadings', '--mountpoint', '/case/vault']);
    mounted = result.status === 0;
    bound = spawnSync('/usr/bin/findmnt', ['--noheadings', '--mountpoint', input.calendarRoot]).status === 0;
  }
}
function run(tool, args) {
  verifyVaultMemory();
  const fullCapture = args.includes('/probe/probe-backup-capture.compiled.mjs');
  const credentialJournal = args.includes('/probe/probe-backup-journal.mjs');
  const postgresCapture = args.includes('/probe/probe-backup-postgres.mjs');
  const mailCredential = args.includes('/probe/probe-mail.mjs');
  const mailRecovery = args.includes('/probe/probe-mail-recovery.mjs');
  const result = spawnSync(tool, args, {
    cwd: '/',
    env: {
      PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
      NANOCLAW_COS_VAULT_FIXTURE: '1',
      ...(postgresCapture || mailRecovery ? selectedFixtureEnvironment(process.env, true) : {}),
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', fullCapture || credentialJournal || mailCredential || mailRecovery ? 'pipe' : 'ignore'],
    timeout: postgresCapture || mailRecovery ? 300000 : credentialJournal ? 120000 : 30000,
    maxBuffer: mailRecovery ? 2 * 1024 ** 2 : 262144,
  });
  if (result.error || result.signal || result.status !== 0) {
    if (mailRecovery) {
      const file = '/home/fixture/.config/nanoclaw-cos/state/mail-recovery-stage.json';
      const stage = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).stage : 'module_initialization';
      assert.match(stage, /^[a-z_]{1,64}$/);
      console.log(
        JSON.stringify({
          mailRecoveryFailureStage: stage,
          code: result.error?.code === 'ETIMEDOUT' ? 'fixture_deadline' : 'fixture_process_failed',
          category: result.stderr?.match(/^Error: ([a-z_]{1,96})$/m)?.[1] ?? null,
          location: result.stderr?.match(/\/probe\/probe-mail-recovery\.mjs:[0-9]+:[0-9]+/)?.[0] ?? null,
        }),
      );
    }
    if (mailCredential) {
      const file = '/home/fixture/.config/nanoclaw-cos/state/mail-kernel-stage.json';
      const stage = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).stage : 'module_initialization';
      assert.match(stage, /^[a-z_]{1,64}$/);
      console.log(
        JSON.stringify({
          mailCredentialFailureStage: stage,
          code: result.error?.code === 'ETIMEDOUT' ? 'fixture_deadline' : 'fixture_process_failed',
          location: result.stderr?.match(/\/probe\/probe-mail\.mjs:[0-9]+:[0-9]+/)?.[0] ?? null,
        }),
      );
    }
    if (credentialJournal) {
      const file = '/home/fixture/.config/nanoclaw-cos/state/credential-journal-stage.json';
      const stage = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).stage : 'module_initialization';
      assert.match(stage, /^[a-z_]{1,64}$/);
      console.log(
        JSON.stringify({
          credentialJournalFailureStage: stage,
          code: result.error?.code === 'ETIMEDOUT' ? 'fixture_deadline' : 'fixture_process_failed',
          location: result.stderr?.match(/\/probe\/probe-backup-journal\.mjs:[0-9]+:[0-9]+/)?.[0] ?? null,
        }),
      );
    }
    if (fullCapture) {
      const file = '/home/fixture/.config/nanoclaw-cos/state/full-capture-stage.json';
      const stage = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).stage : 'module_initialization';
      assert.match(stage, /^[a-z_]{1,64}$/);
      console.log(
        JSON.stringify({
          fullCaptureFailureStage: stage,
          code: result.stderr?.match(/ERR_[A-Z_]+|target_vault_capture_unavailable/)?.[0] ?? 'fixture_process_failed',
          location: result.stderr?.match(/\/probe\/probe-backup-capture\.compiled\.mjs:[0-9]+:[0-9]+/)?.[0] ?? null,
        }),
      );
      for (const line of (result.stderr ?? '').split('\n').slice(0, 64)) {
        if (/^\{"captureDiagnosticModule":"[a-z-]+\.ts","code":"[a-z_]+"\}$/.test(line)) console.log(line);
        if (
          /^\{"captureNamePrefix":"vault-(?:backup-credentials|journals)","depth":[0-9]+,"bytes":[0-9]+,"leading":[0-9]+,"invalid":\[[0-9,]*\]\}$/.test(
            line,
          )
        )
          console.log(line);
      }
    }
    throw Error('fixture utility unavailable');
  }
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
function mailOwner(mode) {
  const text = run('/usr/bin/setpriv', [
    '--clear-groups',
    '--reuid=1000',
    '--regid=1000',
    '--bounding-set=-all',
    '--no-new-privs',
    '--',
    process.execPath,
    '/probe/probe-mail.mjs',
    mode,
  ]);
  const records = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(records.length > 0 && records.length <= 3);
  for (const record of records) console.log(JSON.stringify(record));
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
  if (process.env.NANOCLAW_COS_MAIL_RECOVERY_FIXTURE === '1') privateDirectory('/case/synthetic-nas', 1000);
  for (const directory of [
    '/home/fixture',
    '/home/fixture/.config',
    '/home/fixture/.config/nanoclaw-cos',
    '/home/fixture/.config/nanoclaw-cos/state',
  ])
    privateDirectory(directory, 1000);
  privateDirectory('/case/system');
  privateDirectory('/case/owner-units', 0, 0o755);
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
      if (args[0] === 'open' && !args.includes('--test-passphrase') && input) {
        assert.equal(keyFd, null);
        assert.equal(input.equals(recovery), true);
        recoveryOpens++;
      }
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
  if (process.env.NANOCLAW_COS_BACKUP_FIXTURE === '1') console.log('{"stage":"backup_vault_owner_capture"}');
  owner('capture');
  if (process.env.NANOCLAW_COS_MAIL_CREDENTIAL_FIXTURE === '1') mailOwner('install');
  if (
    process.env.NANOCLAW_COS_BACKUP_POSTGRES_FIXTURE === '1' &&
    process.env.NANOCLAW_COS_MAIL_RECOVERY_FIXTURE !== '1'
  ) {
    console.log('{"stage":"backup_encrypted_postgres_capture"}');
    const capture = JSON.parse(
      run('/usr/bin/setpriv', [
        '--clear-groups',
        '--reuid=1000',
        '--regid=1000',
        process.execPath,
        '/probe/probe-backup-postgres.mjs',
      ]),
    );
    assert.equal(capture.encryptedPostgresCapture, 'passed');
    console.log(JSON.stringify(capture));
  }
  if (process.env.NANOCLAW_COS_BACKUP_FIXTURE === '1') {
    console.log('{"stage":"backup_vault_credential_installation"}');
    run('/usr/bin/setpriv', [
      '--clear-groups',
      '--reuid=1000',
      '--regid=1000',
      process.execPath,
      '/probe/probe-backup-credentials.mjs',
      'install',
    ]);
    console.log('{"stage":"backup_vault_root_handoff"}');
    const backup = JSON.parse(run(process.execPath, ['/probe/probe-backup-credentials.mjs', 'root']));
    assert.equal(backup.backupVaultCredentialHandoff, 'passed');
    console.log(JSON.stringify(backup));
    const journal = JSON.parse(
      run('/usr/bin/setpriv', [
        '--clear-groups',
        '--reuid=1000',
        '--regid=1000',
        process.execPath,
        '/probe/probe-backup-journal.mjs',
      ]),
    );
    assert.equal(journal.encryptedCredentialJournal, 'passed');
    console.log(JSON.stringify(journal));
  }
  if (process.env.NANOCLAW_COS_FULL_CAPTURE_FIXTURE === '1') {
    const full = JSON.parse(
      run('/usr/bin/setpriv', [
        '--clear-groups',
        '--reuid=1000',
        '--regid=1000',
        process.execPath,
        '/probe/probe-backup-capture.compiled.mjs',
        'capture',
      ]),
    );
    assert.equal(full.encryptedFullCapture, 'passed');
    console.log(JSON.stringify(full));
  }
  const beforeRecovery = recoveryOpens;
  assert.equal((await checkVaultRecovery(identity, rootPorts)).status, 'ready');
  assert.equal(recoveryOpens, beforeRecovery + 1);
  assert.equal(
    fs.readdirSync(paths.stateRoot).some((name) => name.startsWith('recovery-')),
    false,
  );
  assert.equal(mounts.inspect(), 'matching');
  owner('recovery-before-race');
  console.log(
    '{"installedRecoveryWorkflow":"passed","recoveryMapperOpenedWithPipeOnly":true,"normalUnlockRestored":true,"unitManager":"modeled"}',
  );
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
  if (process.env.NANOCLAW_COS_MAIL_CREDENTIAL_FIXTURE === '1') {
    const state = '/home/fixture/.config/nanoclaw-cos/state',
      unrelated = '/case/unrelated-worker';
    fs.mkdirSync(unrelated, { mode: 0o700 });
    let mountedWorker = false,
      output = '';
    mailRace = spawn(
      '/usr/bin/setpriv',
      [
        '--clear-groups',
        '--reuid=1000',
        '--regid=1000',
        '--bounding-set=-all',
        '--no-new-privs',
        '--',
        process.execPath,
        '/probe/probe-mail.mjs',
        'unrelated-worker-mount',
      ],
      { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 },
    );
    mailRace.stdout.on('data', (bytes) => {
      output += bytes.toString('utf8');
      if (output.length > 8192) mailRace.kill();
    });
    mailRace.stderr.resume();
    const exited = new Promise((resolve, reject) => {
      mailRace.once('error', reject);
      mailRace.once('close', (code, signal) =>
        code === 0 && !signal ? resolve() : reject(Error('mail_worker_mount_fixture_unavailable')),
      );
    });
    exited.catch(() => {});
    const wait = async (name) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (fs.existsSync(state + '/' + name)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw Error('mail_worker_mount_handshake_unavailable');
    };
    const signal = (name) => {
      fs.writeFileSync(state + '/' + name, 'synthetic', { mode: 0o600, flag: 'wx' });
      fs.chownSync(state + '/' + name, 1000, 1000);
    };
    try {
      await wait('mail-worker-ready');
      run('/usr/bin/mount', ['-t', 'tmpfs', '-o', 'size=1m,nosuid,nodev,noexec', 'tmpfs', unrelated]);
      mountedWorker = true;
      signal('mail-worker-mounted');
      await wait('mail-worker-checked');
      run('/usr/bin/umount', [unrelated]);
      mountedWorker = false;
      signal('mail-worker-unmounted');
      await exited;
      const record = JSON.parse(output);
      assert.equal(record.mailVaultStage, 'unrelated_worker_mount');
      assert.equal(record.credentialsUsableMountedAndUnmounted, true);
      console.log(JSON.stringify(record));
    } finally {
      if (mountedWorker) run('/usr/bin/umount', [unrelated]);
      if (mailRace.exitCode === null) mailRace.kill();
    }
  }
  let mailExited;
  if (process.env.NANOCLAW_COS_MAIL_CREDENTIAL_FIXTURE === '1') {
    mailRace = spawn(
      '/usr/bin/setpriv',
      [
        '--clear-groups',
        '--reuid=1000',
        '--regid=1000',
        '--bounding-set=-all',
        '--no-new-privs',
        '--',
        process.execPath,
        '/probe/probe-mail.mjs',
        'mount-loss',
      ],
      { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 },
    );
    let output = '';
    mailRace.stdout.on('data', (bytes) => {
      output += bytes.toString('utf8');
      if (output.length > 8192) mailRace.kill();
    });
    mailRace.stderr.resume(); // Never forward credential or nested filesystem diagnostics.
    mailExited = new Promise((resolve, reject) => {
      mailRace.once('error', reject);
      mailRace.once('close', (code, signal) => {
        try {
          assert.equal(code, 0);
          assert.equal(signal, null);
          const record = JSON.parse(output);
          assert.equal(record.mailVaultStage, 'mount_loss');
          console.log(JSON.stringify(record));
          resolve();
        } catch {
          reject(Error('mail_mount_fixture_unavailable'));
        }
      });
    });
    mailExited.catch(() => {});
    for (
      let attempt = 0;
      attempt < 200 && !fs.existsSync('/home/fixture/.config/nanoclaw-cos/state/mail-race-request');
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fs.existsSync('/home/fixture/.config/nanoclaw-cos/state/mail-race-request'), true);
  }
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
  if (mailExited) {
    await mailExited;
    mailRace = undefined;
  }
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
  if (process.env.NANOCLAW_COS_MAIL_CREDENTIAL_FIXTURE === '1') mailOwner('recovered');
  if (process.env.NANOCLAW_COS_MAIL_RECOVERY_FIXTURE === '1') {
    const text = run('/usr/bin/setpriv', [
      '--clear-groups',
      '--reuid=1000',
      '--regid=1000',
      '--bounding-set=-all',
      '--no-new-privs',
      '--',
      process.execPath,
      '/probe/probe-mail-recovery.mjs',
    ]);
    const records = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    assert.equal(records[0].encryptedMailCheckpoint, 'passed');
    assert.equal(records[1].completeMailCredentialRecovery, 'passed');
    for (const record of records) console.log(JSON.stringify(record));
  }
  run('/usr/bin/umount', ['/home/fixture/.config/nanoclaw-cos/state/calendar']);
  bound = false;
  run('/usr/bin/umount', ['/case/vault']);
  mounted = false;
  owner('unavailable');
  if (process.env.NANOCLAW_COS_MAIL_CREDENTIAL_FIXTURE === '1') mailOwner('unavailable');
  if (process.env.NANOCLAW_COS_FULL_CAPTURE_FIXTURE === '1') {
    const full = JSON.parse(
      run('/usr/bin/setpriv', [
        '--clear-groups',
        '--reuid=1000',
        '--regid=1000',
        process.execPath,
        '/probe/probe-backup-capture.compiled.mjs',
        'unavailable',
      ]),
    );
    assert.equal(full.encryptedFullCaptureMountLoss, 'passed');
    console.log(JSON.stringify(full));
  }
  assert.deepEqual(fs.readdirSync('/case/vault'), []);
  assert.deepEqual(fs.readdirSync('/home/fixture/.config/nanoclaw-cos/state/calendar'), []);
  await writeRuntimeTestMessage(authorityChild.stdin, { action: 'deny' });
  assert.deepEqual((await authorityMessages.next()).value, { stage: 'denied' });
  await assert.rejects(rootPorts.assertAuthority(), /vault_authority_unavailable/);
  await writeRuntimeTestMessage(authorityChild.stdin, { action: 'close' });
  authorityChild.stdin.end();
  await authorityExited;
  console.log(
    JSON.stringify({
      kernelVault: 'passed',
      volumeBytes: 1073741824,
      wrongKeyDenied: true,
      recoveredCanary: true,
      bootKeyRemoved: true,
      ownershipDenied: true,
      symlinkDenied: true,
      mountRaceDenied: true,
      memoryProtection: 'verified',
      plaintextFallback: false,
      allocationAdapter: 'passed',
      cryptsetupAdapter: 'passed',
      mountAdapter: 'passed',
      recoveryKeyOnDisk: false,
      keychainRecovery: process.env.NANOCLAW_COS_VAULT_KEYCHAIN_FIXTURE === '1' ? 'verified' : 'not_exercised',
    }),
  );
} catch {
  console.error('{"code":"vault_provision_fixture_unavailable"}');
  process.exitCode = 1;
} finally {
  recovery?.fill(0);
  if (race) race.kill();
  if (mailRace) mailRace.kill();
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
