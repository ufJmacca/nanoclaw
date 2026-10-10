import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { after, test } from 'node:test';
import {
  verifyResticBinary,
  verifyResticRepositoryIdentity,
} from '../../modules/chief-of-staff/ops/restic-artifact.js';
// Synthetic fixtures only. Runtime uploads also require the vault/memory, NAS mount and repository leases.
const binary = process.env.COS_BACKUP_FIXTURE_BINARY;
if (!binary) throw Error('backup_fixture_artifact_required');
verifyResticBinary(binary);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-restic-fixture-'));
fs.chmodSync(root, 0o700);
const repository = path.join(root, 'repository'),
  restore = path.join(root, 'restore');
fs.mkdirSync(repository, { mode: 0o700 });
fs.mkdirSync(restore, { mode: 0o700 });
const password = path.join(root, 'fixture-password');
fs.writeFileSync(password, 'synthetic-fixture-password-no-live-authority\n', { mode: 0o600 });
const passwordFd = fs.openSync(password, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
const repositoryFd = fs.openSync(
  repository,
  fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
);
const binaryFd = fs.openSync(binary, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
const args = ['--repo', '/proc/self/fd/5', '--password-file', '/proc/self/fd/4', '--no-cache', '--json'];
const run = (operation: string[], input?: Buffer) =>
  execFileSync('/proc/self/fd/3', [...args, ...operation], {
    cwd: root,
    env,
    input,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 ** 2,
    stdio: ['pipe', 'pipe', 'pipe', binaryFd, passwordFd, repositoryFd],
  });
let repositoryId: string;
const canary = 'COS_G02_SYNTHETIC_ENCRYPTION_CANARY_4f9b3716';
test('official pinned ARM64 binary initializes repository v2 and binds its decrypted identity', () => {
  run(['init', '--repository-version', '2']);
  const config = run(['cat', 'config']);
  repositoryId = (JSON.parse(config) as { id: string }).id;
  assert.deepEqual(verifyResticRepositoryIdentity(config, repositoryId), { version: 2, id: repositoryId });
  assert.throws(() => verifyResticRepositoryIdentity(config, 'f'.repeat(64)), /^Error: backup_repository_unverified$/);
});
test('real stdin backup encrypts content and metadata and restores only into an isolated fixture', () => {
  run(
    [
      'backup',
      '--stdin',
      '--stdin-filename',
      'checkpoint.cos',
      '--host',
      'nanoclaw-cos-fixture',
      '--tag',
      'cos-kind=state',
    ],
    Buffer.from(canary + '\n'),
  );
  const snapshots = JSON.parse(run(['snapshots', '--tag', 'cos-kind=state'])) as Array<{ id: string }>;
  assert.equal(snapshots.length, 1);
  assert.equal(run(['dump', snapshots[0].id, 'checkpoint.cos']), canary + '\n');
  run(['check', '--read-data']);
  const scan = (directory: string) => {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name),
        stat = fs.lstatSync(file);
      assert(!stat.isSymbolicLink());
      if (stat.isDirectory()) scan(file);
      else {
        assert(stat.isFile());
        const bytes = fs.readFileSync(file);
        assert(!bytes.includes(Buffer.from(canary)));
        assert(!bytes.includes(Buffer.from('checkpoint.cos')));
      }
    }
  };
  scan(repository);
  run(['restore', snapshots[0].id, '--target', restore]);
  assert.equal(fs.readFileSync(path.join(restore, 'checkpoint.cos'), 'utf8'), canary + '\n');
});
test('an interrupted stdin upload leaves a checkable repository and no claimed checkpoint', async () => {
  const before = JSON.parse(run(['snapshots'])) as Array<{ id: string }>;
  const child = spawn(
    '/proc/self/fd/3',
    [
      ...args,
      'backup',
      '--stdin',
      '--stdin-filename',
      'interrupted.cos',
      '--host',
      'nanoclaw-cos-fixture',
      '--tag',
      'cos-kind=interrupted',
    ],
    {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'pipe', binaryFd, passwordFd, repositoryFd],
    },
  );
  assert(child.stdin && child.stdout && child.stderr);
  child.stdout.resume();
  child.stderr.resume();
  const completed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  child.stdin.on('error', () => {});
  child.stdin.write(Buffer.alloc(65536, 0x41));
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  assert(child.kill('SIGTERM'));
  assert.notEqual(await completed, 0);
  const interrupted = JSON.parse(run(['snapshots', '--tag', 'cos-kind=interrupted'])) as unknown[];
  assert.equal(interrupted.length, 0);
  assert.deepEqual(
    (JSON.parse(run(['snapshots'])) as Array<{ id: string }>).map((s) => s.id),
    before.map((s) => s.id),
  );
  run(['check', '--read-data']);
  run(
    [
      'backup',
      '--stdin',
      '--stdin-filename',
      'after-interruption.cos',
      '--host',
      'nanoclaw-cos-fixture',
      '--tag',
      'cos-kind=retry',
    ],
    Buffer.from(canary),
  );
  assert.equal((JSON.parse(run(['snapshots', '--tag', 'cos-kind=retry'])) as unknown[]).length, 1);
});
after(() => {
  for (const fd of [passwordFd, repositoryFd, binaryFd]) fs.closeSync(fd);
  fs.rmSync(root, { recursive: true, force: true });
});
