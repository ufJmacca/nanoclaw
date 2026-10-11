import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { after, test } from 'node:test';
import { BackupQueue } from '../../modules/chief-of-staff/ops/backup-queue.js';
import { BackupResticTransfer } from '../../modules/chief-of-staff/ops/backup-restic-transfer.js';
import { BackupRepositoryWriter } from '../../modules/chief-of-staff/ops/backup-repository-lease.js';
import { streamQueuedBackup } from '../../modules/chief-of-staff/ops/backup-archive-producer.js';
import { withIsolatedBackupRestore } from '../../modules/chief-of-staff/ops/backup-restore-workspace.js';
import {
  backupRetentionArguments,
  backupRepositoryHost,
  backupSnapshotTags,
} from '../../modules/chief-of-staff/ops/backup-retention.js';
import {
  verifyResticBinary,
  verifyResticRepositoryIdentity,
  withVerifiedResticBinary,
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
const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'Australia/Sydney' };
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
const snapshotMetadata = () =>
  (JSON.parse(run(['snapshots'])) as Array<{ id: string }>).sort((a, b) => a.id.localeCompare(b.id));
let repositoryId: string;
const transferOwner = 'c'.repeat(64),
  transferOperation = '86419d8e-6444-49c4-b674-dfa8979eeed5';
let transferArchive: { bytes: number; sha256: string }, transferSnapshot: string;
const transferArea = path.join(root, 'transfer-queue'),
  transferLock = path.join(root, 'transfer-lock'),
  transferCache = path.join(root, 'transfer-cache');
for (const directory of [transferArea, transferLock, transferCache]) fs.mkdirSync(directory, { mode: 0o700 });
const cacheFd = fs.openSync(transferCache, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
const transferQueue = new BackupQueue('a'.repeat(64), async (_kind, operation) => operation(transferArea));
const transferWriter = new BackupRepositoryWriter(transferOwner, async (operation) => operation(transferLock));
const transferProducer = (operationId: string) => {
  const queueUrl = new URL('../../modules/chief-of-staff/ops/backup-queue.js', import.meta.url).href;
  const producerUrl = new URL('../../modules/chief-of-staff/ops/backup-archive-producer.js', import.meta.url).href;
  return [
    process.execPath,
    '--input-type=module',
    '-e',
    `
    import { BackupQueue } from ${JSON.stringify(queueUrl)};
    import { streamQueuedBackup } from ${JSON.stringify(producerUrl)};
    const queue = new BackupQueue('a'.repeat(64), async (_kind, operation) => operation(${JSON.stringify(transferArea)}));
    try { await streamQueuedBackup(queue, 'credentials', ${JSON.stringify(operationId)}, bytes => new Promise((resolve, reject) => {
      process.stdout.write(bytes, error => error ? reject(error) : resolve());
    })); } catch { process.exitCode = 77; }
  `,
  ];
};
/** Transport compatibility only: these synthetic descriptors do not claim vault/CIFS admission. */
const withTransfer = async <T>(
  expectedId: string,
  admitUpload: (kind: 'state' | 'credentials', bytes: number) => Promise<void>,
  operation: (transfer: BackupResticTransfer, assertCurrent: () => void) => Promise<T>,
  producer = transferProducer,
  timeoutMs = 900000,
  guard: () => void = () => {},
) =>
  withVerifiedResticBinary(binary, async (executable) =>
    transferWriter.exclusive(async (writer) => {
      const transfer = new BackupResticTransfer({
        binary: executable,
        writer,
        repositoryId: expectedId,
        ownerDigest: transferOwner,
        password: {
          fd: passwordFd,
          assertCurrent() {
            assert(fs.fstatSync(passwordFd).isFile());
          },
        },
        repository: {
          fd: repositoryFd,
          assertCurrent() {
            assert(fs.fstatSync(repositoryFd).isDirectory());
          },
        },
        cache: {
          fd: cacheFd,
          assertCurrent() {
            guard();
            assert(fs.fstatSync(cacheFd).isDirectory());
          },
        },
        producer: (_kind, operationId) => producer(operationId),
        admitUpload,
        timeoutMs,
      });
      return operation(transfer, () => {
        writer.assertCurrent();
        executable.assertCurrent();
        assert(fs.fstatSync(passwordFd).isFile());
        assert(fs.fstatSync(repositoryFd).isDirectory());
        assert(fs.fstatSync(cacheFd).isDirectory());
      });
    }),
  );
const maintenanceOwner = 'a'.repeat(64),
  maintenanceLock = path.join(root, 'maintenance-lock');
fs.mkdirSync(maintenanceLock, { mode: 0o700 });
const maintenanceWriter = new BackupRepositoryWriter(maintenanceOwner, async (operation) => operation(maintenanceLock));
/** Real transport and kernel writer, synthetic repository credentials/scopes only. */
const maintainRepository = (admit: () => Promise<void> = async () => {}, expectedId = repositoryId) =>
  withVerifiedResticBinary(binary, async (executable) =>
    maintenanceWriter.exclusive(async (writer) =>
      new BackupResticTransfer({
        binary: executable,
        writer,
        repositoryId: expectedId,
        ownerDigest: maintenanceOwner,
        password: {
          fd: passwordFd,
          assertCurrent() {
            assert(fs.fstatSync(passwordFd).isFile());
          },
        },
        repository: {
          fd: repositoryFd,
          assertCurrent() {
            assert(fs.fstatSync(repositoryFd).isDirectory());
          },
        },
        cache: {
          fd: cacheFd,
          assertCurrent() {
            assert(fs.fstatSync(cacheFd).isDirectory());
          },
        },
        producer() {
          throw Error('maintenance_must_not_capture');
        },
        async admitUpload() {
          throw Error('maintenance_must_not_upload');
        },
      }).maintain(admit),
    ),
  );
const canary = 'COS_G02_SYNTHETIC_ENCRYPTION_CANARY_4f9b3716';
test('official pinned ARM64 binary initializes repository v2 and binds its decrypted identity', () => {
  run(['init', '--repository-version', '2']);
  const config = run(['cat', 'config']);
  repositoryId = (JSON.parse(config) as { id: string }).id;
  assert.deepEqual(verifyResticRepositoryIdentity(config, repositoryId), { version: 2, id: repositoryId });
  assert.throws(() => verifyResticRepositoryIdentity(config, 'f'.repeat(64)), /^Error: backup_repository_unverified$/);
});
test('the verified executable stays pinned across awaited work and its lease expires afterward', async () => {
  let fd = -1,
    assertCurrent!: () => void;
  await withVerifiedResticBinary(binary, async (lease) => {
    fd = lease.fd;
    assertCurrent = lease.assertCurrent;
    await new Promise<void>((resolve) => setImmediate(resolve));
    lease.assertCurrent();
    assert.match(
      execFileSync('/proc/self/fd/3', ['version'], {
        env,
        cwd: '/',
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe', fd],
      }),
      /^restic 0\.19\.1 /,
    );
  });
  assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
  assert.throws(() => assertCurrent(), /^Error: backup_artifact_unverified$/);
});
test('a changed executable path is refused before any credential command', async () => {
  const copy = path.join(root, 'verified-executable'),
    held = copy + '.held';
  fs.copyFileSync(binary, copy);
  fs.chmodSync(copy, 0o500);
  let invoked = false,
    fd = -1;
  try {
    await assert.rejects(
      withVerifiedResticBinary(copy, async (lease) => {
        fd = lease.fd;
        fs.renameSync(copy, held);
        fs.writeFileSync(copy, 'unverified substitute', { mode: 0o500 });
        lease.assertCurrent();
        invoked = true;
      }),
      /^Error: backup_artifact_unverified$/,
    );
    assert.equal(invoked, false);
    assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
  } finally {
    fs.rmSync(copy, { force: true });
    fs.rmSync(held, { force: true });
  }
});
test('an awaited private command failure closes the verified descriptor and exposes a fixed error', async () => {
  let fd = -1;
  await assert.rejects(
    withVerifiedResticBinary(binary, async (lease) => {
      fd = lease.fd;
      await new Promise<void>((resolve) => setImmediate(resolve));
      throw Error('private credential-bearing diagnostic');
    }),
    /^Error: backup_artifact_unverified$/,
  );
  assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
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
  const moduleUrl = new URL('../../modules/chief-of-staff/ops/backup-archive-producer.js', import.meta.url).href;
  const queueUrl = new URL('../../modules/chief-of-staff/ops/backup-queue.js', import.meta.url).href;
  const producer = `import {streamQueuedBackup} from ${JSON.stringify(moduleUrl)};
    import {BackupQueue} from ${JSON.stringify(queueUrl)};
    const queue = new BackupQueue('a'.repeat(64), async (_kind, operation) => operation(${JSON.stringify(area)}));
    try { await streamQueuedBackup(queue, 'state', ${JSON.stringify(operationId)}, bytes => new Promise((resolve, reject) => {
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
test('guarded transfer authenticates read-back and reconciles the same operation without uploading twice', async () => {
  await transferQueue.capture(
    'credentials',
    transferOperation,
    async (sink) => {
      sink.write('credentials/canary.json', Buffer.from(canary));
    },
    131072,
  );
  transferArchive = await streamQueuedBackup(transferQueue, 'credentials', transferOperation, async () => {});
  let admissions = 0;
  await withTransfer(
    repositoryId,
    async (kind, bytes) => {
      assert.equal(kind, 'credentials');
      assert.equal(bytes, transferArchive.bytes);
      admissions++;
    },
    async (transfer) => {
      const first = await transfer.upload('credentials', transferOperation, transferArchive);
      transferSnapshot = first.snapshotId;
      assert.equal(first.archiveSha256, transferArchive.sha256);
      assert.equal(first.archiveBytes, transferArchive.bytes);
      assert.equal(first.reconciled, false);
      const replay = await transfer.upload('credentials', transferOperation, transferArchive);
      assert.equal(replay.snapshotId, first.snapshotId);
      assert.equal(replay.reconciled, true);
    },
  );
  assert.equal(admissions, 1);
  const snapshots = JSON.parse(run(['snapshots', '--tag', 'cos-operation=' + transferOperation])) as unknown[];
  assert.equal(snapshots.length, 1);
  assert.equal((await transferQueue.pending('credentials'))[0].state, 'pending');
  assert.deepEqual(fs.readdirSync(transferCache), []);
});
test('wrong repository identity and exhausted capacity refuse transfer before a new upload', async () => {
  let admissions = 0;
  await assert.rejects(
    withTransfer(
      '0'.repeat(64),
      async () => {
        admissions++;
      },
      (transfer) => transfer.upload('credentials', transferOperation, transferArchive),
    ),
    /^Error: backup_artifact_unverified$/,
  );
  assert.equal(admissions, 0);
  const operationId = 'f84a7b2a-4f12-4b08-a9e5-31173b0c30cf';
  await assert.rejects(
    withTransfer(
      repositoryId,
      async () => {
        admissions++;
        throw Error('private capacity diagnostic');
      },
      (transfer) => transfer.upload('credentials', operationId, transferArchive),
    ),
    /^Error: backup_artifact_unverified$/,
  );
  assert.equal(admissions, 1);
  assert.deepEqual(JSON.parse(run(['snapshots', '--tag', 'cos-operation=' + operationId])), []);
});
test('fresh verification reads the exact existing encrypted archive without producer or upload admission', async () => {
  let admissions = 0,
    producers = 0;
  const before = (JSON.parse(run(['snapshots'])) as Array<{ id: string }>).map((s) => s.id);
  const verified = await withTransfer(
    repositoryId,
    async () => {
      admissions++;
      throw Error('must not admit upload');
    },
    (transfer) => transfer.verify('credentials', transferOperation, transferArchive),
    () => {
      producers++;
      throw Error('must not produce archive');
    },
  );
  assert.equal(verified.snapshotId, transferSnapshot);
  assert.equal(verified.repositoryId, repositoryId);
  assert.equal(verified.ownerDigest, transferOwner);
  assert.equal(verified.archiveSha256, transferArchive.sha256);
  assert.equal(verified.archiveBytes, transferArchive.bytes);
  assert.equal(verified.reconciled, true);
  assert.equal(admissions, 0);
  assert.equal(producers, 0);
  assert.deepEqual(
    (JSON.parse(run(['snapshots'])) as Array<{ id: string }>).map((s) => s.id),
    before,
  );
});
test('fresh verification refuses an absent operation without manufacturing a new checkpoint', async () => {
  const missing = '3469b9b3-ddd5-49d1-a349-baa769cbf0cd';
  let admissions = 0,
    producers = 0;
  await assert.rejects(
    withTransfer(
      repositoryId,
      async () => {
        admissions++;
      },
      (transfer) => transfer.verify('credentials', missing, transferArchive),
      () => {
        producers++;
        return transferProducer(missing);
      },
    ),
    /^Error: backup_artifact_unverified$/,
  );
  assert.equal(admissions, 0);
  assert.equal(producers, 0);
  assert.deepEqual(JSON.parse(run(['snapshots', '--tag', 'cos-operation=' + missing])), []);
});
test('fresh verification refuses wrong archive hashes and lengths while leaving its queued source intact', async () => {
  for (const archive of [
    { ...transferArchive, sha256: 'f'.repeat(64) },
    { ...transferArchive, bytes: transferArchive.bytes + 512 },
  ])
    await assert.rejects(
      withTransfer(
        repositoryId,
        async () => {
          throw Error('must not upload');
        },
        (transfer) => transfer.verify('credentials', transferOperation, archive),
      ),
      /^Error: backup_artifact_unverified$/,
    );
  assert.equal((await transferQueue.pending('credentials'))[0].state, 'pending');
});
test('fresh verification still checks the current repository identity before any archive readback', async () => {
  await assert.rejects(
    withTransfer(
      '0'.repeat(64),
      async () => {
        throw Error('must not upload');
      },
      (transfer) => transfer.verify('credentials', transferOperation, transferArchive),
    ),
    /^Error: backup_artifact_unverified$/,
  );
});
test('a completed writer or binary lifetime cannot be replayed as fresh verification authority', async () => {
  let expired: BackupResticTransfer | undefined;
  await withTransfer(
    repositoryId,
    async () => {},
    async (transfer) => {
      expired = transfer;
    },
  );
  assert(expired);
  await assert.rejects(
    expired.verify('credentials', transferOperation, transferArchive),
    /^Error: backup_transfer_unavailable$/,
  );
});
test('fresh verification binds the original receipt to the authenticated archive before recovering cleanup', async () => {
  const [receipt] = await transferQueue.pending('credentials');
  assert.equal(receipt.operationId, transferOperation);
  await withTransfer(
    repositoryId,
    async () => {
      throw Error('must_not_upload');
    },
    async (transfer) => {
      await transfer.verify('credentials', transferOperation, transferArchive, receipt);
      const forged = structuredClone(receipt);
      forged.files[0].name = 'credentials/foreign.json';
      await assert.rejects(
        transfer.verify('credentials', transferOperation, transferArchive, forged),
        /^Error: backup_transfer_unavailable$/,
      );
    },
  );
});
test('real remote restoration streams directly into new private files and retires only its verified isolated workspace', async () => {
  const before = snapshotMetadata(),
    staging = path.join(root, 'streamed-restore');
  fs.mkdirSync(staging, { mode: 0o700 });
  const fd = fs.openSync(staging, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    await withTransfer(
      repositoryId,
      async () => {
        throw Error('must_not_upload');
      },
      async (transfer) =>
        withIsolatedBackupRestore(
          '/proc/self/fd/' + fd,
          '5f74b367-fd8f-449c-a832-dbe40cff9ae3',
          65536,
          () => {},
          async (scope) => {
            const restored = await transfer.restore(
              'credentials',
              transferOperation,
              'a'.repeat(64),
              scope.sink,
              async () => {},
            );
            assert.equal(restored.snapshotId, transferSnapshot);
            assert.equal(restored.archiveBytes, transferArchive.bytes);
            assert.equal(restored.archiveSha256, transferArchive.sha256);
            assert.equal(fs.readFileSync(scope.directory + '/credentials/canary.json', 'utf8'), canary);
            assert.equal(fs.statSync(scope.directory + '/credentials/canary.json').mode & 0o777, 0o600);
            assert.equal(restored.receipt.ownerDigest, 'a'.repeat(64));
          },
        ),
    );
    assert.deepEqual(fs.readdirSync(staging), []);
    assert.deepEqual(snapshotMetadata(), before);
    assert.equal((await transferQueue.pending('credentials'))[0].operationId, transferOperation);
    assert.deepEqual(fs.readdirSync(transferCache), []);
  } finally {
    fs.closeSync(fd);
  }
});
test('real restoration denies a foreign receipt owner and missing checkpoint without destination files or remote changes', async () => {
  const before = snapshotMetadata(),
    staging = path.join(root, 'denied-restore');
  fs.mkdirSync(staging, { mode: 0o700 });
  const fd = fs.openSync(staging, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    for (const [op, owner] of [
      [transferOperation, 'f'.repeat(64)],
      ['3b86ed51-65c3-4a69-9f7d-21e1bf66291f', 'a'.repeat(64)],
    ]) {
      await assert.rejects(
        withIsolatedBackupRestore(
          '/proc/self/fd/' + fd,
          '5f74b367-fd8f-449c-a832-dbe40cff9ae3',
          65536,
          () => {},
          async (scope) =>
            withTransfer(
              repositoryId,
              async () => {
                throw Error('must_not_upload');
              },
              (transfer) => transfer.restore('credentials', op, owner, scope.sink, async () => {}),
            ),
        ),
        /^Error: backup_restore_workspace_unavailable$/,
      );
      assert.deepEqual(fs.readdirSync(staging), []);
    }
    assert.deepEqual(snapshotMetadata(), before);
  } finally {
    fs.closeSync(fd);
  }
});
test('real restoration refuses capacity withdrawn after its awaited repository identity without a completed destination', async () => {
  const before = snapshotMetadata(),
    staging = path.join(root, 'capacity-restore');
  fs.mkdirSync(staging, { mode: 0o700 });
  const fd = fs.openSync(staging, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let admissions = 0;
  try {
    await assert.rejects(
      withIsolatedBackupRestore(
        '/proc/self/fd/' + fd,
        '5f74b367-fd8f-449c-a832-dbe40cff9ae3',
        65536,
        () => {},
        async (scope) =>
          withTransfer(
            repositoryId,
            async () => {
              throw Error('must_not_upload');
            },
            (transfer) =>
              transfer.restore('credentials', transferOperation, 'a'.repeat(64), scope.sink, async () => {
                if (++admissions === 3) throw Error('synthetic_capacity_withdrawn');
              }),
          ),
      ),
      /^Error: backup_restore_workspace_unavailable$/,
    );
    assert.equal(admissions, 3);
    assert.deepEqual(fs.readdirSync(staging), []);
    assert.deepEqual(snapshotMetadata(), before);
  } finally {
    fs.closeSync(fd);
  }
});
test('real restoration handles long PAX paths and empty files through bounded streaming sinks', async () => {
  const op = 'ea948d0b-d06d-4335-94a1-e99b446d40a3',
    name = 'artifacts/' + 'a'.repeat(64) + '-' + 'b'.repeat(64) + '.blob';
  await transferQueue.capture(
    'credentials',
    op,
    async (sink) => {
      sink.write(name, Buffer.alloc(150000, 0x41));
      sink.write('empty', Buffer.alloc(0));
    },
    262144,
  );
  const archive = await streamQueuedBackup(transferQueue, 'credentials', op, async () => {}),
    staging = path.join(root, 'pax-restore');
  fs.mkdirSync(staging, { mode: 0o700 });
  const fd = fs.openSync(staging, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    await withTransfer(
      repositoryId,
      async () => {},
      async (transfer, current) => {
        await transfer.upload('credentials', op, archive);
        await withIsolatedBackupRestore(
          '/proc/self/fd/' + fd,
          '5f74b367-fd8f-449c-a832-dbe40cff9ae3',
          262144,
          () => {},
          async (scope) => {
            const result = await transfer.restore('credentials', op, 'a'.repeat(64), scope.sink, async () => {});
            assert.equal(result.archiveBytes, archive.bytes);
            assert.equal(result.archiveSha256, archive.sha256);
            assert.deepEqual(fs.readFileSync(scope.directory + '/' + name), Buffer.alloc(150000, 0x41));
            assert.equal(fs.statSync(scope.directory + '/empty').size, 0);
          },
        );
        await transferQueue.retirePending('credentials', op, async (request) => ({
          checkpoint: await transfer.verify('credentials', op, request.archive, request.receipt),
          assertCurrent: current,
        }));
      },
    );
    assert.deepEqual(fs.readdirSync(staging), []);
    assert.deepEqual(
      (await transferQueue.pending('credentials')).map((receipt) => receipt.operationId),
      [transferOperation],
    );
  } finally {
    fs.closeSync(fd);
  }
});
test('real authenticated Restic data with noncanonical application framing is refused before file extraction', async () => {
  const op = 'f32b1639-fb26-4627-b1d9-76b19c029c74';
  run(
    [
      'backup',
      '--stdin',
      '--stdin-filename',
      'checkpoint.tar',
      '--host',
      backupRepositoryHost(transferOwner),
      ...backupSnapshotTags(transferOwner, 'credentials', op).flatMap((tag) => ['--tag', tag]),
    ],
    Buffer.alloc(2048, 0x41),
  );
  const before = snapshotMetadata(),
    staging = path.join(root, 'framing-restore');
  fs.mkdirSync(staging, { mode: 0o700 });
  const fd = fs.openSync(staging, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    await assert.rejects(
      withIsolatedBackupRestore(
        '/proc/self/fd/' + fd,
        '5f74b367-fd8f-449c-a832-dbe40cff9ae3',
        65536,
        () => {},
        async (scope) =>
          withTransfer(
            repositoryId,
            async () => {
              throw Error('must_not_upload');
            },
            (transfer) => transfer.restore('credentials', op, 'a'.repeat(64), scope.sink, async () => {}),
          ),
      ),
      /^Error: backup_restore_workspace_unavailable$/,
    );
    assert.deepEqual(fs.readdirSync(staging), []);
    assert.deepEqual(snapshotMetadata(), before);
  } finally {
    fs.closeSync(fd);
  }
});
test('real streaming restoration stops on scope withdrawal and holds only its new private residue', async () => {
  const staging = path.join(root, 'withdrawn-restore'),
    before = snapshotMetadata();
  fs.mkdirSync(staging, { mode: 0o700 });
  const fd = fs.openSync(staging, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let allowed = true,
    writes = 0;
  const guard = () => {
    if (!allowed) throw Error('synthetic_scope_withdrawn');
  };
  try {
    await assert.rejects(
      withIsolatedBackupRestore(
        '/proc/self/fd/' + fd,
        '5f74b367-fd8f-449c-a832-dbe40cff9ae3',
        65536,
        guard,
        async (scope) =>
          withTransfer(
            repositoryId,
            async () => {
              throw Error('must_not_upload');
            },
            (transfer) =>
              transfer.restore(
                'credentials',
                transferOperation,
                'a'.repeat(64),
                {
                  async open(name, bytes) {
                    const file = await scope.sink.open(name, bytes);
                    return {
                      ...file,
                      async write(chunk) {
                        await file.write(chunk);
                        writes++;
                        allowed = false;
                      },
                    };
                  },
                },
                async () => {},
              ),
            transferProducer,
            900000,
            guard,
          ),
      ),
      /^Error: backup_restore_workspace_unavailable$/,
    );
    assert.equal(writes, 1);
    assert.equal(
      fs.readFileSync(staging + '/.cos-restore-5f74b367-fd8f-449c-a832-dbe40cff9ae3/credentials/canary.json', 'utf8'),
      canary,
    );
    assert.deepEqual(snapshotMetadata(), before);
  } finally {
    fs.closeSync(fd);
  }
});
test('a mismatched remote archive cannot be acknowledged as a verified checkpoint', async () => {
  await assert.rejects(
    withTransfer(
      repositoryId,
      async () => {
        throw Error('must not upload');
      },
      (transfer) => transfer.upload('credentials', transferOperation, { ...transferArchive, sha256: 'f'.repeat(64) }),
    ),
    /^Error: backup_artifact_unverified$/,
  );
  assert.equal((await transferQueue.pending('credentials'))[0].state, 'pending');
  assert.equal(
    (JSON.parse(run(['snapshots', '--tag', 'cos-operation=' + transferOperation])) as Array<{ id: string }>)[0].id,
    transferSnapshot,
  );
});
test('guarded transfer refuses a failed command producer and retains the queued source', async () => {
  const operationId = 'f13a8f4d-a9c6-4e09-93e4-8a49d0c71794';
  await assert.rejects(
    withTransfer(
      repositoryId,
      async () => {},
      (transfer) => transfer.upload('credentials', operationId, transferArchive),
      () => [process.execPath, '-e', 'process.stdout.write(Buffer.alloc(65536), () => {process.exitCode=77;});'],
    ),
    /^Error: backup_artifact_unverified$/,
  );
  assert.deepEqual(JSON.parse(run(['snapshots', '--tag', 'cos-operation=' + operationId])), []);
  assert.equal((await transferQueue.pending('credentials'))[0].state, 'pending');
  run(['check', '--read-data']);
});
test('a stalled producer is terminated within the transfer deadline without leaving a live child or snapshot', async () => {
  const operationId = 'ab95ee82-2a4d-478b-a0bd-df0215495f18';
  const pidFile = path.join(root, 'stalled-producer-pid');
  const code = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
  const started = Date.now();
  await assert.rejects(
    withTransfer(
      repositoryId,
      async () => {},
      (transfer) => transfer.upload('credentials', operationId, transferArchive),
      () => [process.execPath, '-e', code],
      1000,
    ),
    /^Error: backup_artifact_unverified$/,
  );
  assert(Date.now() - started < 15000);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert(Number.isSafeInteger(pid) && pid > 1);
  try {
    const status = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    assert.match(status, /^\d+ \([^)]*\) Z /);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  assert.deepEqual(JSON.parse(run(['snapshots', '--tag', 'cos-operation=' + operationId])), []);
});
test('withdrawn live permission terminates a quiet real producer without waiting for its upload deadline', async () => {
  const operationId = 'dfb0c89e-6362-4f94-a495-dc7bce4bba86',
    pidFile = path.join(root, 'withdrawn-producer-pid');
  let open = true,
    timer: NodeJS.Timeout | undefined;
  const code = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const started = Date.now();
  try {
    await assert.rejects(
      withTransfer(
        repositoryId,
        async () => {},
        (transfer) => transfer.upload('credentials', operationId, transferArchive),
        () => {
          timer = setTimeout(() => {
            open = false;
          }, 1500);
          return [process.execPath, '-e', code];
        },
        900000,
        () => {
          if (!open) throw Error('fixture_permission_withdrawn');
        },
      ),
      /^Error: backup_artifact_unverified$/,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
  assert(Date.now() - started < 15000);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert(Number.isSafeInteger(pid) && pid > 1);
  try {
    assert.match(fs.readFileSync('/proc/' + pid + '/stat', 'utf8'), /^\d+ \([^)]*\) Z /);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  assert.deepEqual(JSON.parse(run(['snapshots', '--tag', 'cos-operation=' + operationId])), []);
});
test('real maintenance keeps 14 daily and four weekly checkpoints per kind without touching unrelated snapshots', async () => {
  const owner = 'a'.repeat(64),
    host = backupRepositoryHost(owner);
  const foreign = (JSON.parse(run(['snapshots'])) as Array<{ id: string }>).map((snapshot) => snapshot.id);
  const selected = (kind: 'state' | 'credentials') =>
    JSON.parse(run(['snapshots', '--host', host, '--tag', 'cos-owner=' + owner + ',cos-kind=' + kind])) as Array<{
      id: string;
    }>;
  for (const [kindIndex, kind] of (['state', 'credentials'] as const).entries()) {
    const dates = [
      '2026-08-31 03:30:00',
      ...Array.from({ length: 18 }, (_, day) => '2026-09-' + String(day + 10).padStart(2, '0') + ' 03:30:00'),
    ];
    if (kind === 'credentials') dates.push('2026-09-27 04:30:00');
    for (const [index, time] of dates.entries()) {
      const operationId = '0000000' + (kindIndex + 1) + '-0000-4000-8000-' + String(index + 1).padStart(12, '0');
      run(
        [
          'backup',
          '--stdin',
          '--stdin-filename',
          'checkpoint.tar',
          '--host',
          host,
          '--time',
          time,
          ...backupSnapshotTags(owner, kind, operationId).flatMap((tag) => ['--tag', tag]),
        ],
        Buffer.from('synthetic-retention-checkpoint'),
      );
    }
    assert.equal(selected(kind).length, dates.length);
  }
  run(backupRetentionArguments(owner, 'state', 'preview'));
  assert.equal(selected('state').length, 19);
  assert.equal(selected('credentials').length, 20);
  const result = await maintainRepository();
  assert.deepEqual(result.state, { retained: 16, removed: 3 });
  assert.deepEqual(result.credentials, { retained: 16, removed: 4 });
  assert.equal(result.integrity, 'verified');
  assert.equal(selected('state').length, 16);
  assert.equal(selected('credentials').length, 16);
  const retained = new Set((JSON.parse(run(['snapshots'])) as Array<{ id: string }>).map((snapshot) => snapshot.id));
  for (const id of foreign) assert(retained.has(id));
  assert.deepEqual(fs.readdirSync(transferCache), []);
  assert.deepEqual(verifyResticRepositoryIdentity(run(['cat', 'config']), repositoryId), {
    version: 2,
    id: repositoryId,
  });
});
test('real maintenance replay verifies unchanged retained snapshots without another deletion', async () => {
  const before = (JSON.parse(run(['snapshots'])) as Array<{ id: string }>).map((s) => s.id).sort();
  const result = await maintainRepository();
  assert.deepEqual(result.state, { retained: 16, removed: 0 });
  assert.deepEqual(result.credentials, { retained: 16, removed: 0 });
  assert.deepEqual((JSON.parse(run(['snapshots'])) as Array<{ id: string }>).map((s) => s.id).sort(), before);
});
test('capacity withdrawal and wrong repository identity refuse real retention with all snapshot IDs intact', async () => {
  const before = snapshotMetadata();
  await assert.rejects(
    maintainRepository(async () => {
      throw Error('fixture_capacity_exhausted');
    }),
    /^Error: backup_artifact_unverified$/,
  );
  await assert.rejects(
    maintainRepository(async () => {}, 'f'.repeat(64)),
    /^Error: backup_artifact_unverified$/,
  );
  assert.deepEqual(snapshotMetadata(), before);
});
test('full data integrity failure refuses real maintenance before forgetting snapshots or pruning data', async () => {
  const files = (directory: string): string[] =>
    fs.readdirSync(directory).flatMap((name) => {
      const file = path.join(directory, name);
      return fs.lstatSync(file).isDirectory() ? files(file) : [file];
    });
  const file = files(path.join(repository, 'data'))[0],
    original = fs.readFileSync(file),
    changed = Buffer.from(original);
  const before = snapshotMetadata();
  const mode = fs.statSync(file).mode & 0o777;
  // Restic deliberately writes immutable read-only packs. Only this disposable
  // synthetic fixture permits a byte change to exercise full data verification.
  fs.chmodSync(file, 0o600);
  try {
    changed[0] ^= 1;
    fs.writeFileSync(file, changed);
    await assert.rejects(maintainRepository(), /^Error: backup_artifact_unverified$/);
    assert.deepEqual(snapshotMetadata(), before);
    assert.deepEqual(fs.readFileSync(file), changed);
  } finally {
    fs.writeFileSync(file, original);
    fs.chmodSync(file, mode);
    original.fill(0);
    changed.fill(0);
  }
  run(['check', '--read-data']);
});
test('real remote receipt verification recovers interrupted queue retirement and preserves a newer snapshot on replay', async () => {
  const local = path.join(transferArea, 'backup-queue', transferOperation, 'data', 'credentials', 'canary.json');
  const before = (JSON.parse(run(['snapshots'])) as Array<{ id: string }>).map((value) => value.id).sort();
  await assert.rejects(
    withTransfer(
      repositoryId,
      async () => {
        throw Error('must_not_upload');
      },
      async (transfer, current) =>
        transferQueue.retirePending('credentials', transferOperation, async (request) => ({
          checkpoint: await transfer.verify('credentials', transferOperation, request.archive, request.receipt),
          assertCurrent() {
            current();
            if (!fs.existsSync(local)) throw Error('synthetic_interruption_after_first_removal');
          },
        })),
    ),
    /^Error: backup_artifact_unverified$/,
  );
  assert(!fs.existsSync(local));
  assert.equal((await transferQueue.pending('credentials'))[0].state, 'failed');
  let fresh = 0;
  const recovered = await withTransfer(
    repositoryId,
    async () => {
      throw Error('must_not_upload');
    },
    async (transfer, current) =>
      transferQueue.retirePending('credentials', transferOperation, async (request) => {
        fresh++;
        assert.equal(request.previous?.snapshotId, transferSnapshot);
        return {
          checkpoint: await transfer.verify('credentials', transferOperation, request.archive, request.receipt),
          assertCurrent: current,
        };
      }),
  );
  assert.equal(fresh, 1);
  assert.equal(recovered.snapshotId, transferSnapshot);
  assert.deepEqual(await transferQueue.pending('credentials'), []);
  const next = 'fcc02583-4134-45ad-9aab-6a975ffb53cb';
  await transferQueue.capture(
    'credentials',
    next,
    async (sink) => sink.write('next.json', Buffer.from('synthetic-newer-snapshot')),
    65536,
  );
  await withTransfer(
    repositoryId,
    async () => {
      throw Error('must_not_upload');
    },
    async (transfer, current) =>
      transferQueue.retirePending('credentials', transferOperation, async (request) => ({
        checkpoint: await transfer.verify('credentials', transferOperation, request.archive, request.receipt),
        assertCurrent: current,
      })),
  );
  assert.equal((await transferQueue.pending('credentials'))[0].operationId, next);
  assert.deepEqual((JSON.parse(run(['snapshots'])) as Array<{ id: string }>).map((value) => value.id).sort(), before);
  run(['check', '--read-data']);
});
test('real restoration still recovers the original checkpoint after its queued plaintext source has been retired', async () => {
  const staging = path.join(root, 'retired-source-restore'),
    before = snapshotMetadata();
  fs.mkdirSync(staging, { mode: 0o700 });
  const fd = fs.openSync(staging, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  assert(!fs.existsSync(path.join(transferArea, 'backup-queue', transferOperation, 'data')));
  try {
    await withTransfer(
      repositoryId,
      async () => {
        throw Error('must_not_upload');
      },
      (transfer) =>
        withIsolatedBackupRestore(
          '/proc/self/fd/' + fd,
          '5f74b367-fd8f-449c-a832-dbe40cff9ae3',
          65536,
          () => {},
          async (scope) => {
            const restored = await transfer.restore(
              'credentials',
              transferOperation,
              'a'.repeat(64),
              scope.sink,
              async () => {},
            );
            assert.equal(restored.snapshotId, transferSnapshot);
            assert.equal(restored.archiveSha256, transferArchive.sha256);
            assert.equal(fs.readFileSync(scope.directory + '/credentials/canary.json', 'utf8'), canary);
          },
        ),
    );
    assert.deepEqual(fs.readdirSync(staging), []);
    assert.deepEqual(snapshotMetadata(), before);
  } finally {
    fs.closeSync(fd);
  }
});
after(() => {
  for (const fd of [passwordFd, repositoryFd, binaryFd, cacheFd]) fs.closeSync(fd);
  fs.rmSync(root, { recursive: true, force: true });
});
