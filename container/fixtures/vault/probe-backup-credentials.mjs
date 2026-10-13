// Disposable kernel fixture only. Credentials are generated here and never leave its encrypted volume.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { digest } from '/code/modules/chief-of-staff/domain/contracts.js';
import { machineFingerprint, localTarget } from '/code/modules/chief-of-staff/ops/target-identity.js';
import { writeAtomic } from '/code/modules/chief-of-staff/ops/target-state.js';
import { verifyVaultStorage } from '/code/modules/chief-of-staff/ops/vault-storage.js';
import { verifyVaultMemory } from '/code/modules/chief-of-staff/ops/vault-memory.js';
import { runBackupCredentialInstallAdmin } from '/code/modules/chief-of-staff/ops/backup-credential-admin.js';
import { readBackupCredentialInstallation } from '/code/modules/chief-of-staff/ops/backup-credential-install.js';
import {
  readVaultRootConfiguration,
  vaultRootConfiguration,
} from '/code/modules/chief-of-staff/ops/vault-root-config.js';
import { withVaultRootArtifact } from '/code/modules/chief-of-staff/ops/vault-root-artifact.js';
import { withRootBackupSmbCredentials } from '/code/modules/chief-of-staff/ops/backup-smb-root-lease.js';

const roots = {
  targetRoot: '/home/fixture/.config/nanoclaw-cos/state',
  installationRoot: '/case/application',
  dataRoot: '/case/data',
};
const metadataPath = roots.targetRoot + '/backup-fixture.json';
const credential = '/case/vault/backup-credentials/smb-credentials';
const statePath = roots.targetRoot + '/state.json';
const mode = process.argv[2];
verifyVaultMemory();
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'arm64');
process.umask(0o077);

if (mode === 'install') {
  assert.equal(process.getuid(), 1000);
  assert.equal(fs.existsSync(statePath), false);
  const binding = {
    hostFingerprint: machineFingerprint(),
    databaseFingerprint: digest('isolated-backup-kernel-fixture'),
    service: 'nanoclaw-fixture.service',
    installationRoot: roots.installationRoot,
    dataRoot: roots.dataRoot,
  };
  const operationId = randomUUID(),
    credentialReference = randomUUID();
  const state = {
    version: 1,
    binding,
    lifecycle: 'protected',
    generation: 3,
    maintenance: true,
    maintenanceId: operationId,
    releaseId: 'release-backup-kernel-fixture',
  };
  // These are disposable fixture bindings, never a production maintenance or deployment receipt.
  writeAtomic(roots.targetRoot, 'protected.json', { bindingDigest: digest(binding), generation: 3 });
  writeAtomic(roots.targetRoot, 'state.json', state);
  const policy = verifyVaultStorage(roots);
  const assertAuthority = () => {
    verifyVaultMemory();
    assert.equal(digest(localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot)), digest(state));
  };
  const smb = randomBytes(16).toString('hex'),
    restic = randomBytes(32).toString('hex');
  assert.notEqual(smb, restic);
  const bytes = Buffer.concat([
    Buffer.from([0x43, 0x4f, 0x53, 0x42, 1, 32, 64]),
    Buffer.from(smb),
    Buffer.from(restic),
  ]);
  try {
    const result = await runBackupCredentialInstallAdmin({
      args: { command: 'backup-credentials-install', scopeId: 'fixture', requestId: operationId, credentialReference },
      roots,
      assertAuthority,
      check: async () => assertAuthority(),
      stream: Readable.from([bytes]),
    });
    assert.equal(result.status, 'ready');
    assert.equal(
      readBackupCredentialInstallation('/case/vault/backup-credentials', roots, policy.volume.filesystemUuid).phase,
      'ready',
    );
    for (const name of ['smb-credentials', 'restic-password', 'backup-credential-installation.json']) {
      const file = fs.lstatSync('/case/vault/backup-credentials/' + name);
      assert.equal(file.uid, 1000);
      assert.equal(file.mode & 0o7777, 0o600);
      assert.equal(file.nlink, 1);
      assert.equal(file.dev, fs.statSync('/case/vault').dev);
    }
    writeAtomic(roots.targetRoot, 'backup-fixture.json', {
      credentialReference,
      binding,
      filesystemUuid: policy.volume.filesystemUuid,
    });
    writeAtomic(roots.targetRoot, 'state.json', { ...state, maintenance: false, maintenanceId: null });
    console.log(
      JSON.stringify({
        encryptedCredentialInstallation: 'passed',
        independentPasswords: true,
        plaintextFallback: false,
      }),
    );
  } finally {
    bytes.fill(0);
  }
} else if (mode === 'utility') {
  assert.equal(process.getuid(), 1000);
  const bytes = Buffer.alloc(129);
  try {
    const count = fs.readSync(3, bytes, 0, bytes.length, 0);
    assert.equal(count, 71);
    assert.equal(bytes.subarray(0, 38).equals(Buffer.from('username=nanoclaw-cos-backup\npassword=')), true);
    assert.equal(bytes[count - 1], 10);
    console.log(JSON.stringify({ inheritedPrivateCredential: 'passed', bytes: count }));
  } finally {
    bytes.fill(0);
    fs.closeSync(3);
  }
} else if (mode === 'maintenance-on' || mode === 'maintenance-off') {
  assert.equal(process.getuid(), 1000);
  const state = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot);
  writeAtomic(roots.targetRoot, 'state.json', {
    ...state,
    maintenance: mode === 'maintenance-on',
    maintenanceId: mode === 'maintenance-on' ? randomUUID() : null,
  });
} else if (mode === 'root') {
  assert.equal(process.getuid(), 0);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const base = '/opt/nanoclaw-cos/vault',
    artifacts = fs.readdirSync(base);
  assert.equal(artifacts.length, 1);
  const artifactDigest = artifacts[0],
    artifactRoot = base + '/' + artifactDigest;
  const seal = JSON.parse(fs.readFileSync(artifactRoot + '/artifact.json', 'utf8'));
  assert.equal(digest(seal), artifactDigest);
  const mapper = fs.readdirSync('/dev/mapper').filter((name) => name.startsWith('cos-vault-fixture-'));
  assert.equal(mapper.length, 1);
  const uuidResult = spawnSync('/usr/sbin/cryptsetup', ['luksUUID', '/case/vault.luks'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.equal(uuidResult.status, 0);
  const config = vaultRootConfiguration({
    contract: 'cos-vault-root-config/v2',
    authority: { operationId: randomUUID() },
    identity: {
      operationId: randomUUID(),
      targetDigest: digest(metadata.binding),
      recoveryReference: randomUUID(),
      luksUuid: uuidResult.stdout.trim(),
      filesystemUuid: metadata.filesystemUuid,
    },
    target: { binding: metadata.binding, lifecycle: 'protected', minimumGeneration: 3 },
    owner: { uid: 1000, gid: 1000, home: '/home/fixture', targetRoot: roots.targetRoot },
    artifact: { sourceCommit: seal.sourceCommit, sourceTree: seal.sourceTree, digest: artifactDigest },
  });
  assert.equal(fs.existsSync('/etc/nanoclaw-cos'), false);
  fs.mkdirSync('/etc/nanoclaw-cos', { mode: 0o700 });
  writeAtomic('/etc/nanoclaw-cos', 'vault-root.json', config);
  assert.deepEqual(readVaultRootConfiguration(), config);
  const ownerAction = (action) => {
    const result = spawnSync(
      '/usr/bin/setpriv',
      [
        '--clear-groups',
        '--reuid=1000',
        '--regid=1000',
        '--bounding-set=-all',
        '--no-new-privs',
        '--',
        process.execPath,
        '/probe/probe-backup-credentials.mjs',
        action,
      ],
      {
        cwd: '/',
        env: { PATH: '/usr/bin:/bin', HOME: '/home/fixture' },
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 10000,
      },
    );
    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
  };
  const mountEffect = (command, args) => {
    verifyVaultMemory();
    const result = spawnSync(command, args, {
      cwd: '/',
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 10000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
  };
  let cases = 0,
    challenges = 0,
    heldOwnerChildren = 0,
    effectChildren = 0;
  const children = () =>
    fs
      .readFileSync('/proc/self/task/' + process.pid + '/children', 'utf8')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  const invoke = async (kind, reference = metadata.credentialReference) => {
    let entered = false,
      fd = -1,
      ownerPid;
    const before = children();
    const call = () =>
      withVaultRootArtifact(
        config,
        (artifact) =>
          withRootBackupSmbCredentials(
            config,
            reference,
            async (lease) => {
              entered = true;
              fd = lease.fd;
              const added = children().filter((pid) => !before.includes(pid));
              assert.equal(added.length, 1);
              ownerPid = added[0];
              heldOwnerChildren++;
              assert.match(
                fs.readFileSync('/proc/' + ownerPid + '/status', 'utf8'),
                /^Uid:\s+1000\s+1000\s+1000\s+1000\s*$/m,
              );
              assert.equal(fs.fstatSync(fd).dev, fs.statSync('/case/vault').dev);
              if (kind === 'success') {
                for (let index = 0; index < 40; index++) {
                  await lease.assertCurrent();
                  challenges++;
                }
                const effect = spawn(
                  '/usr/bin/setpriv',
                  [
                    '--clear-groups',
                    '--reuid=1000',
                    '--regid=1000',
                    '--bounding-set=-all',
                    '--no-new-privs',
                    '--',
                    process.execPath,
                    '/probe/probe-backup-credentials.mjs',
                    'utility',
                  ],
                  {
                    cwd: '/',
                    env: { PATH: '/usr/bin:/bin', HOME: '/home/fixture' },
                    stdio: ['ignore', 'pipe', 'ignore', fd],
                  },
                );
                const close = new Promise((resolve) => {
                  effect.once('error', () => resolve(false));
                  effect.once('close', (code, signal) => resolve(code === 0 && signal === null));
                });
                let output = '';
                for await (const chunk of effect.stdout) {
                  output += chunk.toString();
                  assert(output.length < 1024);
                }
                assert.equal(await close, true);
                effectChildren++;
                assert.equal(JSON.parse(output).inheritedPrivateCredential, 'passed');
                await lease.assertCurrent();
                challenges++;
              } else if (kind === 'maintenance') {
                ownerAction('maintenance-on');
                await lease.assertCurrent();
              } else if (kind === 'permission') {
                fs.chmodSync(credential, 0o644);
                await lease.assertCurrent();
              } else if (kind === 'replacement') {
                fs.renameSync(credential, credential + '.original');
                fs.copyFileSync(credential + '.original', credential, fs.constants.COPYFILE_EXCL);
                fs.chownSync(credential, 1000, 1000);
                fs.chmodSync(credential, 0o600);
                await lease.assertCurrent();
              } else if (kind === 'vault-loss') {
                mountEffect('/usr/bin/umount', [roots.targetRoot + '/calendar']);
                // Lazy detach is exercised only on this newly created disposable test volume.
                mountEffect('/usr/bin/umount', ['-l', '/case/vault']);
                await lease.assertCurrent();
              } else throw Error('unexpected effect');
              return 'verified';
            },
            { verifyArtifact: artifact.assertCurrent },
          ),
        { executable: artifactRoot + '/node', entrypoint: artifactRoot + '/gateway.mjs' },
      );
    try {
      if (kind === 'success') assert.equal(await call(), 'verified');
      else await assert.rejects(call, /vault_root_artifact_unavailable/);
      if (kind === 'wrong-reference' || kind === 'maintenance-admission') assert.equal(entered, false);
      else assert.equal(entered, true);
      if (ownerPid) assert.equal(fs.existsSync('/proc/' + ownerPid), false);
      if (fd >= 0) assert.throws(() => fs.fstatSync(fd));
      assert.deepEqual(children(), before);
      cases++;
    } finally {
      if (kind === 'maintenance') ownerAction('maintenance-off');
      if (kind === 'permission') fs.chmodSync(credential, 0o600);
      if (kind === 'replacement' && fs.existsSync(credential + '.original')) {
        fs.unlinkSync(credential);
        fs.renameSync(credential + '.original', credential);
      }
      if (kind === 'vault-loss') {
        mountEffect('/usr/bin/mount', [
          '-t',
          'ext4',
          '-o',
          'nosuid,nodev,noexec',
          '/dev/mapper/' + mapper[0],
          '/case/vault',
        ]);
        mountEffect('/usr/bin/mount', [
          '-o',
          'bind,nosuid,nodev,noexec',
          '/case/vault/google/calendar',
          roots.targetRoot + '/calendar',
        ]);
      }
    }
  };
  await invoke('success');
  await invoke('wrong-reference', randomUUID());
  ownerAction('maintenance-on');
  try {
    await invoke('maintenance-admission');
  } finally {
    ownerAction('maintenance-off');
  }
  await invoke('maintenance');
  await invoke('permission');
  await invoke('replacement');
  await invoke('vault-loss');
  await invoke('success');
  verifyVaultMemory();
  console.log(
    JSON.stringify({
      backupVaultCredentialHandoff: 'passed',
      cases,
      challenges,
      heldOwnerChildren,
      effectChildren,
      actualEncryptedVault: true,
      actualInstalledCredentialFiles: true,
      actualDefaultOwnerProbe: true,
      actualRootDescriptorDuplication: true,
      actualPrivateDescriptorInheritance: true,
      actualChildClosure: true,
      changedMaintenanceDenied: true,
      changedPermissionDenied: true,
      changedFileDenied: true,
      vaultLossDenied: true,
      wrongReferenceDenied: true,
      sealedSourceCommit: seal.sourceCommit,
      sealedSourceTree: seal.sourceTree,
      syntheticCredentialsOnly: true,
      secretOutput: false,
      administratorAuthority: 'fixture',
      systemdActivation: 'not_exercised',
      finalArtifact: false,
    }),
  );
} else throw Error('unknown backup fixture mode');
