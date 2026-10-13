import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { withRootBackupSmbCredentials } from './backup-smb-root-lease.js';
import * as artifact from './vault-root-artifact.js';
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture(reason = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-root-smb-'));
  const script = path.join(root, 'owner.mjs');
  fs.writeFileSync(
    script,
    `
import fs from 'node:fs';
import readline from 'node:readline';
const reason = process.env.FIXTURE_REASON;
const file = process.env.FIXTURE_ROOT + '/credential';
fs.writeFileSync(file, 'username=nanoclaw-cos-backup\\npassword=synthetic-password\\n', {mode:0o600});
const fd = fs.openSync(file, fs.constants.O_RDONLY);
const messages = readline.createInterface({input:process.stdin})[Symbol.asyncIterator]();
const request = JSON.parse((await messages.next()).value);
const s = fs.fstatSync(fd);
const ready = {contract:'cos-backup-smb-ready/v1',fd,filesystemUuid:request.expected.filesystemUuid,installationDigest:'b'.repeat(64),file:{dev:s.dev,ino:s.ino,uid:s.uid,gid:s.gid,mode:s.mode,nlink:s.nlink,size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs}};
if(reason==='uuid') ready.filesystemUuid = '33333333-3333-4333-8333-333333333333';
if(reason==='descriptor') ready.fd=99999;
if(reason==='inode') ready.file.ino++;
if(reason==='extra') ready.password='synthetic-private-field';
if(reason==='permissions') {fs.chmodSync(file,0o644);ready.file.mode=fs.fstatSync(fd).mode;}
if(reason==='oversized') process.stdout.write('a'.repeat(9000));
else process.stdout.write(JSON.stringify(ready)+'\\n');
if(reason==='exit') process.exit(1);
if(reason==='stall') await new Promise(()=>{});
let checked=false;
for(;;) {
  const next=await messages.next(); if(next.done) break;
  const q=JSON.parse(next.value);
  if(reason==='refuse' && q.action==='check') process.exit(1);
  if(reason==='replace' && !checked) {fs.appendFileSync(file,'CHANGED');checked=true;}
  if(reason==='hang-check') await new Promise(()=>{});
  if(q.action==='release') {
    await messages.next();
    process.stdout.write(JSON.stringify({contract:'cos-backup-smb-released/v1',sequence:q.sequence,nonce:q.nonce})+'\\n');
    if(reason==='release-extra') process.stdout.write('{}\\n');
    if(reason==='release-fail') process.exit(1);
    if(reason==='hang-release') await new Promise(()=>{});
    break;
  }
  process.stdout.write(JSON.stringify({contract:'cos-backup-smb-current/v1',sequence:q.sequence,nonce:reason==='nonce'?'foreign':q.nonce})+'\\n');
}
fs.closeSync(fd);
`,
    { mode: 0o600 },
  );
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    installationRoot: '/home/fixture/app',
    dataRoot: '/home/fixture/app/data',
  };
  const config = vaultRootConfiguration({
    contract: 'cos-vault-root-config/v2',
    authority: { operationId: randomUUID() },
    identity: {
      operationId: randomUUID(),
      targetDigest: digest(binding),
      recoveryReference: randomUUID(),
      luksUuid: randomUUID(),
      filesystemUuid: randomUUID(),
    },
    target: { binding, lifecycle: 'protected', minimumGeneration: 3 },
    owner: {
      uid: process.getuid?.(),
      gid: process.getgid?.(),
      home: '/home/fixture',
      targetRoot: '/home/fixture/state',
    },
    artifact: { sourceCommit: 'c'.repeat(40), sourceTree: 'd'.repeat(40), digest: 'e'.repeat(64) },
  });
  const children: ReturnType<typeof spawn>[] = [];
  const controls = {
    assertRole: vi.fn(),
    assertMemory: vi.fn(),
    readConfiguration: vi.fn(() => config),
    verifyArtifact: vi.fn(),
    deadlineMs: 1500,
    spawnOwner: vi.fn((_command: string, _args: string[], options: SpawnOptions) => {
      const child = spawn(process.execPath, [script], {
        ...options,
        env: { ...options.env, FIXTURE_ROOT: root, FIXTURE_REASON: reason },
      });
      children.push(child);
      return child;
    }),
  };
  cleanups.push(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { config, controls, children, reference: randomUUID() as string };
}
it('duplicates the actual spawned child descriptor, challenges it throughout the effect and waits for clean release', async () => {
  const s = fixture();
  let fd = -1,
    held!: () => Promise<void>,
    signal!: AbortSignal;
  const result = await withRootBackupSmbCredentials(
    s.config,
    s.reference,
    async (lease) => {
      fd = lease.fd;
      held = lease.assertCurrent;
      signal = lease.signal;
      expect(Object.isFrozen(lease)).toBe(true);
      expect(fs.readFileSync(fd, 'utf8')).toBe('username=nanoclaw-cos-backup\npassword=synthetic-password\n');
      await lease.assertCurrent();
      return 'mounted-fixture';
    },
    s.controls,
  );
  expect(result).toBe('mounted-fixture');
  expect(() => fs.fstatSync(fd)).toThrow();
  await expect(held()).rejects.toThrow(/^backup_smb_root_lease_unavailable$/);
  expect(signal.aborted).toBe(true);
  expect(s.children[0].exitCode).toBe(0);
  const [command, args, options] = s.controls.spawnOwner.mock.calls[0];
  expect(command).toBe('/usr/bin/setpriv');
  expect(args).toEqual([
    '--clear-groups',
    '--reuid=' + s.config.owner.uid,
    '--regid=' + s.config.owner.gid,
    '--bounding-set=-all',
    '--inh-caps=-all',
    '--ambient-caps=-all',
    '--no-new-privs',
    '--',
    '/opt/nanoclaw-cos/vault/' + s.config.artifact.digest + '/node',
    '/opt/nanoclaw-cos/vault/' + s.config.artifact.digest + '/gateway.mjs',
    '--backup-credential-probe',
  ]);
  expect(options).toMatchObject({
    cwd: '/',
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: '/home/fixture' },
  });
  expect(JSON.stringify([command, args, options])).not.toContain('synthetic-password');
});
it('retains the actual spawned owner descriptor through the repeated journal checks', async () => {
  const s = fixture();
  await withRootBackupSmbCredentials(
    s.config,
    s.reference,
    async (lease) => {
      for (let check = 0; check < 40; check++) await lease.assertCurrent();
      expect(fs.fstatSync(lease.fd).isFile()).toBe(true);
    },
    s.controls,
  );
  expect(s.children[0].exitCode).toBe(0);
});
it('holds the default verified artifact scope until its actual owner child has terminated', async () => {
  const s = fixture();
  let active = false;
  const current = vi.fn(() => {
    if (!active) throw Error('FIXTURE_ARTIFACT_RELEASED');
  });
  const held = vi.spyOn(artifact, 'withVaultRootArtifact').mockImplementation(async (config, operation) => {
    active = true;
    try {
      return await operation({
        seal: {
          contract: 'cos-vault-root-artifact/v1',
          sourceCommit: config.artifact.sourceCommit,
          sourceTree: config.artifact.sourceTree,
          runtime: { name: 'node', version: '22.23.2', architecture: 'arm64' },
          files: { node: { bytes: 1, sha256: 'a'.repeat(64) }, 'gateway.mjs': { bytes: 1, sha256: 'b'.repeat(64) } },
        },
        assertCurrent: current,
      });
    } finally {
      expect(s.children[0].exitCode).toBe(0);
      active = false;
    }
  });
  const { verifyArtifact: _fixtureArtifact, ...controls } = s.controls;
  await withRootBackupSmbCredentials(
    s.config,
    s.reference,
    async (lease) => {
      for (let index = 0; index < 40; index++) await lease.assertCurrent();
      expect(active).toBe(true);
    },
    controls,
  );
  expect(held).toHaveBeenCalledTimes(1);
  expect(current.mock.calls.length).toBeGreaterThan(40);
  expect(active).toBe(false);
});
it.each(['role', 'memory', 'artifact', 'configuration', 'reference'])(
  'denies initial %s before spawning any credential process',
  async (reason) => {
    const s = fixture(),
      effect = vi.fn(async () => {});
    if (reason === 'role')
      s.controls.assertRole.mockImplementation(() => {
        throw Error('PRIVATE_ROLE');
      });
    if (reason === 'memory')
      s.controls.assertMemory.mockImplementation(() => {
        throw Error('PRIVATE_MEMORY');
      });
    if (reason === 'artifact')
      s.controls.verifyArtifact.mockImplementation(() => {
        throw Error('PRIVATE_ARTIFACT');
      });
    if (reason === 'configuration')
      s.controls.readConfiguration.mockReturnValue({
        ...s.config,
        target: { ...s.config.target, minimumGeneration: 4 },
      });
    if (reason === 'reference') s.reference = 'foreign';
    await expect(withRootBackupSmbCredentials(s.config, s.reference, effect, s.controls)).rejects.toThrow(
      /^backup_smb_root_lease_unavailable$/,
    );
    expect(effect).not.toHaveBeenCalled();
    expect(s.controls.spawnOwner).not.toHaveBeenCalled();
  },
);
it('still waits for actual owner closure when Linux denies the owned termination signal', async () => {
  const s = fixture('replace');
  let closed = false;
  const originalSpawn = s.controls.spawnOwner.getMockImplementation()!;
  s.controls.spawnOwner.mockImplementation((command, args, options) => {
    const child = originalSpawn(command, args, options);
    child.once('close', () => {
      closed = true;
    });
    return child;
  });
  const terminate = vi.spyOn(process, 'kill').mockImplementation((pid) => {
    expect(pid).toBe(-s.children[0].pid!);
    throw Object.assign(Error('PRIVATE_SIGNAL_DENIED'), { code: 'EPERM' });
  });
  await expect(withRootBackupSmbCredentials(s.config, s.reference, async () => {}, s.controls)).rejects.toThrow(
    /^backup_smb_root_lease_unavailable$/,
  );
  expect(terminate).toHaveBeenCalledWith(-s.children[0].pid!, 'SIGTERM');
  expect(closed).toBe(true);
});
it.each([
  'uuid',
  'descriptor',
  'inode',
  'extra',
  'permissions',
  'oversized',
  'exit',
  'refuse',
  'replace',
  'nonce',
  'stall',
  'hang-check',
])('denies %s from an actual child and terminates only its owned process', async (reason) => {
  const s = fixture(reason),
    effect = vi.fn(async () => {});
  if (['stall', 'hang-check'].includes(reason)) s.controls.deadlineMs = 100;
  await expect(withRootBackupSmbCredentials(s.config, s.reference, effect, s.controls)).rejects.toThrow(
    /^backup_smb_root_lease_unavailable$/,
  );
  expect(effect).not.toHaveBeenCalled();
  expect(s.children[0].exitCode !== null || s.children[0].signalCode !== null).toBe(true);
});
it.each(['effect', 'late-config', 'release-extra', 'release-fail', 'hang-release', 'effect-stall', 'owner-stop'])(
  'releases the duplicate and aborts the scope for %s after admission',
  async (reason) => {
    const s = fixture(reason);
    if (['hang-release', 'effect-stall'].includes(reason)) s.controls.deadlineMs = 100;
    let fd = -1,
      signal!: AbortSignal;
    await expect(
      withRootBackupSmbCredentials(
        s.config,
        s.reference,
        async (lease) => {
          fd = lease.fd;
          signal = lease.signal;
          if (reason === 'effect') throw Error('PRIVATE_EFFECT');
          if (reason === 'late-config')
            s.controls.readConfiguration.mockReturnValue({
              ...s.config,
              target: { ...s.config.target, minimumGeneration: 4 },
            });
          if (reason === 'effect-stall') await new Promise(() => {});
          if (reason === 'owner-stop') {
            s.children[0].kill('SIGKILL');
            await new Promise(() => {});
          }
        },
        s.controls,
      ),
    ).rejects.toThrow(/^backup_smb_root_lease_unavailable$/);
    expect(fd).toBeGreaterThan(2);
    expect(() => fs.fstatSync(fd)).toThrow();
    expect(signal.aborted).toBe(true);
    expect(s.children[0].exitCode !== null || s.children[0].signalCode !== null).toBe(true);
  },
);
