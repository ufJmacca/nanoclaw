import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  connect: vi.fn(),
  end: vi.fn(),
  backup: vi.fn(),
  nativeBackup: vi.fn(),
  local: vi.fn(),
  localVerify: vi.fn(),
  restore: vi.fn(),
  proof: vi.fn(),
  conversations: vi.fn(),
  missions: vi.fn(),
  calendar: vi.fn(),
}));
vi.mock('./host-fingerprint.js', () => ({ machineFingerprint: () => 'a'.repeat(64) }));
vi.mock('../store/preflight.js', async (original) => ({
  ...(await original<typeof import('../store/preflight.js')>()),
  connectChecked: f.connect,
}));
vi.mock('../store/config.js', async (original) => ({
  ...(await original<typeof import('../store/config.js')>()),
  parseDatabaseConfig: () => ({}),
}));
vi.mock('./target-action-backup.js', () => ({ backupTargetActionState: f.nativeBackup }));
vi.mock('./coordinated-backup.js', async (original) => ({
  ...(await original<typeof import('./coordinated-backup.js')>()),
  verifyCoordinatedBackup: f.backup,
  restoreCoordinatedSandbox: f.local,
  verifyCoordinatedLocalSandbox: f.localVerify,
  restoreCoordinatedTestScope: f.restore,
  verifyCoordinatedSandbox: f.proof,
}));
vi.mock('./conversation-backup.js', () => ({ verifyConversationBackup: f.conversations }));
vi.mock('./mission-backup.js', () => ({ verifyMissionBackup: f.missions }));
vi.mock('../calendar/backup.js', () => ({ verifyCalendarBackup: f.calendar }));
import { runActionRecoveryAdmin } from './action-recovery-admin.js';
import { parseAdminArguments } from './admin.js';
import { initializeTarget, writeAtomic, readPrivate } from './target-state.js';
import { beginMaintenance, confirmQuiescence } from './maintenance.js';
import { acquireHostExecutionLease } from '../../../db/host-execution-lease.js';
import { initializeTargetActionWitness } from '../actions/host-ownership.js';
import { digest } from '../domain/contracts.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../store/migrations.js';
import type { CoordinatedRestoreProof } from './coordinated-backup.js';
const directories: string[] = [],
  databases: Database.Database[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-action-recovery-'));
  directories.push(root);
  const roots = { targetRoot: root + '/state', installationRoot: root + '/app', dataRoot: root + '/app/data' };
  fs.mkdirSync(roots.dataRoot, { recursive: true, mode: 0o700 });
  const targetBinding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: digest('runtime DB'),
    service: 'nano.service',
    installationRoot: roots.installationRoot,
    dataRoot: roots.dataRoot,
  };
  initializeTarget(roots.targetRoot, targetBinding);
  const maintenance = beginMaintenance(roots.targetRoot, targetBinding, 'release-fixture-actions', 'deployment');
  await confirmQuiescence(roots.targetRoot, targetBinding, maintenance, async () => ({
    activeCoordinators: 0,
    activeDatabaseOperations: 0,
  }));
  const native = new Database(path.join(roots.dataRoot, 'v2.db'));
  databases.push(native);
  native.exec(
    'CREATE TABLE host_execution_lease(singleton_id INTEGER PRIMARY KEY,owner_id TEXT,pid INTEGER,acquired_at TEXT)',
  );
  const hostLease = acquireHostExecutionLease(native),
    witness = initializeTargetActionWitness(roots.targetRoot, digest(targetBinding)),
    binding = {
      scopeId: 'scope',
      ownerId: 'owner',
      botId: 'bot',
      agentGroupId: 'main',
      sessionId: 'main',
      messagingGroupId: 'chat',
      instanceId: 'fixture',
      channelId: 'private',
      provider: 'codex' as const,
    },
    backupOperationId = 'release-fixture-actions',
    checkpoint = {
      format: 'cos-coordinated-backup/v1',
      schemaVersion: SCHEMA_VERSION,
      schemaDigest: digest(MIGRATIONS.map(({ version, checksum }) => ({ version, checksum }))),
      journal: { installationDigest: witness.installationDigest, generation: witness.generation },
      sqlite: [{ file: 'sqlite/0/native.sqlite' }],
    },
    header = {
      format: 'cos-target-action-backup/v1',
      operationId: backupOperationId,
      targetBindingDigest: witness.installationDigest,
      nativeBindingDigest: digest(binding),
      checkpointDigest: digest(checkpoint),
      conversationBackupDigest: digest('conversations'),
      missionBackupDigest: digest('missions'),
      calendarBackupDigest: digest('calendar'),
      journal: checkpoint.journal,
      nativeDatabases: 1,
      maintenanceGeneration: maintenance.generation,
      writerActivated: false,
      inputs: {
        context: {
          scopeId: binding.scopeId,
          ownerId: binding.ownerId,
          agentGroupId: binding.agentGroupId,
          sessionId: binding.sessionId,
          ingressId: 'operator-backup-' + backupOperationId,
        },
        nativeDatabases: [path.join(roots.dataRoot, 'v2.db')],
        restrictionFiles: [path.join(roots.targetRoot, 'state.json')],
      },
    },
    receiptRoot = path.join(roots.targetRoot, 'releases', backupOperationId, 'action-state');
  fs.mkdirSync(receiptRoot, { recursive: true, mode: 0o700 });
  writeAtomic(receiptRoot, 'action-backup.json', header);
  const proof: CoordinatedRestoreProof = {
    format: 'cos-coordinated-restore-proof/v1',
    checkpointDigest: digest(checkpoint),
    scopeIdentityDigest: digest({
      scopeId: binding.scopeId,
      ownerId: binding.ownerId,
      sessionId: binding.sessionId,
      agentGroupId: binding.agentGroupId,
    }),
    databaseFingerprint: targetBinding.databaseFingerprint,
    sandboxDatabaseFingerprint: digest('protected separate test DB'),
    sandboxSeparated: true,
    testMarkerDigest: digest('fixture marker'),
    schemaVersion: SCHEMA_VERSION,
    schemaDigest: checkpoint.schemaDigest,
    restoredStateDigest: digest('restored rows'),
    sqliteCount: 1,
    journal: checkpoint.journal,
    admissionRestored: false,
    eventJournalRestored: false,
    verifiedAt: new Date().toISOString(),
  };
  const args = {
      command: 'action-restore-check' as const,
      scopeId: 'scope',
      requestId: randomUUID(),
      backupOperationId,
    },
    options = {
      args,
      env: { COS_TEST_TARGET_ID: 'fixture marker' },
      roots,
      binding,
      native,
      hostLease,
      check: vi.fn(async () => {}),
      assertAuthority: vi.fn(),
    };
  f.connect.mockResolvedValue({ end: f.end });
  f.end.mockResolvedValue(undefined);
  f.backup.mockResolvedValue(checkpoint);
  f.conversations.mockResolvedValue('conversations');
  f.missions.mockResolvedValue('missions');
  f.calendar.mockResolvedValue('calendar');
  f.local.mockImplementation(async (_options, destination: string) => {
    fs.mkdirSync(destination, { mode: 0o700 });
  });
  f.localVerify.mockResolvedValue({});
  f.restore.mockResolvedValue({
    inserted: true,
    restoredStateDigest: proof.restoredStateDigest,
    sandboxDatabaseFingerprint: proof.sandboxDatabaseFingerprint,
  });
  f.proof.mockResolvedValue(proof);
  f.nativeBackup.mockImplementation(async (_settings, operationId: string) => ({
    ...header,
    operationId,
    inputs: { ...header.inputs, context: { ...header.inputs.context, ingressId: 'operator-backup-' + operationId } },
  }));
  return { root, roots, targetBinding, witness, binding, header, proof, receiptRoot, args, options, native, hostLease };
}
it('S09 records a verified separate restore without reopening runtime admission, restoring tokens or replacing the journal', async () => {
  const s = await fixture();
  expect(
    parseAdminArguments([
      'action-restore-check',
      '--scope',
      'scope',
      '--request-id',
      s.args.requestId,
      '--backup-release',
      s.args.backupOperationId,
    ]),
  ).toEqual(s.args);
  const result = await runActionRecoveryAdmin(s.options);
  expect(result).toMatchObject({
    status: 'restore_verified_paused',
    writer_enabled: false,
    paused: true,
    proof_digest: digest(s.proof),
  });
  expect(f.connect).toHaveBeenCalledWith(s.options.env, 'test', 'migration');
  expect(f.localVerify).toHaveBeenCalledOnce();
  expect(f.restore).toHaveBeenCalledOnce();
  expect(f.proof).toHaveBeenCalledOnce();
  expect(readPrivate(path.join(s.roots.targetRoot, 'actions', 'restore-proofs', digest(s.proof) + '.json'))).toEqual(
    s.proof,
  );
  expect(fs.existsSync(path.join(s.roots.targetRoot, 'actions', 'writer-profile.json'))).toBe(false);
  await runActionRecoveryAdmin(s.options);
  expect(f.local).toHaveBeenCalledOnce();
  expect(f.end).toHaveBeenCalledTimes(2);
});
it.each(['foreign-binding', 'same-database', 'changed-sandbox', 'altered-local', 'import', 'late-backup', 'journal'])(
  'S09 %s recovery failure cannot issue proof or permission',
  async (kind) => {
    const s = await fixture();
    if (kind === 'foreign-binding')
      writeAtomic(s.receiptRoot, 'action-backup.json', { ...s.header, nativeBindingDigest: digest('foreign owner') });
    if (kind === 'same-database')
      f.proof.mockResolvedValue({
        ...s.proof,
        sandboxSeparated: false,
        sandboxDatabaseFingerprint: s.targetBinding.databaseFingerprint,
      });
    if (kind === 'changed-sandbox')
      f.proof.mockResolvedValue({ ...s.proof, sandboxDatabaseFingerprint: digest('different separate test DB') });
    if (kind === 'altered-local') f.localVerify.mockRejectedValue(Error('PRIVATE_COPY_CANARY'));
    if (kind === 'import') f.restore.mockRejectedValue(Error('PRIVATE_IMPORT_CANARY'));
    if (kind === 'late-backup')
      f.proof.mockImplementation(async () => {
        writeAtomic(s.receiptRoot, 'action-backup.json', { ...s.header, checkpointDigest: digest('changed') });
        return s.proof;
      });
    if (kind === 'journal')
      f.proof.mockImplementation(async () => {
        writeAtomic(path.join(s.roots.targetRoot, 'actions'), 'owner.json', {
          format: 'cos-action-host-owner/v1',
          installationDigest: s.witness.installationDigest,
          journalGeneration: randomUUID(),
        });
        return s.proof;
      });
    await expect(runActionRecoveryAdmin(s.options)).rejects.toThrow('action_recovery_unavailable');
    expect(fs.existsSync(path.join(s.roots.targetRoot, 'actions', 'restore-proofs', digest(s.proof) + '.json'))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(s.roots.targetRoot, 'actions', 'writer-profile.json'))).toBe(false);
    if (kind === 'foreign-binding') expect(f.connect).not.toHaveBeenCalled();
    if (kind === 'altered-local') expect(f.restore).not.toHaveBeenCalled();
  },
);
it('S09 fresh backup uses only exact bound settings and the already held private admin lease', async () => {
  const s = await fixture();
  const settings = {
    version: 1,
    target: 'pi',
    sshAlias: 'fixture',
    userHome: s.root,
    installationRoot: s.roots.installationRoot,
    dataRoot: s.roots.dataRoot,
    stateRoot: s.roots.targetRoot,
    releaseRoot: s.root + '/releases',
    stagingRoot: s.root + '/staging',
    sourceRoot: s.root + '/sources',
    runtimeEnvironment: s.root + '/.config/runtime',
    migrationEnvironment: s.root + '/.config/migration',
    service: 'nano.service',
    hostFingerprint: s.targetBinding.hostFingerprint,
    databaseFingerprint: s.targetBinding.databaseFingerprint,
  };
  writeAtomic(s.roots.targetRoot, 'settings.json', settings);
  const args = {
    command: 'action-backup' as const,
    scopeId: 'scope',
    requestId: randomUUID(),
    settingsFile: s.roots.targetRoot + '/settings.json',
  };
  expect(
    parseAdminArguments([
      'action-backup',
      '--scope',
      'scope',
      '--request-id',
      args.requestId,
      '--settings',
      args.settingsFile,
    ]),
  ).toEqual(args);
  expect(await runActionRecoveryAdmin({ ...s.options, args })).toMatchObject({
    status: 'backup_verified_paused',
    writer_enabled: false,
  });
  expect(f.nativeBackup.mock.calls[0][2]).toMatchObject({ native: s.native, hostLease: s.hostLease });
  expect(f.connect).not.toHaveBeenCalled();
  f.nativeBackup.mockClear();
  writeAtomic(s.roots.targetRoot, 'settings.json', { ...settings, databaseFingerprint: digest('foreign DB') });
  await expect(runActionRecoveryAdmin({ ...s.options, args })).rejects.toThrow('action_recovery_unavailable');
  expect(f.nativeBackup).not.toHaveBeenCalled();
});
