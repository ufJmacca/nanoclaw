// Actual compiled code, encrypted kernel storage and pinned Restic; synthetic accounts only.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { verifyVaultMemory } from '/code/modules/chief-of-staff/ops/vault-memory.js';
import { withVaultDirectory, verifyVaultStorage } from '/code/modules/chief-of-staff/ops/vault-storage.js';
import { selectedFixtureEnvironment, fixtureDatabaseConfig } from '/code/contracts/chief-of-staff/fixture-database.js';
import { verifyMailFixtureReport } from '/code/contracts/chief-of-staff/mail-fixture-report.js';
import { CalendarCredentialCore } from '/code/modules/chief-of-staff/calendar/credential-core.js';
import { CalendarAccessFences } from '/code/modules/chief-of-staff/calendar/access-fences.js';
import { GOOGLE_EVENT_READ_SCOPE } from '/code/modules/chief-of-staff/calendar/reader.js';
import {
  GOOGLE_OWNED_EVENT_WRITE_SCOPE,
  GOOGLE_CALENDAR_METADATA_SCOPE,
} from '/code/modules/chief-of-staff/actions/writer.js';
import { createVaultCredentialJournal } from '/code/modules/chief-of-staff/ops/backup-credential-journal.js';
import { createVaultBackupQueue } from '/code/modules/chief-of-staff/ops/backup-queue.js';
import {
  createVaultBackupRepositoryWriter,
  BackupRepositoryWriter,
} from '/code/modules/chief-of-staff/ops/backup-repository-lease.js';
import { installBackupCredentials } from '/code/modules/chief-of-staff/ops/backup-credential-install.js';
import { withVaultResticPassword } from '/code/modules/chief-of-staff/ops/backup-password.js';
import { withVaultCredentialSnapshot } from '/code/modules/chief-of-staff/ops/credential-vault-snapshot.js';
import { recordScheduledCredentialRecoveryPage } from '/code/modules/chief-of-staff/ops/credential-recovery-page.js';
import {
  makeRoutedCredentialRecoveryManifest,
  routedCredentialRecoveryFiles,
} from '/code/modules/chief-of-staff/ops/credential-recovery-routing.js';
import { makeCredentialCapture, streamCredentialCapture } from '/code/modules/chief-of-staff/ops/credential-capture.js';
import { BackupResticTransfer } from '/code/modules/chief-of-staff/ops/backup-restic-transfer.js';
import { BackupResticInitializer } from '/code/modules/chief-of-staff/ops/backup-restic-initialize.js';
import { withVerifiedResticBinary } from '/code/modules/chief-of-staff/ops/restic-artifact.js';
import { verifyResticReleasePayload } from '/code/modules/chief-of-staff/ops/restic-release-payload.js';
import { readBackupCapacity } from '/code/modules/chief-of-staff/ops/backup-capacity.js';
import { BACKUP_LIMITS } from '/code/modules/chief-of-staff/ops/backup-policy.js';
import { machineFingerprint, localTarget } from '/code/modules/chief-of-staff/ops/target-identity.js';
import {
  beginMaintenance,
  confirmQuiescence,
  finishMaintenance,
  admittedGeneration,
} from '/code/modules/chief-of-staff/ops/maintenance.js';
import { writeAtomic } from '/code/modules/chief-of-staff/ops/target-state.js';
import { digest } from '/code/modules/chief-of-staff/domain/contracts.js';

process.umask(0o077);
assert.equal(process.getuid(), 1000);
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'arm64');
assert.equal(process.version, 'v22.23.2');
verifyVaultMemory();
assert.equal(process.env.COS_FIXTURE_DATABASE_PROFILE, 'test');
const roots = {
  targetRoot: '/home/fixture/.config/nanoclaw-cos/state',
  installationRoot: '/case/application',
  dataRoot: '/case/data',
};
const stage = (name) => writeAtomic(roots.targetRoot, 'mail-recovery-stage.json', { stage: name });
const source = JSON.parse(fs.readFileSync('/release/build-info.json', 'utf8'));
const policy = verifyVaultStorage(roots),
  policyDigest = digest(policy),
  binary = '/release/libexec/restic';
const current = () => {
  verifyVaultMemory();
  assert.equal(digest(verifyVaultStorage(roots)), policyDigest);
};
const hash = (file) => {
  const bytes = fs.readFileSync(file);
  try {
    return createHash('sha256').update(bytes).digest('hex');
  } finally {
    bytes.fill(0);
  }
};
verifyResticReleasePayload('/release/libexec');
stage('encrypted_checkpoint');
const selected = selectedFixtureEnvironment(process.env, true);
assert.equal(selected.COS_TEST_PGSSLMODE, 'verify-full');
assert.equal(selected.COS_TEST_PGSSLROOTCERT, '/selected-ca.pem');
await fixtureDatabaseConfig(selected, 'migration');
await withVaultDirectory(roots, 'staging', async (directory, vaultCurrent) => {
  current();
  vaultCurrent();
  const physical = fs.realpathSync(directory);
  assert.equal(physical, '/case/vault/staging');
  const temporary = fs.mkdtempSync(physical + '/g04-mail-checkpoint-'),
    initial = fs.lstatSync(temporary);
  assert.equal(initial.dev, fs.statSync('/case/vault').dev);
  assert.equal(initial.uid, 1000);
  assert.equal(initial.mode & 0o7777, 0o700);
  try {
    const result = spawnSync(
      '/release/node/bin/node',
      [
        '--test',
        '--test-concurrency=1',
        '--test-reporter=tap',
        '/release/dist/contracts/chief-of-staff/mail-checkpoint.integration.js',
      ],
      {
        cwd: '/release',
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          LANG: 'C',
          LC_ALL: 'C',
          TZ: 'Australia/Sydney',
          TMPDIR: temporary,
          ...selected,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 240000,
        maxBuffer: 2 * 1024 ** 2,
      },
    );
    try {
      current();
      vaultCurrent();
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0);
      const tap = new TextDecoder('utf8', { fatal: true }).decode(result.stdout);
      assert.deepEqual(verifyMailFixtureReport(tap, 'checkpoint'), { suite: 'checkpoint', actualCases: 2 });
      console.log(
        JSON.stringify({
          encryptedMailCheckpoint: 'passed',
          sourceCommit: source.commit,
          sourceTree: source.tree,
          actualDatabaseCases: 2,
          tap,
          actualKernelVault: true,
          actualPinnedStaging: true,
          actualMemoryProtection: true,
          compiledProductionPayload: true,
          sourceOverrides: false,
          databaseProfile: 'test',
          databaseTls: 'verify-full',
          runtimeProfileUsed: false,
          ownerCredentialsUsed: false,
          liveAccountAcceptance: false,
          installedAcceptance: false,
        }),
      );
    } finally {
      result.stdout?.fill(0);
      result.stderr?.fill(0);
    }
  } finally {
    vaultCurrent();
    current();
    assert.equal(fs.lstatSync(temporary).ino, initial.ino);
    assert.equal(fs.lstatSync(temporary).dev, initial.dev);
    fs.rmSync(temporary, { recursive: true });
    assert.equal(fs.existsSync(temporary), false);
  }
});

stage('complete_credential_setup');
// The base fixture already recovered this one known synthetic canary. It is not
// a credential source and must not weaken the production unknown-file refusal.
const canary = '/case/vault/backup-credentials/canary';
assert.equal(fs.readFileSync(canary, 'utf8'), 'SYNTHETIC_ENCRYPTED_CANARY');
fs.unlinkSync(canary);
const binding = {
  hostFingerprint: machineFingerprint(),
  databaseFingerprint: digest('synthetic-mail-recovery-target'),
  service: 'nanoclaw-fixture.service',
  installationRoot: roots.installationRoot,
  dataRoot: roots.dataRoot,
};
assert.equal(fs.existsSync(roots.targetRoot + '/state.json'), false);
// Disposable fixture binding. No production deployment, service, lease or DB admission is inferred.
writeAtomic(roots.targetRoot, 'protected.json', { bindingDigest: digest(binding), generation: 3 });
writeAtomic(roots.targetRoot, 'state.json', {
  version: 1,
  binding,
  lifecycle: 'protected',
  generation: 3,
  maintenance: false,
  maintenanceId: null,
  releaseId: 'release-mail-recovery-kernel-fixture',
});
const lease = beginMaintenance(roots.targetRoot, binding, 'mail-recovery-kernel-fixture', 'deployment');
await confirmQuiescence(roots.targetRoot, binding, lease, async () => ({
  activeCoordinators: 0,
  activeDatabaseOperations: 0,
}));
const smb = randomBytes(16),
  password = randomBytes(32);
const bytes = Buffer.concat([
  Buffer.from([0x43, 0x4f, 0x53, 0x42, 1, 32, 64]),
  Buffer.from(smb.toString('hex')),
  Buffer.from(password.toString('hex')),
]);
smb.fill(0);
password.fill(0);
await installBackupCredentials({
  roots,
  operationId: randomUUID(),
  credentialReference: randomUUID(),
  bytes,
  check: async () => current(),
  assertAuthority() {
    current();
    assert.equal(localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot).maintenanceId, lease.nonce);
  },
});
await finishMaintenance(roots.targetRoot, binding, lease, async () => true);
const state = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot),
  stateDigest = digest(state);
const assertAuthority = () => {
  current();
  assert.equal(digest(localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot)), stateDigest);
  assert.equal(admittedGeneration(roots.targetRoot, binding), state.generation);
};
assertAuthority();
const calendar = '/case/vault/google/calendar',
  journal = createVaultCredentialJournal(roots);
for (const profile of ['reader', 'owned_event_writer']) {
  const writer = profile === 'owned_event_writer',
    credentials = calendar + (writer ? '/writer-credentials' : '/credentials'),
    denials = calendar + (writer ? '/writer-access-denials' : '/access-denials');
  for (const directory of [credentials, denials]) fs.mkdirSync(directory, { mode: 0o700 });
  CalendarCredentialCore.initialize(credentials, profile);
  const fences = CalendarAccessFences.initialize(denials);
  const client = {
    clientId: (writer ? 'writer' : 'calendar') + '-kernel-fixture.apps.googleusercontent.com',
    clientSecret: 'SYNTHETIC_CLIENT',
  };
  if (writer) writeAtomic(calendar, 'writer-oauth-client.json', client);
  else assert.equal(JSON.parse(fs.readFileSync(calendar + '/oauth-client.json', 'utf8')).clientId, client.clientId);
  const core = new CalendarCredentialCore(credentials, client, fences, profile, {}, assertAuthority, journal),
    reference = randomUUID(),
    id = randomUUID();
  await core.install('mail-recovery-kernel-fixture', id, reference, {
    accessToken: 'SYNTHETIC_ACCESS',
    refreshToken: 'SYNTHETIC_REFRESH',
    expiresAt: Date.now() + 3600000,
    refreshExpiresAt: null,
    scopes: writer ? [GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE] : [GOOGLE_EVENT_READ_SCOPE],
  });
  fences.deny('mail-recovery-kernel-fixture', id, 'disconnected');
}
stage('complete_repository');
await withVaultDirectory(roots, 'cache', async (cacheDirectory, cacheCurrent) => {
  const cacheRoot = fs.realpathSync(cacheDirectory);
  assert.equal(cacheRoot, '/case/vault/cache');
  // This disposable local directory holds only Restic-encrypted repository
  // bytes. Actual CIFS/NAS admission is a distinct inherited release gate.
  const repository = '/case/synthetic-nas/restic',
    temporary = cacheRoot + '/mail-recovery-tmp';
  for (const directory of [repository, temporary]) fs.mkdirSync(directory, { mode: 0o700 });
  const pin = (file) => {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW),
      initial = fs.fstatSync(fd);
    return {
      fd,
      assertCurrent() {
        assertAuthority();
        cacheCurrent();
        for (const now of [fs.fstatSync(fd), fs.lstatSync(file)]) {
          assert.equal(now.dev, initial.dev);
          assert.equal(now.ino, initial.ino);
          assert.equal(now.uid, 1000);
          assert.equal(now.mode & 0o7777, 0o700);
        }
      },
    };
  };
  const repoScope = pin(repository),
    cacheScope = pin(temporary);
  try {
    await withVerifiedResticBinary(binary, (executable) =>
      withVaultResticPassword(roots, async (passwordScope) => {
        const initWriter = new BackupRepositoryWriter(
          digest('synthetic-mail-repository-initialization'),
          async (operation) => operation(temporary),
          '.cos-writer.lock',
        );
        const repositoryId = await initWriter.exclusive(async (writer) => {
          const initializer = new BackupResticInitializer(
            { binary: executable, password: passwordScope, repository: repoScope, cache: cacheScope, writer },
            async () => assertAuthority(),
          );
          await initializer.create();
          return initializer.identify();
        });
        writeAtomic('/case/vault/backup-credentials', 'backup-repository.json', {
          contract: 'cos-backup-repository/v1',
          rootsDigest: digest(roots),
          filesystemUuid: policy.volume.filesystemUuid,
          repositoryId,
          mount: { host: '192.0.2.1', share: 'nanoclaw-cos-backups', mount: '/case/synthetic-nas' },
        });
        const writerFactory = createVaultBackupRepositoryWriter(roots, repositoryId),
          queue = createVaultBackupQueue(roots);
        await writerFactory.exclusive(async (writer) => {
          const page = await recordScheduledCredentialRecoveryPage(roots, {
            releaseId: state.releaseId,
            generation: state.generation,
            assertAuthority,
          });
          assert.equal(page.recorded, 8);
          assert.equal(page.next_after, null);
          assert.equal(page.open_checks, 0);
          const pending = digest(await queue.pending('credentials'));
          await recordScheduledCredentialRecoveryPage(roots, {
            releaseId: state.releaseId,
            generation: state.generation,
            assertAuthority,
          });
          assert.equal(digest(await queue.pending('credentials')), pending);
          const cycle = new Date();
          cycle.setUTCMinutes(0, 0, 0);
          const measured = await withVaultCredentialSnapshot(roots, { assertAuthority }, async (snapshot) => {
            assert.equal(snapshot.sources.length, 11);
            assert.equal(snapshot.openChecks, 0);
            const set = makeRoutedCredentialRecoveryManifest(snapshot.ownerDigest, snapshot.sources),
              capture = makeCredentialCapture(snapshot.ownerDigest, cycle.toISOString(), set);
            const archive = await streamCredentialCapture(snapshot, capture, async () => {});
            snapshot.assertPrimaryUnchanged();
            return { capture, archive };
          });
          const { capture, archive } = measured;
          const admit = async () => {
            writer.assertCurrent();
            repoScope.assertCurrent();
            cacheScope.assertCurrent();
            const usage = await readBackupCapacity(roots, repoScope);
            assert(usage.cache < BACKUP_LIMITS.cache);
            assert(usage.credentials < BACKUP_LIMITS.credentials);
            assert(usage.staging < BACKUP_LIMITS.staging);
            assert(usage.vaultFree > BACKUP_LIMITS.vaultReserve);
          };
          const transfer = new BackupResticTransfer({
            binary: executable,
            password: passwordScope,
            repository: repoScope,
            cache: cacheScope,
            writer,
            repositoryId,
            ownerDigest: digest({
              targetDigest: policy.targetDigest,
              filesystemUuid: policy.volume.filesystemUuid,
              repositoryId,
            }),
            producer: () => {
              throw Error('queue_producer_not_used');
            },
            credentialProducer: (value) => [
              '/release/node/bin/node',
              '/release/dist/modules/chief-of-staff/ops/credential-capture-producer.js',
              roots.targetRoot,
              roots.installationRoot,
              roots.dataRoot,
              state.releaseId,
              String(state.generation),
              value.cycleAt,
              value.operationId,
              value.set.operationId,
            ],
            admitUpload: async (kind, count) => {
              assert.equal(kind, 'credentials');
              assert.equal(count, archive.bytes);
              await admit();
            },
            timeoutMs: 120000,
          });
          stage('complete_offline');
          fs.renameSync(repository, repository + '-offline');
          try {
            await assert.rejects(transfer.uploadCredentialCapture(capture, archive));
            assert.equal(digest(await queue.pending('credentials')), pending);
          } finally {
            fs.renameSync(repository + '-offline', repository);
          }
          stage('complete_upload');
          const first = await transfer.uploadCredentialCapture(capture, archive),
            retry = await transfer.uploadCredentialCapture(capture, archive);
          assert.equal(first.reconciled, false);
          assert.equal(retry.reconciled, true);
          assert.equal(first.snapshotId, retry.snapshotId);
          assert.equal(digest(await queue.pending('credentials')), pending);
          const protectedFiles = ['state.json', 'protected.json', 'maintenance.json'].map((name) => [
            name,
            hash(roots.targetRoot + '/' + name),
          ]);
          stage('complete_restore');
          let recoveredFiles = 0;
          const requestId = randomUUID();
          await queue.withRestoreWorkspace(requestId, assertAuthority, async (workspace) => {
            assert(fs.realpathSync(workspace.directory).startsWith('/case/vault/staging/.cos-restore-'));
            const remote = await transfer.restoreCredentialCapture(
              capture.operationId,
              capture.ownerDigest,
              workspace.sink,
              admit,
            );
            assert.equal('receipt' in remote, false);
            assert.equal(digest(remote.capture), digest(capture));
            assert.equal(remote.archiveBytes, archive.bytes);
            assert.equal(remote.archiveSha256, archive.sha256);
            workspace.assertPayloadCurrent();
            const files = routedCredentialRecoveryFiles(capture.set, capture.ownerDigest).filter(
              (file) => file.name !== 'credential-set.json',
            );
            assert.equal(files.length, 25);
            for (const file of files) {
              const actual = workspace.inspectFile(file.name);
              assert.equal(actual.bytes, file.bytes);
              assert.equal(actual.sha256, file.sha256);
              recoveredFiles++;
            }
            workspace.assertPayloadCurrent();
            await withVaultCredentialSnapshot(roots, { assertAuthority }, async (snapshot) => {
              assert.equal(
                digest(makeRoutedCredentialRecoveryManifest(snapshot.ownerDigest, snapshot.sources)),
                digest(capture.set),
              );
              snapshot.assertPrimaryUnchanged();
            });
          });
          assert.equal(fs.existsSync('/case/vault/staging/.cos-restore-' + requestId), false);
          for (const [name, before] of protectedFiles) assert.equal(hash(roots.targetRoot + '/' + name), before);
          assert.equal(digest(await queue.pending('credentials')), pending);
          assertAuthority();
          console.log(
            JSON.stringify({
              completeMailCredentialRecovery: 'passed',
              sourceCommit: source.commit,
              sourceTree: source.tree,
              actualSources: capture.set.contents.sources.length,
              actualProfiles: 3,
              actualPayloadFiles: recoveredFiles,
              actualScheduledPageSources: page.recorded,
              actualFixedProducer: true,
              actualPinnedRestic: true,
              actualEncryptedJournal: true,
              actualKernelWriter: true,
              actualIsolatedRestore: true,
              actualMemoryProtection: true,
              actualKernelVault: true,
              productionStorageOverrides: false,
              productionMemoryOverrides: false,
              offlinePendingPreserved: true,
              repeatedUploadReconciled: true,
              unchangedPageReused: true,
              pendingRetired: false,
              completeArchiveStaged: false,
              protectedAuthorityUnchanged: true,
              restoredAuthorityActivated: false,
              privateWorkspaceRemoved: true,
              targetAndServiceAdmission: 'fixture',
              repositoryAdmission: 'fixture',
              liveNasAcceptance: false,
              ownerCredentialsUsed: false,
              liveAccountAcceptance: false,
              installedAcceptance: false,
              compiledProductionPayload: true,
            }),
          );
        });
      }),
    );
  } finally {
    fs.closeSync(cacheScope.fd);
    fs.closeSync(repoScope.fd);
  }
});
stage('complete');
