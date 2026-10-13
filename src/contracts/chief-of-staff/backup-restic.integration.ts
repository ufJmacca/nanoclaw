import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { after, test } from 'node:test';
import type pg from 'pg';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { verifyRecoveredTargetVaultState } from '../../modules/chief-of-staff/ops/backup-recovered-state.js';
import { restoreRecoveredCoordinatedTestScope } from '../../modules/chief-of-staff/ops/coordinated-backup.js';
import { withPinnedBackupTestRestoreReservation } from '../../modules/chief-of-staff/ops/backup-test-restore-reservation.js';
import { databaseFingerprint, databasePhysicalFingerprint } from '../../modules/chief-of-staff/ops/target-identity.js';
import { parseBackupOwnerRestoreArguments } from '../../modules/chief-of-staff/ops/backup-owner-restore-arguments.js';
import {
  parseOwnerAdminArguments,
  selectedOwnerAdminProfile,
} from '../../modules/chief-of-staff/ops/target-owner-admin.js';
import type { DeploymentSettings } from '../../modules/chief-of-staff/ops/deployment-settings.js';
import { targetBinding } from '../../modules/chief-of-staff/ops/target-host.js';
import {
  initializeTarget,
  protectTarget,
  readPrivate,
  writeAtomic,
} from '../../modules/chief-of-staff/ops/target-state.js';
import {
  beginMaintenance,
  confirmQuiescence,
  finishMaintenance,
} from '../../modules/chief-of-staff/ops/maintenance.js';
import { initializeTargetActionWitness } from '../../modules/chief-of-staff/actions/host-ownership.js';
import { openKnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/config.js';
import { captureCalendarState } from '../../modules/chief-of-staff/calendar/backup.js';
import { configureCalendarStorage } from '../../modules/chief-of-staff/calendar/storage-policy.js';
import type { StorageInspection } from '../../modules/chief-of-staff/calendar/storage-protection.js';
import type { BackupSnapshotSink } from '../../modules/chief-of-staff/ops/backup-queue.js';
import type {
  ForensicCapturePrefix,
  ForensicCaptureReceipt,
} from '../../modules/chief-of-staff/ops/backup-recovered-tree.js';
import { captureOperationsState } from '../../modules/chief-of-staff/ops/recovery-manifest.js';
import {
  capturePrivateHistory,
  verifyRecoveredPrivateHistory,
} from '../../modules/chief-of-staff/ops/private-history-backup.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../../modules/chief-of-staff/store/migrations.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import { BackupQueue } from '../../modules/chief-of-staff/ops/backup-queue.js';
import { BackupResticTransfer } from '../../modules/chief-of-staff/ops/backup-restic-transfer.js';
import { BackupResticInitializer } from '../../modules/chief-of-staff/ops/backup-restic-initialize.js';
import { initializePinnedBackupRepository } from '../../modules/chief-of-staff/ops/backup-repository-initialize.js';
import { initializeBackupRepair } from '../../modules/chief-of-staff/ops/backup-initialization-repair.js';
import { fixtureVaultRelease } from './release-fixture.js';
import { BackupRepositoryWriter } from '../../modules/chief-of-staff/ops/backup-repository-lease.js';
import { streamQueuedBackup } from '../../modules/chief-of-staff/ops/backup-archive-producer.js';
import { withIsolatedBackupRestore } from '../../modules/chief-of-staff/ops/backup-restore-workspace.js';
import { pinKernelMountTable } from '../../modules/chief-of-staff/ops/kernel-mount-guard.js';
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
const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js',
  // Producers inherit the measured backup cache as TMPDIR; the source loader
  // must not leave its own files there or add a wrapper process around writers.
  childImports =
    extension === 'ts'
      ? [
          '--import',
          'data:text/javascript,' +
            encodeURIComponent(
              `process.env.TSX_DISABLE_CACHE='1';await import(${JSON.stringify(import.meta.resolve('tsx'))});`,
            ),
        ]
      : [];
const moduleUrl = (name: string) =>
  new URL('../../modules/chief-of-staff/ops/' + name + '.' + extension, import.meta.url).href;
const binary = process.env.COS_BACKUP_FIXTURE_BINARY;
if (!binary) throw Error('backup_fixture_artifact_required');
verifyResticBinary(binary);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-restic-fixture-'));
fs.chmodSync(root, 0o700);
const share = path.join(root, 'initialization-share'),
  repository = path.join(share, 'restic'),
  restore = path.join(root, 'restore');
fs.mkdirSync(share, { mode: 0o700 });
fs.mkdirSync(restore, { mode: 0o700 });
const password = path.join(root, 'fixture-password');
fs.writeFileSync(password, 'synthetic-fixture-password-no-live-authority\n', { mode: 0o600 });
const passwordFd = fs.openSync(password, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
let repositoryFd: number;
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
  const queueUrl = moduleUrl('backup-queue');
  const producerUrl = moduleUrl('backup-archive-producer');
  return [
    process.execPath,
    ...childImports,
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
test('compiled recovery rejects connection aliases as evidence of database separation and accepts only fixed owner selections', async () => {
  const client = {
      query: async () => ({
        rows: [
          { database: 'synthetic-test', database_oid: '12345', server_address: '192.168.56.20', server_port: 5432 },
        ],
      }),
    } as unknown as pg.Client,
    original = {
      host: 'fixture-db.lan',
      port: 5432,
      database: 'synthetic-test',
      ssl: { rejectUnauthorized: true, ca: 'synthetic-ca' },
    },
    alias = {
      ...original,
      host: 'alias-db.lan',
      port: 6543,
      ssl: { rejectUnauthorized: true, ca: 'other-synthetic-ca' },
    };
  assert.notEqual(await databaseFingerprint(client, original), await databaseFingerprint(client, alias));
  assert.equal(await databasePhysicalFingerprint(client, original), await databasePhysicalFingerprint(client, alias));
  const args = [
    'backup-restore-check',
    '--scope',
    'synthetic-scope',
    '--request-id',
    randomUUID(),
    '--backup-operation-id',
    randomUUID(),
    '--backup-release',
    'release-synthetic',
    '--snapshot-digest',
    'a'.repeat(64),
  ];
  assert.equal(parseBackupOwnerRestoreArguments(args).command, 'backup-restore-check');
  assert.deepEqual(
    parseOwnerAdminArguments([
      '--settings',
      '/synthetic/settings.json',
      '--database-environment',
      '/synthetic/test.env',
      '--',
      ...args,
    ]),
    { settings: '/synthetic/settings.json', databaseEnvironment: '/synthetic/test.env', admin: args },
  );
  assert.throws(
    () => parseOwnerAdminArguments(['--settings', '/synthetic/settings.json', '--', ...args]),
    /^Error: invalid_owner_admin_arguments$/,
  );
  const test = { COS_TEST_TARGET_ID: 'synthetic-test' };
  assert.equal(
    await selectedOwnerAdminProfile('backup-restore-check', {
      runtime: () => {
        throw Error('runtime_profile_must_not_be_forwarded');
      },
      test: () => test,
    }),
    test,
  );
  assert.throws(
    () => parseBackupOwnerRestoreArguments([...args, '--root', '/foreign']),
    /^Error: invalid_owner_admin_arguments$/,
  );
  assert.throws(() => parseBackupOwnerRestoreArguments(args.slice(0, -2)), /^Error: invalid_owner_admin_arguments$/);
});
test('official pinned ARM64 binary initializes repository v2 and binds its decrypted identity', async () => {
  const directory = path.join(root, 'initialization-metadata'),
    lock = path.join(root, 'initialization-lock');
  for (const folder of [directory, lock]) fs.mkdirSync(folder, { mode: 0o700 });
  const shareFd = fs.openSync(share, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW),
    before = fs.fstatSync(shareFd);
  const shareScope = {
    fd: shareFd,
    assertCurrent() {
      const stat = fs.lstatSync(share);
      assert.equal(stat.ino, before.ino);
      assert.equal(stat.dev, before.dev);
      assert.equal(stat.mode & 0o777, 0o700);
    },
  };
  let creates = 0;
  try {
    await withVerifiedResticBinary(binary, async (executable) =>
      new BackupRepositoryWriter('1'.repeat(64), async (work) => work(lock)).exclusive(async (writer) => {
        const check = async () => {
          shareScope.assertCurrent();
          writer.assertCurrent();
          executable.assertCurrent();
        };
        const ports = {
          roots: { targetRoot: root + '/state', installationRoot: root + '/install', dataRoot: root + '/data' },
          filesystemUuid: randomUUID(),
          credentialReference: randomUUID(),
          operationId: randomUUID(),
          mount: { host: '192.168.56.12', share: 'nanoclaw-cos-backups' as const, mount: share },
          directory,
          share: shareScope,
          writer,
          check,
          // This repository suite models NAS/vault admission; the signed-kernel
          // gate exercises the same engine through its default admission port.
          openRepository: async <T>(
            _share: typeof shareScope,
            work: (scope: { fd: number; assertCurrent(): void }) => Promise<T>,
          ) => {
            const fd = fs.openSync(
                repository,
                fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
              ),
              initial = fs.fstatSync(fd);
            try {
              return await work({
                fd,
                assertCurrent() {
                  shareScope.assertCurrent();
                  const stat = fs.lstatSync(repository);
                  assert.equal(stat.ino, initial.ino);
                  assert.equal(stat.dev, initial.dev);
                  assert.equal(stat.mode & 0o777, 0o700);
                },
              });
            } finally {
              fs.closeSync(fd);
            }
          },
          restic: (selected: { fd: number; assertCurrent(): void }) => {
            const utility = new BackupResticInitializer(
              {
                binary: executable,
                writer,
                repository: selected,
                password: {
                  fd: passwordFd,
                  assertCurrent() {
                    assert(fs.fstatSync(passwordFd).isFile());
                  },
                },
                cache: {
                  fd: cacheFd,
                  assertCurrent() {
                    assert(fs.fstatSync(cacheFd).isDirectory());
                  },
                },
              },
              check,
            );
            return {
              identify: () => utility.identify(),
              create: async () => {
                creates++;
                await utility.create();
                throw Error('SYNTHETIC_LOST_INITIALIZATION_ACK');
              },
            };
          },
        };
        await assert.rejects(
          initializePinnedBackupRepository(ports),
          /^Error: backup_repository_initialization_unavailable$/,
        );
        const original = fs.lstatSync(repository).ino;
        const result = await initializePinnedBackupRepository(ports);
        assert.equal(result.status, 'backup_repository_initialized');
        assert.equal(creates, 1);
        assert.equal(fs.lstatSync(repository).ino, original);
        repositoryId = result.repositoryId as string;
        assert.match(repositoryId, /^[a-f0-9]{64}$/);
        const profile = path.join(directory, 'backup-repository.json'),
          profileInode = fs.lstatSync(profile).ino;
        // Exercise the same guarded repair job in the source and immutable
        // host suites with the real pinned utility and authenticated repository.
        // NAS/vault admission and source identities here remain synthetic.
        const runtime = fixtureVaultRelease('G02'),
          helper = fixtureVaultRelease('G02'),
          jobRoot = root + '/repair-job-state',
          binding = {
            hostFingerprint: 'a'.repeat(64),
            databaseFingerprint: 'b'.repeat(64),
            service: 'fixture.service',
            installationRoot: ports.roots.installationRoot,
            dataRoot: ports.roots.dataRoot,
          };
        helper.releaseId = 'release-initialization-repair';
        helper.source = { ...helper.source, commit: '2'.repeat(40), tree: '3'.repeat(40) };
        const repairSeal = {
          ...helper.vaultArtifact!.seal,
          sourceCommit: helper.source.commit,
          sourceTree: helper.source.tree,
        };
        helper.vaultArtifact = { digest: digest(repairSeal), seal: repairSeal };
        for (const check of Object.values(helper.checks)) check.sourceCommit = helper.source.commit;
        helper.previousReleaseIds = [runtime.releaseId];
        initializeTarget(jobRoot, binding);
        const state = protectTarget(jobRoot, binding);
        writeAtomic(jobRoot, 'maintenance.json', {
          version: 1,
          bindingDigest: digest(binding),
          nonce: randomUUID(),
          owner: 'fixture',
          purpose: 'deployment',
          generation: state.generation,
          phase: 'complete',
          reopen: true,
        });
        writeAtomic(jobRoot, 'state.json', {
          ...state,
          releaseId: runtime.releaseId,
          maintenance: false,
          maintenanceHistory: true,
          generation: state.generation + 1,
        });
        const pendingRoot = root + '/initialization-pending';
        fs.mkdirSync(pendingRoot, { mode: 0o700 });
        const pending = new BackupQueue('a'.repeat(64), async (_kind, work) => work(pendingRoot)),
          pendingId = randomUUID();
        await pending.capture(
          'state',
          pendingId,
          async (sink) => {
            await sink.write('state.json', Buffer.from('synthetic-checkpoint-must-survive-repair'));
          },
          65536,
        );
        const queueBefore = await pending.inspect('state'),
          stateBefore = fs.readFileSync(jobRoot + '/state.json');
        const replay = await initializeBackupRepair({
          root: jobRoot,
          binding,
          requestId: randomUUID(),
          effects: {
            verifyRepair: async () => ({ runtime, helper }),
            healthy: async () => true,
            mount: async (guard) => guard(),
            initialize: async (_manifest, operationId, guard, current) => {
              guard();
              await current();
              const selected = await initializePinnedBackupRepository({ ...ports, operationId });
              guard();
              await current();
              return selected;
            },
          },
        });
        assert.equal(replay.releaseId, runtime.releaseId);
        assert.equal(replay.helperReleaseId, helper.releaseId);
        assert.equal(replay.activation, 'not_performed');
        assert.deepEqual(replay.runtimeSource, runtime.source);
        assert.deepEqual(replay.helperSource, helper.source);
        assert.deepEqual(await pending.inspect('state'), queueBefore);
        assert.deepEqual(fs.readFileSync(jobRoot + '/state.json'), stateBefore);
        assert.equal(replay.status, 'backup_repository_bound');
        assert.equal(replay.repositoryId, repositoryId);
        assert.equal(creates, 1);
        assert.equal(fs.lstatSync(profile).ino, profileInode);
      }),
    );
  } finally {
    fs.closeSync(shareFd);
  }
  repositoryFd = fs.openSync(repository, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const config = run(['cat', 'config']);
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
    assert.notEqual(fd, -1, 'copied executable must be admitted before testing path replacement');
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
  const producerUrl = moduleUrl('backup-archive-producer');
  const queueUrl = moduleUrl('backup-queue');
  const producer = `import {streamQueuedBackup} from ${JSON.stringify(producerUrl)};
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
    ...childImports,
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
test('real remote recovery shares measured staging and the actual checkpoint writer while preserving pending state', async () => {
  const staging = path.join(root, 'shared-writer-restore'),
    journals = path.join(root, 'shared-writer-journals');
  for (const directory of [staging, journals]) fs.mkdirSync(directory, { mode: 0o700 });
  const queue = new BackupQueue('a'.repeat(64), async (kind, operation) =>
    operation(kind === 'state' ? staging : journals),
  );
  const pendingId = '51c35ef0-b3e2-4270-b642-3da99ea63f4c';
  await queue.capture('state', pendingId, async (sink) => sink.write('current-state', Buffer.from('PRESERVE')), 65536);
  const before = await queue.pending('state'),
    remoteBefore = snapshotMetadata(),
    currentKernel = pinKernelMountTable();
  await withTransfer(
    repositoryId,
    async () => {
      throw Error('must_not_upload');
    },
    async (transfer, current) =>
      queue.withRestoreWorkspace(
        '5f74b367-fd8f-449c-a832-dbe40cff9ae3',
        () => {
          currentKernel();
          current();
        },
        async (scope) => {
          const result = await transfer.restore(
            'credentials',
            transferOperation,
            'a'.repeat(64),
            scope.sink,
            async () => {
              scope.assertCurrent();
              await assert.rejects(
                queue.capture('state', 'f7d1e82b-0a13-4607-a81f-14a9fc442e1a', async () => {}, 65536),
                /^Error: backup_queue_unavailable$/,
              );
            },
          );
          assert.equal(result.archiveSha256, transferArchive.sha256);
          assert.equal(fs.readFileSync(scope.directory + '/credentials/canary.json', 'utf8'), canary);
          await queue.capture(
            'credentials',
            pendingId,
            async (sink) => sink.write('independent', Buffer.from('SYNTHETIC')),
            65536,
          );
          assert.deepEqual(await queue.pending('state'), before);
          scope.assertCurrent();
        },
        64 * 1024 ** 2,
      ),
  );
  assert.deepEqual(fs.readdirSync(staging), ['backup-queue']);
  assert.deepEqual(await queue.pending('state'), before);
  assert.equal((await queue.pending('credentials'))[0].operationId, pendingId);
  assert.deepEqual(snapshotMetadata(), remoteBefore);
  assert.deepEqual(fs.readdirSync(transferCache), []);
});
async function completeCapturedPayloadRecovery(
  captureMode: 'operator' | 'predeployment',
  mismatch?: 'owner' | 'nonce' | 'source-release',
) {
  const base = path.join(root, 'payload-recovery-' + captureMode + (mismatch ? '-' + mismatch : '')),
    staging = base + '/staging',
    source = base + '/source';
  fs.mkdirSync(base, { mode: 0o700 });
  for (const directory of [staging, base + '/backup-credentials', base + '/journals', base + '/calendar-backups'])
    fs.mkdirSync(directory, { mode: 0o700 });
  const settings: DeploymentSettings = {
    version: 1,
    target: 'pi',
    sshAlias: 'fixture',
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: digest('synthetic-runtime-database'),
    service: 'nano.service',
    userHome: base,
    installationRoot: base + '/app',
    dataRoot: base + '/app/data',
    stateRoot: source,
    releaseRoot: base + '/releases',
    stagingRoot: staging,
    sourceRoot: base + '/sources',
    runtimeEnvironment: base + '/.config/runtime',
    migrationEnvironment: base + '/.config/migration',
  };
  fs.mkdirSync(settings.dataRoot, { recursive: true, mode: 0o700 });
  const initial = initializeTarget(source, targetBinding(settings)),
    operatorOperationId = '285cd0bd-2af0-49d0-a9e8-c47dd53c9a39',
    releaseOperationId =
      captureMode === 'operator' ? 'release-action-' + operatorOperationId : 'release-ded6909b6b4f-20261013093014';
  writeAtomic(source, 'protected.json', { bindingDigest: digest(initial.binding), generation: initial.generation });
  writeAtomic(source, 'state.json', {
    ...initial,
    lifecycle: 'protected',
    releaseId: mismatch === 'source-release' ? 'release-foreign-source' : 'release-current',
  });
  const maintenance = beginMaintenance(
    source,
    initial.binding,
    mismatch === 'owner' ? 'release-foreign-owner' : releaseOperationId,
    'deployment',
  );
  const operationId =
    captureMode === 'operator' ? operatorOperationId : mismatch === 'nonce' ? randomUUID() : maintenance.nonce;
  await confirmQuiescence(source, initial.binding, maintenance, async () => ({
    activeCoordinators: 0,
    activeDatabaseOperations: 0,
  }));
  const binding = {
    scopeId: 'synthetic-scope',
    ownerId: 'owner',
    botId: 'bot',
    instanceId: 'fixture',
    channelId: 'private',
    agentGroupId: 'group',
    messagingGroupId: 'chat',
    provider: 'codex' as const,
    sessionId: 'session',
  };
  const native = new Database(settings.dataRoot + '/v2.db');
  native.pragma('journal_mode=WAL');
  native.exec(
    "CREATE TABLE messages(body TEXT); INSERT INTO messages VALUES('old message'); CREATE TABLE model_counters(consumed INTEGER); INSERT INTO model_counters VALUES(3); CREATE TABLE sessions(id TEXT,agent_group_id TEXT); CREATE TABLE cos_identity_boundaries(scope_id TEXT,agent_group_id TEXT,messaging_group_id TEXT,session_id TEXT,binding TEXT,paused INTEGER)",
  );
  native.prepare('INSERT INTO sessions VALUES(?,?)').run(binding.sessionId, binding.agentGroupId);
  native
    .prepare('INSERT INTO cos_identity_boundaries VALUES(?,?,?,?,?,1)')
    .run(binding.scopeId, binding.agentGroupId, binding.messagingGroupId, binding.sessionId, JSON.stringify(binding));
  const generation = randomUUID(),
    conversation = source + '/conversations',
    mission = source;
  fs.mkdirSync(conversation + '/' + generation + '/empty', { recursive: true, mode: 0o700 });
  fs.mkdirSync(mission + '/missions/' + generation + '/provider/empty', { recursive: true, mode: 0o700 });
  const history = conversation + '/' + generation + '/history.jsonl';
  fs.writeFileSync(history, Buffer.alloc(150000, 0x41), { mode: 0o600 });
  fs.writeFileSync(conversation + '/' + generation + '/auth.json', 'SYNTHETIC_CURRENT_AUTH', { mode: 0o600 });
  fs.writeFileSync(mission + '/missions/' + generation + '/provider/history', 'SYNTHETIC_SPECIALIST_HISTORY', {
    mode: 0o600,
  });
  const witness = initializeTargetActionWitness(source, digest(initial.binding)),
    artifacts = openKnowledgeArtifacts(source, [settings.installationRoot, settings.dataRoot]),
    restriction = source + '/state.json';
  for (const directory of [witness.root, base + '/backup-credentials', base + '/journals'])
    fs.mkdirSync(directory + '/empty', { mode: 0o700 });
  fs.writeFileSync(base + '/backup-credentials/smb-credentials', 'SYNTHETIC_SMB_PASSWORD', { mode: 0o600 });
  fs.writeFileSync(base + '/backup-credentials/restic-password', 'SYNTHETIC_RESTIC_PASSWORD', { mode: 0o600 });
  fs.writeFileSync(base + '/journals/credential-event.json', '{"event":"synthetic"}', { mode: 0o600 });
  const roots = { targetRoot: source, installationRoot: settings.installationRoot, dataRoot: settings.dataRoot },
    calendar = source + '/calendar';
  for (const directory of [calendar, calendar + '/credentials', calendar + '/access-denials', calendar + '/empty'])
    fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(calendar + '/credentials/token.json', 'SYNTHETIC_ARCHIVED_CALENDAR_TOKEN', { mode: 0o600 });
  fs.writeFileSync(calendar + '/access-denials/denial.json', 'SYNTHETIC_ARCHIVED_CALENDAR_DENIAL', { mode: 0o600 });
  // Storage inspection and process admission are explicit fixture boundaries.
  // The Calendar producer, native files, owned recovery and encrypted transport are real.
  const inspect: StorageInspection = (command, args) =>
    JSON.stringify(
      command.endsWith('/findmnt')
        ? {
            filesystems: [
              {
                target: args[args.indexOf('--target') + 1],
                source: '/dev/mapper/private',
                fstype: 'ext4',
                'maj:min': '253:0',
                uuid: 'fixture-private-volume',
              },
            ],
          }
        : {
            blockdevices: [
              { name: '/dev/mapper/private', type: 'crypt', 'maj:min': '253:0', uuid: 'fixture-private-volume' },
            ],
          },
    );
  configureCalendarStorage(roots, base + '/calendar-backups', inspect);
  // These three portable forensic receipts describe only named synthetic files.
  // Actual default forensic producers are covered by the separate database capture checks.
  const captureForensicFixture = (
    prefix: ForensicCapturePrefix,
    directory: string,
    sink: BackupSnapshotSink,
  ): ForensicCaptureReceipt => {
    const files = fs
      .readdirSync(directory)
      .sort()
      .filter((name) => name !== 'empty')
      .map((name) => {
        const bytes = fs.readFileSync(directory + '/' + name);
        try {
          sink.write(prefix + '/' + name, bytes);
          return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        } finally {
          bytes.fill(0);
        }
      });
    const receipt: ForensicCaptureReceipt = {
      contract: 'cos-private-tree-capture/v1',
      prefix,
      bytes: files.reduce((sum, item) => sum + item.bytes, 0),
      files,
      directories: ['empty'],
      excluded: [],
    };
    const bytes = Buffer.from(JSON.stringify(receipt) + '\n');
    try {
      sink.write(prefix + '.capture.json', bytes);
    } finally {
      bytes.fill(0);
    }
    return receipt;
  };
  const context = {
    scopeId: 'synthetic-scope',
    ownerId: 'owner',
    agentGroupId: 'group',
    sessionId: 'session',
    ingressId: 'operator-backup-' + releaseOperationId,
  };
  // PostgreSQL query responses are synthetic in this network-free component.
  // Actual separately admitted database capture/readback is checked independently.
  const query = async (sql: string, parameters?: string[]) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('to_regclass')) return { rows: [{ ledger: 'cos.schema_migrations' }] };
    if (sql.includes('FROM cos.schema_migrations'))
      return { rows: MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })) };
    if (sql.includes('SELECT owner_id,agent_group_id'))
      return { rows: [{ owner_id: 'owner', agent_group_id: 'group' }] };
    if (sql.includes('FROM pg_attribute'))
      return {
        rows: (parameters?.[0] === 'cos.scopes' ? ['id', 'owner_id', 'agent_group_id'] : ['scope_id']).map(
          (attname) => ({ attname }),
        ),
      };
    if (sql.includes('to_jsonb(t)'))
      return {
        rows: sql.includes('cos."scopes"')
          ? [{ body: { id: 'synthetic-scope', owner_id: 'owner', agent_group_id: 'group' } }]
          : [],
      };
    if (sql.includes('clock_timestamp')) return { rows: [{ now: new Date() }] };
    return { rows: [] };
  };
  const queue = new BackupQueue('a'.repeat(64), async (_kind, callback) => callback(staging)),
    options = {
      client: { query } as unknown as pg.Client,
      context,
      databaseFingerprint: digest('synthetic-runtime-database'),
      operationId: releaseOperationId,
      receiptRoot: source + '/actions',
      nativeDatabases: [settings.dataRoot + '/v2.db'],
      artifacts,
      restrictionFiles: [restriction, source + '/maintenance.json'],
      witness,
      quiescent: async () => ({
        generation: maintenance.generation,
        activeWorkers: 0 as const,
        activeOperations: 0 as const,
        nativeWriters: 0 as const,
        effectsEnabled: false as const,
      }),
    };
  const recoveryOptions = {
    base: options,
    software: {
      sourceCommit: '1'.repeat(40),
      sourceTree: '2'.repeat(40),
      hostPayloadSha256: '3'.repeat(64),
      schemaVersion: SCHEMA_VERSION,
      nativeSchemaVersion: 22,
    },
    externalCheckpoint: { kind: 'application_scope_logical' as const },
  };
  const recovery = {
    releaseId: 'release-current',
    manifestDigest: 'c'.repeat(64),
    software: recoveryOptions.software,
  };
  let capturedHeader!: import('../../modules/chief-of-staff/ops/backup-recovered-state.js').RecoveredCaptureHeader;
  const restoreRequest = randomUUID(),
    liveReservation = staging + '/.cos-test-restore-' + restoreRequest + '.json';
  try {
    await queue.capture(
      'state',
      operationId,
      async (sink) => {
        const captured = await captureOperationsState(recoveryOptions, sink),
          conversations = await capturePrivateHistory(conversation, sink, 'conversation'),
          missions = await capturePrivateHistory(mission, sink, 'mission'),
          effects = captureForensicFixture('effects', witness.root, sink),
          credentials = captureForensicFixture('vault-backup-credentials', base + '/backup-credentials', sink),
          journals = captureForensicFixture('vault-journals', base + '/journals', sink),
          calendarReceipt = await captureCalendarState(
            {
              roots,
              operationId: releaseOperationId,
              receiptRoot: source + '/actions',
              check: async () => {},
              inspect,
              memory: () => {},
            },
            sink,
          );
        capturedHeader = {
          contract: 'cos-target-vault-capture/v1',
          operationId: releaseOperationId,
          queueOperationId: operationId,
          targetBindingDigest: digest(initial.binding),
          nativeBindingDigest: digest(binding),
          journal: { installationDigest: witness.installationDigest, generation: witness.generation },
          maintenanceGeneration: maintenance.generation,
          nativeDatabases: options.nativeDatabases.length,
          checkpointDigest: digest(captured.checkpoint),
          conversationDigest: digest(conversations),
          missionDigest: digest(missions),
          calendarDigest: digest(calendarReceipt),
          effectsDigest: digest(effects),
          backupCredentialsDigest: digest(credentials),
          credentialJournalsDigest: digest(journals),
          inputs: {
            context,
            nativeDatabases: options.nativeDatabases,
            restrictionFiles: options.restrictionFiles,
            artifactsRoot: artifacts.root,
          },
          operations: { release: recovery, manifestDigest: digest(captured.operations) },
          writerActivated: false,
          admissionRestored: false,
        };
        const bytes = Buffer.from(JSON.stringify(capturedHeader) + '\n');
        try {
          sink.write('state-capture.json', bytes);
        } finally {
          bytes.fill(0);
        }
      },
      1024 ** 2,
    );
    const pending = await queue.pending('state');
    native.exec("INSERT INTO messages VALUES('later message'); UPDATE model_counters SET consumed=4");
    fs.appendFileSync(history, 'SYNTHETIC_CURRENT_LATER_HISTORY');
    await finishMaintenance(source, initial.binding, maintenance, async () => true);
    const laterBinding = { ...binding, sessionId: 'later-session' };
    native.prepare('INSERT INTO sessions VALUES(?,?)').run(laterBinding.sessionId, laterBinding.agentGroupId);
    native
      .prepare('UPDATE cos_identity_boundaries SET session_id=?,binding=?,paused=1')
      .run(laterBinding.sessionId, JSON.stringify(laterBinding));
    fs.writeFileSync(calendar + '/credentials/token.json', 'SYNTHETIC_LATER_CALENDAR_TOKEN', { mode: 0o600 });
    fs.writeFileSync(witness.root + '/later-event.json', 'SYNTHETIC_LATER_EFFECT', { mode: 0o600 });
    const before = {
      messages: native.prepare('SELECT * FROM messages').all(),
      counters: native.prepare('SELECT * FROM model_counters').all(),
      history: fs.readFileSync(history),
      restriction: fs.readFileSync(restriction),
      journal: fs.readFileSync(witness.root + '/owner.json'),
      token: fs.readFileSync(calendar + '/credentials/token.json'),
      effect: fs.readFileSync(witness.root + '/later-event.json'),
      binding: native.prepare('SELECT binding,paused FROM cos_identity_boundaries').get(),
    };
    const producer = () => [
      process.execPath,
      ...childImports,
      '--input-type=module',
      '-e',
      `
      import { BackupQueue } from ${JSON.stringify(moduleUrl('backup-queue'))};
      import { streamQueuedBackup } from ${JSON.stringify(moduleUrl('backup-archive-producer'))};
      const queue = new BackupQueue('a'.repeat(64), async (_kind, callback) => callback(${JSON.stringify(staging)}));
      await streamQueuedBackup(queue, 'state', ${JSON.stringify(operationId)}, bytes => new Promise((resolve, reject) => process.stdout.write(bytes, error => error ? reject(error) : resolve())));
    `,
    ];
    const archive = await streamQueuedBackup(queue, 'state', operationId, async () => {});
    await withTransfer(
      repositoryId,
      async () => {},
      async (transfer) => {
        await transfer.upload('state', operationId, archive);
      },
      producer,
    );
    const remoteBefore = snapshotMetadata();
    if (mismatch) {
      let identityDenied = false;
      await assert.rejects(
        withTransfer(
          repositoryId,
          async () => {
            throw Error('must_not_upload');
          },
          async (transfer, current) =>
            queue.withRestoreWorkspace(randomUUID(), current, async (workspace) => {
              const recovered = await transfer.restore('state', operationId, 'a'.repeat(64), workspace.sink, async () =>
                workspace.assertCurrent(),
              );
              try {
                await verifyRecoveredTargetVaultState(
                  {
                    settings,
                    binding: laterBinding,
                    witness,
                    queueOperationId: operationId,
                    recovery,
                    expectedSnapshotDigest: digest(capturedHeader),
                    current,
                  },
                  workspace,
                  recovered.receipt.files,
                );
              } catch (error) {
                assert.equal((error as Error).message, 'target_vault_recovery_check_unavailable');
                identityDenied = true;
                throw error;
              }
              throw Error('foreign_capture_identity_accepted');
            }),
        ),
        /^Error: backup_artifact_unverified$/,
      );
      assert.equal(identityDenied, true);
      assert.deepEqual(native.prepare('SELECT * FROM messages').all(), before.messages);
      assert.deepEqual(native.prepare('SELECT * FROM model_counters').all(), before.counters);
      assert.deepEqual(fs.readFileSync(witness.root + '/owner.json'), before.journal);
      assert.deepEqual(native.prepare('SELECT binding,paused FROM cos_identity_boundaries').get(), before.binding);
      assert.deepEqual(await queue.pending('state'), pending);
      assert.deepEqual(fs.readdirSync(staging), ['backup-queue']);
      assert.deepEqual(snapshotMetadata(), remoteBefore);
      return;
    }
    await withTransfer(
      repositoryId,
      async () => {
        throw Error('must_not_upload');
      },
      async (transfer, current) => {
        await queue.withRestoreWorkspace(
          randomUUID(),
          current,
          async (workspace) => {
            const recovered = await transfer.restore('state', operationId, 'a'.repeat(64), workspace.sink, async () =>
                workspace.assertCurrent(),
              ),
              instructions = await verifyRecoveredTargetVaultState(
                {
                  settings,
                  binding: laterBinding,
                  witness,
                  queueOperationId: operationId,
                  recovery,
                  expectedSnapshotDigest: digest(capturedHeader),
                  current,
                },
                workspace,
                recovered.receipt.files,
              ).catch((error: unknown) => {
                console.log(
                  JSON.stringify({
                    fixture: 'complete-capture-recovery',
                    captureMode,
                    stage: 'recovered-state-verifier',
                    status: 'failed',
                    code:
                      error instanceof Error && error.message === 'target_vault_recovery_check_unavailable'
                        ? error.message
                        : 'fixed_fixture_verification_failure',
                  }),
                );
                throw error;
              }),
              checked = instructions.coordinated;
            assert.equal(instructions.credentialsActivated, false);
            assert.equal(instructions.writerActivated, false);
            assert.deepEqual(instructions.header, capturedHeader);
            assert.equal(fs.existsSync(workspace.directory + '/calendar-state/empty'), true);
            assert.equal(fs.existsSync(workspace.directory + '/vault-journals/empty'), true);
            assert.equal(fs.existsSync(workspace.directory + '/vault-journals/.vault-canary'), false);
            await assert.rejects(
              verifyRecoveredTargetVaultState(
                {
                  settings,
                  binding: laterBinding,
                  witness,
                  queueOperationId: operationId,
                  recovery: { ...recovery, manifestDigest: 'd'.repeat(64) },
                  current,
                },
                workspace,
                recovered.receipt.files,
              ),
              /^Error: target_vault_recovery_check_unavailable$/,
            );
            let permitted = true,
              withdrawalQueued = false;
            await assert.rejects(
              verifyRecoveredTargetVaultState(
                {
                  settings,
                  binding: laterBinding,
                  witness,
                  queueOperationId: operationId,
                  recovery,
                  current() {
                    current();
                    if (!permitted) throw Error('synthetic_owner_withdrawn');
                    if (!withdrawalQueued) {
                      withdrawalQueued = true;
                      queueMicrotask(() => {
                        permitted = false;
                      });
                    }
                  },
                },
                workspace,
                recovered.receipt.files,
              ),
              /^Error: target_vault_recovery_check_unavailable$/,
            );
            assert.equal(withdrawalQueued, true);
            let journalChanged = false;
            try {
              await assert.rejects(
                verifyRecoveredTargetVaultState(
                  {
                    settings,
                    binding: laterBinding,
                    witness,
                    queueOperationId: operationId,
                    recovery,
                    current() {
                      current();
                      if (!journalChanged) {
                        journalChanged = true;
                        queueMicrotask(() =>
                          writeAtomic(witness.root, 'owner.json', {
                            format: 'cos-action-witness-owner/v1',
                            installationDigest: witness.installationDigest,
                            generation: randomUUID(),
                          }),
                        );
                      }
                    },
                  },
                  workspace,
                  recovered.receipt.files,
                ),
                /^Error: target_vault_recovery_check_unavailable$/,
              );
            } finally {
              // Only this isolated synthetic fixture journal is reset for its final preservation checks.
              writeAtomic(witness.root, 'owner.json', JSON.parse(before.journal.toString('utf8')));
            }
            assert.equal(journalChanged, true);
            workspace.assertCurrent();
            assert.equal(checked.nativeDatabasesVerified, 1);
            assert.equal(checked.admissionRestored, false);
            assert.equal(checked.eventJournalRestored, false);
            assert.equal(instructions.operations.admissionRestored, false);
            assert.equal(instructions.operations.effectsEnabled, false);
            assert.deepEqual(instructions.operations.revocations, []);
            assert.deepEqual(instructions.operations.nativeDenials, []);
            assert.equal(
              verifyRecoveredPrivateHistory(workspace, recovered.receipt.files, conversation, 'conversation').bytes,
              150000,
            );
            assert.equal(
              verifyRecoveredPrivateHistory(workspace, recovered.receipt.files, mission, 'mission').files,
              1,
            );
            workspace.withFileBytes('coordinated/sqlite/0/native.sqlite', 65536, (bytes) => {
              const copy = new Database(bytes, { readonly: true });
              try {
                assert.deepEqual(copy.prepare('SELECT * FROM model_counters').all(), [{ consumed: 3 }]);
              } finally {
                copy.close();
              }
            });
            // The encrypted transport and durable reservation are real. This
            // network-free component uses a synthetic receiving SQL protocol;
            // actual separate-database import/readback is verified independently.
            let inserts = 0,
              loseAck = true,
              transactionWrites = false,
              transactionRows: Array<Record<string, unknown>> | undefined;
            const committedRows: Array<Record<string, unknown>> = [];
            const testClient = {
              query: async (sql: string, values?: string[]) => {
                if (sql.includes('cos_admin.target_identity'))
                  return {
                    rows: [
                      {
                        target_id: 'fixture-admitted-test',
                        purpose: 'test',
                        writable: false,
                        schema_writable: false,
                        owner_member: false,
                      },
                    ],
                  };
                if (sql.includes('current_database()'))
                  return {
                    rows: [
                      {
                        database: 'fixture-test',
                        database_oid: '54321',
                        server_address: '192.168.56.20',
                        server_port: 5432,
                      },
                    ],
                  };
                if (sql === 'BEGIN' || sql.startsWith('BEGIN ISOLATION')) {
                  assert.equal(transactionRows, undefined);
                  transactionRows = structuredClone(committedRows);
                  transactionWrites = false;
                  return { rows: [] };
                }
                if (sql === 'ROLLBACK') {
                  transactionRows = undefined;
                  transactionWrites = false;
                  return { rows: [] };
                }
                if (sql === 'COMMIT') {
                  assert(transactionRows);
                  committedRows.splice(0, committedRows.length, ...transactionRows);
                  transactionRows = undefined;
                  const unknown = transactionWrites && loseAck;
                  transactionWrites = false;
                  if (unknown) {
                    loseAck = false;
                    throw Error('SYNTHETIC_COMMIT_ACK_LOST');
                  }
                  return { rows: [] };
                }
                const selected = transactionRows ?? committedRows;
                if (sql.startsWith('INSERT INTO cos.')) {
                  assert(sql.startsWith('INSERT INTO cos."scopes"'));
                  assert(transactionRows);
                  assert.equal(selected.length, 0);
                  transactionRows.push(...JSON.parse(values![0]));
                  transactionWrites = true;
                  inserts++;
                  return { rows: [] };
                }
                if (sql.startsWith('SELECT id FROM cos.scopes'))
                  return { rows: selected.filter((row) => row.id === values?.[0]).map(({ id }) => ({ id })) };
                if (sql.includes('SELECT owner_id,agent_group_id'))
                  return {
                    rows: selected
                      .filter((row) => row.id === values?.[0])
                      .map(({ owner_id, agent_group_id }) => ({ owner_id, agent_group_id })),
                  };
                if (sql.includes('to_jsonb(t)'))
                  return {
                    rows: sql.includes('cos."scopes"')
                      ? selected.filter((row) => row.id === values?.[0]).map((body) => ({ body }))
                      : [],
                  };
                return query(sql, values);
              },
            } as unknown as pg.Client;
            const stageFd = fs.openSync(
                staging,
                fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
              ),
              guard = () => {
                current();
                workspace.assertPayloadCurrent();
              },
              restoreIdentity = {
                context,
                databaseFingerprint: settings.databaseFingerprint,
                operationId: releaseOperationId,
                nativeDatabases: options.nativeDatabases,
                restrictionFiles: options.restrictionFiles,
                artifacts,
                witness,
              },
              sandbox = {
                client: testClient,
                config: {
                  host: 'fixture-test.lan',
                  port: 5432,
                  database: 'fixture-test',
                  ssl: { rejectUnauthorized: true },
                },
                testTargetId: 'fixture-admitted-test',
              };
            try {
              const expiredCheck = await withPinnedBackupTestRestoreReservation(
                '/proc/self/fd/' + stageFd,
                {
                  requestId: restoreRequest,
                  targetDigest: digest(initial.binding),
                  repositoryId: recovered.repositoryId,
                  repositoryOwnerDigest: recovered.ownerDigest,
                  queueOwnerDigest: recovered.receipt.ownerDigest,
                  operationId,
                  snapshotId: recovered.snapshotId,
                  archiveSha256: recovered.archiveSha256,
                  archiveBytes: recovered.archiveBytes,
                  snapshotDigest: instructions.snapshotDigest,
                  checkpointDigest: capturedHeader.checkpointDigest,
                  sourceDatabaseFingerprint: settings.databaseFingerprint,
                  scopeId: binding.scopeId,
                  journal: { installationDigest: witness.installationDigest, generation: witness.generation },
                },
                guard,
                async (reservation) => {
                  const restore = () =>
                    restoreRecoveredCoordinatedTestScope(
                      restoreIdentity,
                      workspace,
                      recovered.receipt.files,
                      sandbox,
                      reservation,
                      async () => guard(),
                    );
                  await assert.rejects(restore(), /^Error: coordinated_test_restore_unavailable$/);
                  assert.equal(inserts, 1);
                  assert.deepEqual(committedRows, [
                    { id: binding.scopeId, owner_id: binding.ownerId, agent_group_id: binding.agentGroupId },
                  ]);
                  assert.equal(fs.existsSync(liveReservation), true);
                  const beforeReservation = fs.readFileSync(liveReservation),
                    result = await restore();
                  assert.equal(result.inserted, false);
                  assert.equal(result.admissionRestored, false);
                  assert.equal(result.eventJournalRestored, false);
                  assert.equal(inserts, 1);
                  assert.deepEqual(fs.readFileSync(liveReservation), beforeReservation);
                  const originalTestRows = structuredClone(committedRows);
                  try {
                    committedRows[0].owner_id = 'foreign';
                    await assert.rejects(restore(), /^Error: coordinated_test_restore_unavailable$/);
                    assert.equal(inserts, 1);
                    assert.deepEqual(fs.readFileSync(liveReservation), beforeReservation);
                  } finally {
                    // Reset only this synthetic receiving protocol, never a real database or live source.
                    committedRows.splice(0, committedRows.length, ...originalTestRows);
                  }
                  const again = await verifyRecoveredTargetVaultState(
                    {
                      settings,
                      binding: laterBinding,
                      witness,
                      queueOperationId: operationId,
                      recovery,
                      expectedSnapshotDigest: instructions.snapshotDigest,
                      current,
                    },
                    workspace,
                    recovered.receipt.files,
                  );
                  assert.equal(again.snapshotDigest, instructions.snapshotDigest);
                  guard();
                  return reservation.assertCurrent;
                },
              );
              assert.throws(() => expiredCheck(), /^Error: backup_test_restore_reservation_unavailable$/);
            } finally {
              fs.closeSync(stageFd);
            }
          },
          64 * 1024 ** 2,
        );
      },
    );
    assert.deepEqual(native.prepare('SELECT * FROM messages').all(), before.messages);
    assert.deepEqual(native.prepare('SELECT * FROM model_counters').all(), before.counters);
    assert.deepEqual(fs.readFileSync(history), before.history);
    assert.deepEqual(fs.readFileSync(restriction), before.restriction);
    assert.deepEqual(fs.readFileSync(witness.root + '/owner.json'), before.journal);
    assert.deepEqual(fs.readFileSync(calendar + '/credentials/token.json'), before.token);
    assert.deepEqual(fs.readFileSync(witness.root + '/later-event.json'), before.effect);
    assert.deepEqual(native.prepare('SELECT binding,paused FROM cos_identity_boundaries').get(), before.binding);
    assert.equal((readPrivate(source + '/state.json') as { maintenance: boolean }).maintenance, false);
    assert.deepEqual(await queue.pending('state'), pending);
    assert.deepEqual(fs.readdirSync(staging).sort(), [path.basename(liveReservation), 'backup-queue'].sort());
    assert.deepEqual(snapshotMetadata(), remoteBefore);
    assert.deepEqual(fs.readdirSync(transferCache), []);
  } finally {
    native.close();
  }
}
for (const captureMode of ['operator', 'predeployment'] as const) {
  test(`real encrypted ${captureMode} recovery validates the complete captured payload without importing live authority`, () =>
    completeCapturedPayloadRecovery(captureMode));
}
for (const mismatch of ['owner', 'nonce', 'source-release'] as const) {
  test(`real encrypted predeployment recovery refuses an authentic archive with a foreign ${mismatch}`, () =>
    completeCapturedPayloadRecovery('predeployment', mismatch));
}
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
test('real restore cleanup holds edited private content despite unchanged timestamp observations', async () => {
  const staging = path.join(root, 'edited-restore'),
    before = snapshotMetadata();
  fs.mkdirSync(staging, { mode: 0o700 });
  const fd = fs.openSync(staging, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW),
    lstat = fs.lstatSync,
    fstat = fs.fstatSync;
  try {
    await assert.rejects(
      withIsolatedBackupRestore(
        '/proc/self/fd/' + fd,
        '5f74b367-fd8f-449c-a832-dbe40cff9ae3',
        65536,
        () => {},
        async (scope) => {
          await withTransfer(
            repositoryId,
            async () => {
              throw Error('must_not_upload');
            },
            (transfer) =>
              transfer.restore('credentials', transferOperation, 'a'.repeat(64), scope.sink, async () => {}),
          );
          const pathname = scope.directory + '/credentials/canary.json',
            original = fs.statSync(pathname);
          fs.writeFileSync(pathname, Buffer.alloc(Buffer.byteLength(canary), 0x41));
          // Simulate a filesystem clock that cannot distinguish these adjacent writes.
          // File I/O, encrypted transport and content verification remain real.
          const times = (value: fs.Stats) =>
            value.isFile() && value.ino === original.ino
              ? Object.assign(value, { mtimeMs: original.mtimeMs, ctimeMs: original.ctimeMs })
              : value;
          Object.defineProperty(fs, 'lstatSync', {
            value: (...args: unknown[]) => times(Reflect.apply(lstat, fs, args)),
          });
          Object.defineProperty(fs, 'fstatSync', {
            value: (...args: unknown[]) => times(Reflect.apply(fstat, fs, args)),
          });
        },
      ),
      /^Error: backup_restore_workspace_unavailable$/,
    );
    assert.deepEqual(
      fs.readFileSync(staging + '/.cos-restore-5f74b367-fd8f-449c-a832-dbe40cff9ae3/credentials/canary.json'),
      Buffer.alloc(Buffer.byteLength(canary), 0x41),
    );
    assert.deepEqual(snapshotMetadata(), before);
  } finally {
    Object.defineProperty(fs, 'lstatSync', { value: lstat });
    Object.defineProperty(fs, 'fstatSync', { value: fstat });
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
  for (const fd of [passwordFd, repositoryFd, binaryFd, cacheFd]) if (fd !== undefined) fs.closeSync(fd);
  fs.rmSync(root, { recursive: true, force: true });
});
