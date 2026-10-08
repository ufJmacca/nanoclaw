import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { digest } from '/code/modules/chief-of-staff/domain/contracts.js';
import { verifyVaultMemory } from '/code/modules/chief-of-staff/ops/vault-memory.js';
import { readVaultRootConfiguration } from '/code/modules/chief-of-staff/ops/vault-root-config.js';
import { verifyVaultRootArtifact } from '/code/modules/chief-of-staff/ops/vault-root-artifact.js';
import { initializeVaultRootState, vaultRootStateDigest } from '/code/modules/chief-of-staff/ops/vault-root-state.js';
import { checkVaultAuthority } from '/code/modules/chief-of-staff/ops/vault-authority.js';
import { writeVaultRootRequest } from '/code/modules/chief-of-staff/ops/vault-root-wire.js';
import { runtimeTestMessages, writeRuntimeTestMessage } from '/code/modules/chief-of-staff/ops/runtime-test-wire.js';
let owner, recovery;
try {
  assert.equal(process.getuid(), 0);
  assert.equal(process.arch, 'arm64');
  assert.equal(process.env.NANOCLAW_COS_VAULT_FIXTURE, '1');
  verifyVaultMemory();
  const base = '/opt/nanoclaw-cos/vault',
    roots = fs.readdirSync(base);
  assert.equal(roots.length, 1);
  const artifactDigest = roots[0],
    root = base + '/' + artifactDigest;
  const seal = JSON.parse(fs.readFileSync(root + '/artifact.json', 'utf8'));
  assert.equal(digest(seal), artifactDigest);
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'nanoclaw-fixture.service',
    installationRoot: '/home/fixture/app',
    dataRoot: '/home/fixture/app/data',
  };
  const config = {
    contract: 'cos-vault-root-config/v1',
    identity: {
      operationId: randomUUID(),
      targetDigest: digest(binding),
      recoveryReference: randomUUID(),
      luksUuid: randomUUID(),
      filesystemUuid: randomUUID(),
    },
    target: { binding, lifecycle: 'protected', minimumGeneration: 1 },
    owner: { uid: 1000, gid: 1000, home: '/home/fixture', targetRoot: '/home/fixture/.config/nanoclaw-cos/state' },
    artifact: { sourceCommit: seal.sourceCommit, sourceTree: seal.sourceTree, digest: artifactDigest },
  };
  fs.mkdirSync('/etc/nanoclaw-cos', { mode: 0o700 });
  fs.writeFileSync('/etc/nanoclaw-cos/vault-root.json', JSON.stringify(config), { flag: 'wx', mode: 0o600 });
  const guards = { executable: root + '/node', entrypoint: root + '/gateway.mjs' };
  assert.deepEqual(verifyVaultRootArtifact(readVaultRootConfiguration(), guards), seal);
  fs.mkdirSync('/case', { mode: 0o755 });
  fs.mkdirSync('/case/authority', { mode: 0o700 });
  fs.chownSync('/case/authority', 1000, 1000);
  owner = spawn(
    '/usr/bin/setpriv',
    [
      '--reuid=1000',
      '--regid=1000',
      '--clear-groups',
      process.execPath,
      '/probe/probe-authority.mjs',
      'owner',
      config.identity.operationId,
      config.identity.targetDigest,
      '1',
    ],
    {
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', NANOCLAW_COS_VAULT_FIXTURE: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 60000,
    },
  );
  const ownerExit = new Promise((resolve, reject) => {
    owner.once('error', reject);
    owner.once('exit', (code, signal) => (code === 0 && !signal ? resolve() : reject(Error('owner_fixture_failed'))));
  });
  ownerExit.catch(() => {});
  const messages = runtimeTestMessages(owner.stdout),
    grant = (await messages.next()).value;
  const proofs = async () => {
    await writeRuntimeTestMessage(owner.stdin, { action: 'status' });
    return (await messages.next()).value.proofs;
  };
  const header = {
    contract: 'cos-vault-root-request/v1',
    configurationDigest: digest(config),
    identity: config.identity,
    scope: grant.scope,
    authority: { socket: grant.socket, token: grant.token },
  };
  recovery = randomBytes(64);
  const invoke = async (args = [], request = header) => {
    const child = spawn(root + '/node', [root + '/gateway.mjs', ...args], {
      cwd: '/',
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 20000,
    });
    child.stdin.on('error', () => {});
    let output = '',
      diagnostic = '';
    child.stdout.on('data', (bytes) => {
      output += bytes.toString('utf8');
      if (output.length > 4096) child.kill();
    });
    child.stderr.on('data', (bytes) => {
      diagnostic += bytes.toString('utf8');
      if (diagnostic.length > 4096) child.kill();
    });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => (signal ? reject(Error('root_fixture_failed')) : resolve(code)));
    });
    exited.catch(() => {});
    try {
      await writeVaultRootRequest(child.stdin, request, recovery);
    } catch {
      /* Early denial may close the private pipe. */
    }
    child.stdin.end();
    assert.equal(await exited, 1);
    assert.equal(output, '');
    assert.equal(diagnostic, '{"code":"vault_root_gateway_unavailable"}\n');
  };
  fs.mkdirSync('/var/lib/nanoclaw-cos', { mode: 0o755 });
  const foreignParentInode = fs.statSync('/var/lib/nanoclaw-cos').ino;
  const before = await proofs();
  // A foreign unclaimed volume parent must be refused after the artifact/scope/owner proof, before bootstrap or storage effects.
  await invoke();
  const admitted = await proofs();
  assert.ok(admitted > before);
  assert.equal(fs.existsSync('/etc/nanoclaw-cos/control'), false);
  assert.equal(fs.statSync('/var/lib/nanoclaw-cos').ino, foreignParentInode);
  assert.deepEqual(fs.readdirSync('/var/lib/nanoclaw-cos'), []);
  assert.equal(fs.existsSync('/etc/nanoclaw-cos/vault-bootstrap.json'), false);
  await invoke(['--volume=/dev/foreign']);
  assert.equal(await proofs(), admitted);
  await invoke([], { ...header, configurationDigest: '0'.repeat(64) });
  assert.equal(await proofs(), admitted);
  fs.rmdirSync('/var/lib/nanoclaw-cos');
  const bootstrap = { assertAuthority: () => checkVaultAuthority(grant, grant.scope, 1000) };
  await initializeVaultRootState(vaultRootStateDigest(config), bootstrap);
  const controlInode = fs.statSync('/etc/nanoclaw-cos/control').ino;
  await initializeVaultRootState(vaultRootStateDigest(config), bootstrap);
  assert.equal(fs.statSync('/etc/nanoclaw-cos/control').ino, controlInode);
  assert.equal(fs.statSync('/var/lib/nanoclaw-cos').mode & 0o777, 0o711);
  const afterBootstrap = await proofs();
  fs.chmodSync(root + '/gateway.mjs', 0o644);
  fs.appendFileSync(root + '/gateway.mjs', '\n');
  fs.chmodSync(root + '/gateway.mjs', 0o444);
  await invoke();
  assert.equal(await proofs(), afterBootstrap);
  fs.chmodSync(root + '/gateway.mjs', 0o644);
  const original = fs.readFileSync(root + '/gateway.mjs');
  fs.truncateSync(root + '/gateway.mjs', original.length - 1);
  fs.chmodSync(root + '/gateway.mjs', 0o444);
  fs.chmodSync(root + '/node', 0o755);
  fs.appendFileSync(root + '/node', Buffer.alloc(1));
  fs.chmodSync(root + '/node', 0o555);
  await invoke();
  assert.equal(await proofs(), afterBootstrap);
  assert.equal(fs.existsSync('/etc/nanoclaw-cos/vault.key'), false);
  assert.equal(fs.existsSync('/var/lib/nanoclaw-cos/vault.luks'), false);
  await writeRuntimeTestMessage(owner.stdin, { action: 'close' });
  owner.stdin.end();
  await ownerExit;
  assert.equal(fs.readdirSync('/case/authority').length, 0);
  console.log(
    JSON.stringify({
      sealedRootArtifact: 'passed',
      sourceCommit: seal.sourceCommit,
      sourceTree: seal.sourceTree,
      artifactDigest,
      runtime: seal.runtime,
      actualEntrypoint: 'verified',
      liveOwnerProof: 'verified',
      changedGatewayDenied: true,
      changedRuntimeDenied: true,
      argumentsDenied: true,
      rootEffects: 'foreign_parent_denied',
      rootBootstrap: 'compiled_native_passed',
      targetLeases: 'not_exercised',
      managerActivation: 'not_exercised',
      recoveryKeyOnDisk: false,
    }),
  );
} catch {
  console.error('{"code":"vault_artifact_fixture_unavailable"}');
  process.exitCode = 1;
} finally {
  recovery?.fill(0);
  if (owner && owner.exitCode === null && owner.signalCode === null) owner.kill();
}
