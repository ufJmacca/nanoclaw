import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { after, test } from 'node:test';
import { BackupQueue } from '../../modules/chief-of-staff/ops/backup-queue.js';
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
test('a real command producer streams a verified PAX checkpoint through Restic and restores it in isolation', async () => {
  const area = path.join(root, 'synthetic-vault');
  fs.mkdirSync(area, { mode: 0o700 });
  const queue = new BackupQueue('a'.repeat(64), async (_kind, operation) => operation(area));
  const operationId = '9f99d9b4-4dac-423a-956c-afd953993c2d';
  const longName = 'artifacts/' + 'a'.repeat(64) + '-' + 'b'.repeat(64) + '.blob';
  await queue.capture(
    'state',
    operationId,
    async (sink) => {
      sink.write('coordinated/remote.json', Buffer.from(canary));
      sink.write(longName, Buffer.alloc(150000, 0x41));
    },
    262144,
  );
  const data = path.join(area, 'backup-queue/full/data'),
    receipt = path.join(area, 'backup-queue/full/receipt.json');
  const moduleUrl = new URL('../../modules/chief-of-staff/ops/backup-archive.js', import.meta.url).href;
  const producer = `import fs from 'node:fs'; import {streamBackupArchive} from ${JSON.stringify(moduleUrl)};
    const receipt = JSON.parse(fs.readFileSync(${JSON.stringify(receipt)}, 'utf8'));
    try { await streamBackupArchive(${JSON.stringify(data)}, receipt, bytes => new Promise((resolve, reject) => {
      process.stdout.write(bytes, error => error ? reject(error) : resolve());
    })); } catch { process.exitCode = 77; }`;
  run([
    'backup',
    '--stdin-from-command',
    '--stdin-filename',
    'checkpoint.tar',
    '--host',
    'nanoclaw-cos-fixture',
    '--tag',
    'cos-kind=archive',
    '--',
    process.execPath,
    '--input-type=module',
    '-e',
    producer,
  ]);
  const snapshots = JSON.parse(run(['snapshots', '--tag', 'cos-kind=archive'])) as Array<{ id: string }>;
  assert.equal(snapshots.length, 1);
  const bytes = execFileSync('/proc/self/fd/3', [...args, 'dump', snapshots[0].id, 'checkpoint.tar'], {
    cwd: root,
    env,
    timeout: 30000,
    maxBuffer: 1024 ** 2,
    stdio: ['pipe', 'pipe', 'pipe', binaryFd, passwordFd, repositoryFd],
  });
  assert.equal(
    execFileSync('/usr/bin/tar', ['--extract', '--to-stdout', '--file=-', 'payload/coordinated/remote.json'], {
      input: bytes,
      encoding: 'utf8',
    }),
    canary,
  );
  assert.deepEqual(
    execFileSync('/usr/bin/tar', ['--extract', '--to-stdout', '--file=-', 'payload/' + longName], { input: bytes }),
    Buffer.alloc(150000, 0x41),
  );
  const restoredReceipt = JSON.parse(
    execFileSync('/usr/bin/tar', ['--extract', '--to-stdout', '--file=-', 'cos-backup-receipt.json'], {
      input: bytes,
      encoding: 'utf8',
    }),
  );
  assert.equal(restoredReceipt.operationId, operationId);
  const scan = (directory: string) => {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name),
        stat = fs.lstatSync(file);
      assert(!stat.isSymbolicLink());
      if (stat.isDirectory()) scan(file);
      else {
        assert(stat.isFile());
        const contents = fs.readFileSync(file);
        for (const text of [canary, 'checkpoint.tar', longName, operationId])
          assert(!contents.includes(Buffer.from(text)));
      }
    }
  };
  scan(repository);
  run(['check', '--read-data']);
  bytes.fill(0);
});
test('Restic rejects a command producer failure without recording an empty or partial checkpoint', () => {
  const before = JSON.parse(run(['snapshots'])) as Array<{ id: string }>;
  const producer = 'process.stdout.write(Buffer.alloc(65536, 0x41), () => { process.exitCode = 77; });';
  assert.throws(() =>
    run([
      'backup',
      '--stdin-from-command',
      '--stdin-filename',
      'failed-checkpoint.tar',
      '--host',
      'nanoclaw-cos-fixture',
      '--tag',
      'cos-kind=failed-producer',
      '--',
      process.execPath,
      '-e',
      producer,
    ]),
  );
  assert.deepEqual(JSON.parse(run(['snapshots', '--tag', 'cos-kind=failed-producer'])), []);
  assert.deepEqual(
    (JSON.parse(run(['snapshots'])) as Array<{ id: string }>).map((snapshot) => snapshot.id),
    before.map((snapshot) => snapshot.id),
  );
  run(['check', '--read-data']);
});
after(() => {
  for (const fd of [passwordFd, repositoryFd, binaryFd]) fs.closeSync(fd);
  fs.rmSync(root, { recursive: true, force: true });
});
