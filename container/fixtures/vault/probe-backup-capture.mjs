// Baked into a disposable ARM64 component image. It uses only synthetic data.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { digest } from '../../../src/modules/chief-of-staff/domain/contracts.js';
import {
  captureTargetVaultState,
  verifyTargetVaultState,
  captureScheduledTargetVaultState,
  verifyScheduledTargetVaultState,
} from '../../../src/modules/chief-of-staff/ops/backup-state-capture.js';
import { beginMaintenance, confirmQuiescence, finishMaintenance, activeMaintenanceLease, admittedGeneration } from '../../../src/modules/chief-of-staff/ops/maintenance.js';
import { machineFingerprint } from '../../../src/modules/chief-of-staff/ops/target-identity.js';
import { readPrivate, readTarget, writeAtomic } from '../../../src/modules/chief-of-staff/ops/target-state.js';
import { initializeTargetActionWitness } from '../../../src/modules/chief-of-staff/actions/host-ownership.js';
import { acquireHostExecutionLease, releaseHostExecutionLease } from '../../../src/db/host-execution-lease.js';
import { configureCalendarStorage } from '../../../src/modules/chief-of-staff/calendar/storage-policy.js';
import { verifyVaultStorage, withVaultDirectory } from '../../../src/modules/chief-of-staff/ops/vault-storage.js';
import { verifyVaultMemory } from '../../../src/modules/chief-of-staff/ops/vault-memory.js';
import { createVaultBackupQueue } from '../../../src/modules/chief-of-staff/ops/backup-queue.js';
import { openKnowledgeArtifacts } from '../../../src/modules/chief-of-staff/knowledge/config.js';
import { captureHostFixture } from './backup-capture-host.mjs';
import { checkpointMaintenance } from '../../../src/modules/chief-of-staff/ops/checkpoint-maintenance.js';
import { recoveryReleaseForManifest } from '../../../src/modules/chief-of-staff/ops/recovery-manifest.js';
import { fixtureVaultRelease } from '../../../src/contracts/chief-of-staff/release-fixture.js';

assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'arm64');
assert.equal(process.getuid(), 1000);
verifyVaultMemory();
process.umask(0o077);
const userHome = '/home/fixture',
  stateRoot = userHome + '/.config/nanoclaw-cos/state',
  roots = {
    targetRoot: stateRoot,
    installationRoot: userHome + '/application',
    dataRoot: userHome + '/application/data',
  },
  metadata = stateRoot + '/full-capture-fixture.json',
  mode = process.argv[2];
const directory = (root) => fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const file = (name, contents) => fs.writeFileSync(name, contents, { mode: 0o600, flag: 'wx' });
const stage = (name) => writeAtomic(stateRoot, 'full-capture-stage.json', { stage: name });
if (mode === 'unavailable') {
  stage('mount_loss');
  const value = readPrivate(metadata);
  let entered = false;
  await assert.rejects(
    async () =>
      createVaultBackupQueue(roots).withPending('state', value.queueOperationId, async () => {
        entered = true;
      }),
    /vault_storage_unavailable|backup_queue_unavailable/,
  );
  assert.equal(entered, false);
  console.log('{"encryptedFullCaptureMountLoss":"passed","plaintextFallback":false}');
} else if (mode === 'capture') {
  stage('setup');
  const settings = {
      version: 1,
      target: 'pi',
      sshAlias: 'fixture',
      userHome,
      stateRoot,
      installationRoot: roots.installationRoot,
      dataRoot: roots.dataRoot,
      releaseRoot: userHome + '/releases',
      stagingRoot: userHome + '/staging',
      sourceRoot: userHome + '/sources',
      runtimeEnvironment: userHome + '/.config/runtime',
      migrationEnvironment: userHome + '/.config/migration',
      service: 'nanoclaw-fixture.service',
      hostFingerprint: machineFingerprint(),
      databaseFingerprint: 'd'.repeat(64),
    },
    binding = {
      hostFingerprint: settings.hostFingerprint,
      databaseFingerprint: settings.databaseFingerprint,
      service: settings.service,
      installationRoot: settings.installationRoot,
      dataRoot: settings.dataRoot,
    },
    recovery = {
      releaseId: 'release-full-capture-fixture',
      manifestDigest: 'c'.repeat(64),
      software: {
        sourceCommit: '1'.repeat(40),
        sourceTree: '2'.repeat(40),
        hostPayloadSha256: '3'.repeat(64),
        schemaVersion: 18,
        nativeSchemaVersion: 22,
      },
    };
  directory(settings.dataRoot);
  writeAtomic(stateRoot, 'protected.json', { bindingDigest: digest(binding), generation: 3 });
  writeAtomic(stateRoot, 'state.json', {
    version: 1,
    binding,
    lifecycle: 'protected',
    generation: 3,
    maintenance: false,
    maintenanceId: null,
    releaseId: recovery.releaseId,
  });
  const maintenance = beginMaintenance(stateRoot, binding, 'fixture-checkpoint-owner', 'deployment');
  await confirmQuiescence(stateRoot, binding, maintenance, async () => ({
    activeCoordinators: 0,
    activeDatabaseOperations: 0,
  }));
  const operationId = 'release-action-' + maintenance.nonce,
    native = new Database(settings.dataRoot + '/v2.db');
  native.exec(
    'CREATE TABLE sessions(id TEXT,agent_group_id TEXT); CREATE TABLE cos_identity_boundaries(scope_id TEXT,agent_group_id TEXT,messaging_group_id TEXT,session_id TEXT,binding TEXT,paused INTEGER); CREATE TABLE host_execution_lease(singleton_id INTEGER PRIMARY KEY,owner_id TEXT,pid INTEGER,acquired_at TEXT); CREATE TABLE ordinary_messages(id TEXT,body TEXT); CREATE TABLE cos_model_budgets(activation_id TEXT,consumed INTEGER);',
  );
  const cos = {
    scopeId: 'fixture-scope',
    ownerId: 'fixture-owner',
    botId: 'fixture-bot',
    instanceId: 'fixture',
    channelId: 'private',
    agentGroupId: 'main',
    messagingGroupId: 'chat',
    provider: 'codex',
    sessionId: 'main',
  };
  Object.assign(captureHostFixture, { scopeId: cos.scopeId, ownerId: cos.ownerId, agentGroupId: cos.agentGroupId });
  native.prepare('INSERT INTO sessions VALUES(?,?)').run(cos.sessionId, cos.agentGroupId);
  native
    .prepare('INSERT INTO cos_identity_boundaries VALUES(?,?,?,?,?,1)')
    .run(cos.scopeId, cos.agentGroupId, cos.messagingGroupId, cos.sessionId, JSON.stringify(cos));
  native.exec(
    "INSERT INTO ordinary_messages VALUES('message','SYNTHETIC_ORDINARY_HISTORY'); INSERT INTO cos_model_budgets VALUES('activation',3)",
  );
  const hostLease = acquireHostExecutionLease(native),
    admin = { native, hostLease, maintenance, check: async () => {} };
  let hostHeld = true,
    cases = 0;
  try {
    stage('prepare_inputs');
    const witness = initializeTargetActionWitness(stateRoot, digest(binding));
    writeAtomic(witness.root, randomUUID() + '.json', { event: 'synthetic-independent-effect' });
    const generation = randomUUID(),
      history = stateRoot + '/conversations/' + generation;
    directory(history);
    file(history + '/history', 'SYNTHETIC_MAIN_HISTORY');
    file(history + '/auth.json', 'SYNTHETIC_PROVIDER_CACHE');
    const mission = stateRoot + '/missions/' + randomUUID();
    directory(mission + '/provider');
    directory(mission + '/context');
    file(mission + '/provider/history', 'SYNTHETIC_SPECIALIST_HISTORY');
    file(mission + '/provider/auth.json', 'SYNTHETIC_SPECIALIST_CACHE');
    directory('/case/vault/journals/empty');
    writeAtomic('/case/vault/journals', 'credential-event.json', { event: 'synthetic-change' });
    configureCalendarStorage(roots, '/case/vault/calendar-backups');
    directory(stateRoot + '/calendar/credentials');
    directory(stateRoot + '/calendar/access-denials');
    file(stateRoot + '/calendar/credentials/token.json', 'SYNTHETIC_GOOGLE_TOKEN');
    file(stateRoot + '/calendar/access-denials/denial.json', 'SYNTHETIC_GOOGLE_DENIAL');
    const artifacts = openKnowledgeArtifacts(stateRoot, [settings.installationRoot, settings.dataRoot]),
      artifactName = 'a'.repeat(64) + '-' + 'b'.repeat(64) + '.blob';
    file(artifacts.root + '/' + artifactName, 'SYNTHETIC_SELECTED_ARTIFACT');
    const initial = {
      paused: native.prepare('SELECT paused FROM cos_identity_boundaries').get(),
      messages: native.prepare('SELECT * FROM ordinary_messages').all(),
      budgets: native.prepare('SELECT * FROM cos_model_budgets').all(),
      state: readTarget(stateRoot, binding),
      rootCanary: fs.lstatSync('/case/vault/journals/.vault-canary'),
      credential: fs.readFileSync('/case/vault/backup-credentials/smb-credentials'),
    };
    try {
      stage('capture');
      const result = await captureTargetVaultState(settings, operationId, admin, recovery);
      assert.equal(result.status, 'queued');
      cases++;
      stage('verify');
      assert.deepEqual(
        await verifyTargetVaultState(settings, operationId, admin, recovery, result.snapshotDigest),
        result,
      );
      cases++;
      assert.equal(captureHostFixture.connections, 1);
      const queue = createVaultBackupQueue(roots),
        policy = verifyVaultStorage(roots),
        data = '/case/vault/staging/backup-queue/full/data';
      const stat = fs.statSync(data);
      assert.equal(stat.dev, fs.statSync('/case/vault').dev);
      assert.equal(stat.uid, 1000);
      assert.equal(stat.mode & 0o7777, 0o700);
      stage('readback');
      await queue.withPending('state', result.queueOperationId, async (directory) => {
        const archived = fs.readFileSync(directory + '/vault-backup-credentials/smb-credentials');
        try {
          assert(archived.equals(initial.credential));
        } finally {
          archived.fill(0);
        }
        assert.equal(
          fs.readFileSync(directory + '/calendar-state/credentials/token.json', 'utf8'),
          'SYNTHETIC_GOOGLE_TOKEN',
        );
        assert.equal(
          fs.readFileSync(directory + '/calendar-state/access-denials/denial.json', 'utf8'),
          'SYNTHETIC_GOOGLE_DENIAL',
        );
        assert.equal(
          fs.readFileSync(directory + '/conversation-backup/history/' + generation + '/history', 'utf8'),
          'SYNTHETIC_MAIN_HISTORY',
        );
        assert.equal(fs.existsSync(directory + '/conversation-backup/history/' + generation + '/auth.json'), false);
        assert.equal(
          fs.readFileSync(
            directory + '/mission-backup/history/missions/' + mission.split('/').at(-1) + '/provider/history',
            'utf8',
          ),
          'SYNTHETIC_SPECIALIST_HISTORY',
        );
        assert.equal(
          fs.existsSync(
            directory + '/mission-backup/history/missions/' + mission.split('/').at(-1) + '/provider/auth.json',
          ),
          false,
        );
        assert.equal(
          fs.readFileSync(directory + '/coordinated/artifacts/' + artifactName, 'utf8'),
          'SYNTHETIC_SELECTED_ARTIFACT',
        );
        const journals = readPrivate(directory + '/vault-journals.capture.json');
        assert(journals.directories.includes('empty'));
        assert.equal(journals.excluded.length, 1);
        assert.equal(journals.excluded[0].name, '.vault-canary');
        assert.equal(journals.excluded[0].reason, 'host_bound_vault_proof');
        assert.equal(fs.existsSync(directory + '/vault-journals/.vault-canary'), false);
        const copy = new Database(directory + '/coordinated/sqlite/0/native.sqlite', { readonly: true });
        try {
          assert.deepEqual(copy.prepare('SELECT * FROM ordinary_messages').all(), initial.messages);
          assert.deepEqual(copy.prepare('SELECT * FROM cos_model_budgets').all(), initial.budgets);
        } finally {
          copy.close();
        }
      });
      cases++;
      assert.deepEqual(native.prepare('SELECT paused FROM cos_identity_boundaries').get(), initial.paused);
      assert.deepEqual(native.prepare('SELECT * FROM ordinary_messages').all(), initial.messages);
      assert.deepEqual(native.prepare('SELECT * FROM cos_model_budgets').all(), initial.budgets);
      assert.deepEqual(readTarget(stateRoot, binding), initial.state);
      const currentCanary = fs.lstatSync('/case/vault/journals/.vault-canary');
      assert.equal(currentCanary.uid, 0);
      assert.equal(currentCanary.gid, 0);
      assert.equal(currentCanary.mode & 0o7777, 0o600);
      for (const key of ['dev', 'ino', 'size', 'nlink', 'mtimeMs', 'ctimeMs'])
        assert.equal(currentCanary[key], initial.rootCanary[key]);
      assert.equal(fs.existsSync(stateRoot + '/actions/coordinated'), false);
      assert.equal(fs.existsSync(stateRoot + '/releases'), false);
      cases++;
      const second = await captureTargetVaultState(settings, 'release-action-' + randomUUID(), admin, recovery);
      assert.equal(second.status, 'skipped_pending');
      assert.equal(second.slotState, 'pending');
      assert.equal(captureHostFixture.connections, 1);
      cases++;
      await assert.rejects(
        verifyTargetVaultState(settings, operationId, admin, recovery, 'f'.repeat(64)),
        /target_vault_capture_unavailable/,
      );
      cases++;
      stage('pause_refusal');
      native.prepare('UPDATE cos_identity_boundaries SET paused=0').run();
      await assert.rejects(
        verifyTargetVaultState(settings, operationId, admin, recovery, result.snapshotDigest),
        /target_vault_capture_unavailable/,
      );
      cases++;
      native.prepare('UPDATE cos_identity_boundaries SET paused=1').run();
      writeAtomic(stateRoot, 'full-capture-fixture.json', {
        settings,
        operationId,
        queueOperationId: result.queueOperationId,
        recovery,
        snapshotDigest: result.snapshotDigest,
      });
      const source = data + '/coordinated/remote.json',
        original = fs.readFileSync(source);
      try {
        stage('corruption_refusal');
        fs.appendFileSync(source, 'SYNTHETIC_CORRUPTION');
        await assert.rejects(
          verifyTargetVaultState(settings, operationId, admin, recovery, result.snapshotDigest),
          /target_vault_capture_unavailable/,
        );
        cases++;
        fs.writeFileSync(source, original);
        assert.deepEqual(
          await verifyTargetVaultState(settings, operationId, admin, recovery, result.snapshotDigest),
          result,
        );
      } finally {
        original.fill(0);
      }
      releaseHostExecutionLease(native, hostLease);
      stage('lease_refusal');
      hostHeld = false;
      await assert.rejects(
        verifyTargetVaultState(settings, operationId, admin, recovery, result.snapshotDigest),
        /target_vault_capture_unavailable/,
      );
      cases++;
      assert.equal(policy.volume.filesystem, 'ext4');
      stage('scheduled_checkpoint');
      // Only this disposable, independently generated fixture slot is removed.
      // This is fixture setup, never production retirement or a remote ACK.
      await withVaultDirectory(roots, 'staging', async (directory) => {
        const full = directory + '/backup-queue/full', stat = fs.lstatSync(full);
        assert.equal(stat.uid, 1000);
        assert.equal(stat.dev, fs.statSync('/case/vault').dev);
        assert.equal(stat.mode & 0o7777, 0o700);
        fs.rmSync(full, { recursive: true });
      });
      await finishMaintenance(stateRoot, binding, maintenance, async () => true);
      const scheduledManifest = fixtureVaultRelease('G02'),
        scheduledRecovery = recoveryReleaseForManifest(scheduledManifest),
        requestId = randomUUID(), scheduledOperationId = 'release-backup-' + requestId,
        events = [];
      writeAtomic(stateRoot, 'state.json', { ...readTarget(stateRoot, binding), releaseId: scheduledManifest.releaseId });
      native.prepare('UPDATE cos_identity_boundaries SET paused=0').run();
      let healthy = false, captures = 0, starts = 0, scheduledCases = 0, scheduledSnapshot;
      const checkpointEffects = {
        verify: async () => scheduledManifest,
        inspect: async () => queue.inspect('state'),
        workersIdle: async () => true,
        stopNative: async () => { events.push('stop'); },
        nativeStopped: async () => true,
        databaseCompatible: async () => true,
        startNative: async () => { starts++; events.push('start'); },
        healthy: async () => { events.push('health'); return healthy; },
        capture: async () => {
          captures++; events.push('capture');
          scheduledSnapshot = await captureScheduledTargetVaultState(settings, scheduledOperationId, scheduledRecovery);
          assert.equal(scheduledSnapshot.status, 'queued');
          // A later trusted owner pause must survive both restart and retry.
          native.prepare('UPDATE cos_identity_boundaries SET paused=1').run();
          return scheduledSnapshot;
        },
        verifyCapture: async (_lease, expected) => {
          events.push('readback');
          return verifyScheduledTargetVaultState(settings, scheduledOperationId, scheduledRecovery, expected);
        },
      };
      const checkpoint = () => checkpointMaintenance({ root: stateRoot, binding, requestId, effects: checkpointEffects });
      await assert.rejects(checkpoint(), /checkpoint_maintenance_unverified/);
      const scheduledLease = activeMaintenanceLease(stateRoot, binding);
      assert.equal(admittedGeneration(stateRoot, binding), null);
      assert.equal(native.prepare('SELECT paused FROM cos_identity_boundaries').get().paused, 1);
      assert.deepEqual(events.slice(0, 4), ['stop', 'capture', 'readback', 'start']);
      scheduledCases++;
      healthy = true;
      assert.equal((await checkpoint()).status, 'backup_queued');
      assert.equal(readTarget(stateRoot, binding).generation, scheduledLease.generation + 1);
      assert.equal(captures, 1); assert.equal(starts, 1);
      assert.equal(captureHostFixture.connections, 2);
      assert.deepEqual(native.prepare('SELECT * FROM ordinary_messages').all(), initial.messages);
      assert.deepEqual(native.prepare('SELECT * FROM cos_model_budgets').all(), initial.budgets);
      assert.equal(native.prepare('SELECT paused FROM cos_identity_boundaries').get().paused, 1);
      await queue.withPending('state', scheduledSnapshot.queueOperationId, async (directory) => {
        const copy = new Database(directory + '/coordinated/sqlite/0/native.sqlite', { readonly: true });
        try {
          assert.equal(copy.prepare('SELECT paused FROM cos_identity_boundaries').get().paused, 0);
          assert.deepEqual(copy.prepare('SELECT * FROM ordinary_messages').all(), initial.messages);
          assert.deepEqual(copy.prepare('SELECT * FROM cos_model_budgets').all(), initial.budgets);
        } finally { copy.close(); }
      });
      scheduledCases++;
      assert.equal((await checkpoint()).status, 'backup_queued');
      assert.equal(captures, 1); assert.equal(starts, 1);
      assert.equal(native.prepare('SELECT paused FROM cos_identity_boundaries').get().paused, 1);
      scheduledCases++;
      const skipped = await checkpointMaintenance({ root: stateRoot, binding, requestId: randomUUID(), effects: checkpointEffects });
      assert.equal(skipped.status, 'backup_skipped_pending');
      assert.equal(skipped.interrupted, false);
      assert.equal(captures, 1); assert.equal(starts, 1);
      scheduledCases++;
      await assert.rejects(captureScheduledTargetVaultState(settings, scheduledOperationId, scheduledRecovery), /target_vault_capture_unavailable/);
      assert.equal(captureHostFixture.connections, 2);
      scheduledCases++;
      const foreignOperationId = 'release-backup-' + randomUUID(),
        liveWriterLease = beginMaintenance(stateRoot, binding, foreignOperationId, 'deployment');
      await confirmQuiescence(stateRoot, binding, liveWriterLease, async () => ({ activeCoordinators: 0, activeDatabaseOperations: 0 }));
      const nativeWriter = acquireHostExecutionLease(native);
      try {
        await assert.rejects(captureScheduledTargetVaultState(settings, foreignOperationId, scheduledRecovery), /target_vault_capture_unavailable/);
        assert.equal(captureHostFixture.connections, 2);
      } finally { releaseHostExecutionLease(native, nativeWriter); }
      scheduledCases++;
      stage('capture_publication_recovery');
      await finishMaintenance(stateRoot, binding, liveWriterLease, async () => true);
      // Remove only the independently generated disposable fixture snapshot.
      await withVaultDirectory(roots, 'staging', async (directory) => {
        const full = directory + '/backup-queue/full', stat = fs.lstatSync(full);
        assert.equal(stat.uid, 1000); assert.equal(stat.dev, fs.statSync('/case/vault').dev);
        assert.equal(stat.mode & 0o7777, 0o700);
        fs.rmSync(full, { recursive: true });
      });
      const failedRequestId = randomUUID(), failedOperationId = 'release-backup-' + failedRequestId;
      let failedStarts = 0, failedStops = 0, failedCaptures = 0, recoveredHealthy = false, captureRecoveryCases = 0;
      const failedEffects = {
        ...checkpointEffects,
        stopNative: async () => { failedStops++; },
        startNative: async () => { failedStarts++; if (failedStarts === 1) throw Error('synthetic_start_interrupted'); },
        healthy: async () => recoveredHealthy,
        capture: async () => { failedCaptures++; return captureScheduledTargetVaultState(settings, failedOperationId, scheduledRecovery); },
        verifyCapture: async () => { throw Error('must_not_verify_incomplete_capture'); },
      };
      const failedCheckpoint = () => checkpointMaintenance({ root: stateRoot, binding, requestId: failedRequestId, effects: failedEffects });
      native.prepare('UPDATE cos_identity_boundaries SET paused=0').run();
      const originalRename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (String(to).endsWith('/receipt.json')) throw Error('synthetic_capture_publication_failure');
        return originalRename(from, to);
      };
      try { await assert.rejects(failedCheckpoint(), /synthetic_start_interrupted/); }
      finally { fs.renameSync = originalRename; }
      const failedLease = activeMaintenanceLease(stateRoot, binding);
      assert.equal(admittedGeneration(stateRoot, binding), null);
      assert.equal(failedCaptures, 1); assert.equal(failedStops, 1);
      assert.equal(captureHostFixture.connections, 2);
      await assert.rejects(queue.inspect('state'), /backup_queue_unavailable/);
      const queueFingerprint = () => withVaultDirectory(roots, 'staging', async directory => {
        const walk = root => fs.readdirSync(root).sort().map(name => {
          const file = root + '/' + name, stat = fs.lstatSync(file);
          assert.equal(stat.uid, 1000); assert.equal(stat.dev, fs.statSync('/case/vault').dev);
          assert.equal(stat.isSymbolicLink(), false);
          if (stat.isDirectory()) return { name, inode: stat.ino, entries: walk(file) };
          assert.equal(stat.nlink, 1); assert.equal(stat.mode & 0o7777, 0o600); assert(stat.size <= 1024 ** 2);
          return { name, inode: stat.ino, sha256: digest(fs.readFileSync(file)) };
        });
        return digest(walk(directory + '/backup-queue'));
      });
      const heldQueue = await queueFingerprint();
      captureRecoveryCases++;
      native.prepare('UPDATE cos_identity_boundaries SET paused=1').run();
      await assert.rejects(failedCheckpoint(), /checkpoint_maintenance_unverified/);
      assert.equal(admittedGeneration(stateRoot, binding), null);
      assert.equal(failedStarts, 2); assert.equal(failedCaptures, 1);
      assert.equal(await queueFingerprint(), heldQueue);
      captureRecoveryCases++;
      recoveredHealthy = true;
      assert.equal((await failedCheckpoint()).status, 'backup_failed');
      assert.equal(readTarget(stateRoot, binding).generation, failedLease.generation + 1);
      assert.equal(native.prepare('SELECT paused FROM cos_identity_boundaries').get().paused, 1);
      assert.deepEqual(native.prepare('SELECT * FROM ordinary_messages').all(), initial.messages);
      assert.deepEqual(native.prepare('SELECT * FROM cos_model_budgets').all(), initial.budgets);
      assert.equal(await queueFingerprint(), heldQueue);
      captureRecoveryCases++;
      assert.equal((await failedCheckpoint()).status, 'backup_failed');
      assert.equal(failedStarts, 2); assert.equal(failedCaptures, 1); assert.equal(failedStops, 1);
      assert.equal(await queueFingerprint(), heldQueue);
      captureRecoveryCases++;
      await assert.rejects(checkpointMaintenance({ root: stateRoot, binding, requestId: randomUUID(), effects: failedEffects }), /backup_queue_unavailable/);
      assert.equal(failedStops, 1); assert.equal(failedCaptures, 1);
      assert.equal(await queueFingerprint(), heldQueue);
      assert.equal(captureHostFixture.connections, 2);
      captureRecoveryCases++;
      writeAtomic(stateRoot, 'full-capture-fixture.json', { queueOperationId: failedLease.nonce });
      const rootProof = fs.lstatSync('/case/vault/journals/.vault-canary');
      for (const key of ['dev','ino','uid','gid','mode','size','nlink','mtimeMs','ctimeMs'])
        assert.equal(rootProof[key], initial.rootCanary[key]);
      stage('complete');
      console.log(
        JSON.stringify({
          encryptedFullCapture: 'passed',
          cases,
          scheduledCheckpoint: { status: 'passed', cases: scheduledCases, laterOwnerPausePreserved: true,
            actualNativeSqliteAndMaintenance: true, restartHealthBeforeAdmission: true, installedServiceManager: false },
          interruptedCaptureServiceRecovery: { status: 'passed', cases: captureRecoveryCases,
            unreadableQueuePreserved: true, laterOwnerPausePreserved: true, noRecapture: true, finalArtifact: false },
          encryptedVolume: 'actual_LUKS2_ext4',
          defaultMemoryAndStorageGuards: true,
          actualNativeOwnerGuards: true,
          installedOwnerCommand: false,
          actualQueueReadback: true,
          nativeStatePreserved: true,
          modelCountersPreserved: true,
          newPlaintextBackupStaging: false,
          postgres: 'fixture',
          manager: 'fixture',
          finalArtifact: false,
        }),
      );
    } finally {
      initial.credential.fill(0);
    }
  } finally {
    if (hostHeld) releaseHostExecutionLease(native, hostLease);
    native.close();
  }
} else throw Error('unknown_full_capture_fixture_mode');
