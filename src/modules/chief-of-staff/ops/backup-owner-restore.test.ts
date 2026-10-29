import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { targetBinding } from './target-host.js';
import { initializeTarget, protectTarget, readPrivate, readTarget, writeAtomic } from './target-state.js';
import { initializeTargetActionWitness } from '../actions/host-ownership.js';
import { withDeploymentLock } from './deployment-lock.js';
import type { DeploymentSettings } from './deployment-settings.js';
import { makeCredentialEvent } from './backup-credential-event.js';
import { makeRoutedCredentialRecoveryManifest } from './credential-recovery-routing.js';
import { makeCredentialCapture } from './credential-capture.js';
const ports = vi.hoisted(() => ({
  verify: vi.fn(),
  healthy: vi.fn(),
  mount: vi.fn(),
  separate: vi.fn(),
  restore: vi.fn(),
  credentials: vi.fn(),
  drafts: vi.fn(),
}));
vi.mock('./target-host.js', async (original) => ({
  ...(await original<typeof import('./target-host.js')>()),
  verifyTargetPaths: vi.fn(),
}));
vi.mock('./backup-upload-job-effects.js', () => ({
  createBackupUploadJobEffects: () => ({ verify: ports.verify, healthy: ports.healthy, mount: ports.mount }),
}));
vi.mock('./backup-test-database.js', () => ({ withSeparateBackupTestDatabase: ports.separate }));
vi.mock('./backup-target-restore.js', () => ({ restoreTargetVaultBackupTestScope: ports.restore }));
vi.mock('./backup-upload.js', () => ({ restoreVaultCredentialCapture: ports.credentials }));
vi.mock('./mail-draft-recovery-admin.js', () => ({ restoreOwnerMailDraftBaseline: ports.drafts }));
import { parseBackupOwnerRestoreArguments, restoreOwnerVaultBackup } from './backup-owner-restore.js';
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.resetAllMocks();
});
function fixture(slice: 'G01' | 'G02' | 'G03' | 'G04' | 'G05' | 'G06' = 'G02') {
  const root = fs.mkdtempSync(os.tmpdir() + '/cos-owner-restore-');
  fs.chmodSync(root, 0o700);
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings: DeploymentSettings = {
      version: 1,
      target: 'pi',
      sshAlias: 'fixture',
      userHome: root,
      installationRoot: root + '/app',
      dataRoot: root + '/app/data',
      stateRoot: root + '/state',
      releaseRoot: root + '/releases',
      stagingRoot: root + '/staging',
      sourceRoot: root + '/sources',
      runtimeEnvironment: root + '/.config/runtime',
      migrationEnvironment: root + '/.config/migration',
      service: 'nano.service',
      hostFingerprint: digest('host'),
      databaseFingerprint: digest('source database'),
    },
    manifest = fixtureVaultRelease(slice),
    binding = targetBinding(settings);
  fs.mkdirSync(settings.dataRoot, { recursive: true, mode: 0o700 });
  const state = initializeTarget(settings.stateRoot, binding);
  writeAtomic(settings.stateRoot, 'state.json', { ...state, releaseId: manifest.releaseId });
  const protectedState = protectTarget(settings.stateRoot, binding);
  writeAtomic(settings.stateRoot, 'maintenance.json', {
    version: 1,
    bindingDigest: digest(binding),
    nonce: randomUUID(),
    owner: 'fixture-release',
    purpose: 'deployment',
    generation: protectedState.generation,
    phase: 'complete',
    reopen: true,
  });
  writeAtomic(settings.stateRoot, 'state.json', {
    ...protectedState,
    maintenance: false,
    maintenanceHistory: true,
    generation: protectedState.generation + 1,
  });
  initializeTargetActionWitness(settings.stateRoot, digest(binding));
  const owner = {
    scopeId: 'scope',
    ownerId: 'owner',
    botId: 'bot',
    instanceId: 'instance',
    channelId: 'channel',
    agentGroupId: 'group',
    messagingGroupId: 'messaging',
    provider: 'codex',
    sessionId: 'current-session',
  };
  const native = new Database(settings.dataRoot + '/v2.db');
  cleanup.push(() => native.close());
  native.exec(
    'CREATE TABLE cos_identity_boundaries(scope_id TEXT,agent_group_id TEXT,messaging_group_id TEXT,session_id TEXT,binding TEXT,paused INTEGER); CREATE TABLE sessions(id TEXT,agent_group_id TEXT); CREATE TABLE ordinary(body TEXT,used INTEGER);',
  );
  native
    .prepare('INSERT INTO cos_identity_boundaries VALUES(?,?,?,?,?,1)')
    .run(owner.scopeId, owner.agentGroupId, owner.messagingGroupId, owner.sessionId, JSON.stringify(owner));
  native.prepare('INSERT INTO sessions VALUES(?,?)').run(owner.sessionId, owner.agentGroupId);
  native.prepare('INSERT INTO ordinary VALUES(?,4)').run('later-message');
  writeAtomic(root, 'settings.json', settings);
  const retained = settings.releaseRoot + '/' + manifest.releaseId,
    receiptRoot = settings.stateRoot + '/releases/' + manifest.releaseId;
  fs.mkdirSync(retained, { recursive: true, mode: 0o700 });
  fs.mkdirSync(receiptRoot, { recursive: true, mode: 0o700 });
  writeAtomic(retained, 'release.json', manifest);
  writeAtomic(receiptRoot, 'deployment.json', {
    version: 1,
    releaseId: manifest.releaseId,
    manifestDigest: digest(manifest),
    bindingDigest: digest(binding),
    status: 'healthy',
    pending: null,
    completed: ['source', 'artifacts', 'quiesce', 'backup', 'migrate', 'activate', 'health'],
  });
  const args = {
      command: 'backup-restore-check' as const,
      scopeId: 'scope',
      requestId: randomUUID(),
      queueOperationId: randomUUID(),
      backupReleaseId: manifest.releaseId,
      snapshotDigest: digest('snapshot'),
    },
    order: string[] = [],
    checkDatabase = vi.fn().mockResolvedValue(undefined),
    sandbox = { client: {}, config: { database: 'test' }, testTargetId: 'fixture-test' };
  ports.verify.mockResolvedValue(manifest);
  ports.healthy.mockResolvedValue(true);
  ports.mount.mockImplementation(async (check) => {
    check();
    order.push('mount');
  });
  ports.separate.mockImplementation(async (_settings, file, current, use) => {
    expect(file).toBe(root + '/test.env');
    current();
    order.push('database');
    return use(sandbox, checkDatabase);
  });
  ports.restore.mockImplementation(async (identity, requestId, selected, check) => {
    identity.current();
    await check();
    order.push('restore');
    expect(requestId).toBe(args.requestId);
    expect(selected).toBe(sandbox);
    return {
      remote: { contract: 'cos-backup-remote-restore/v1', kind: 'state', operationId: args.queueOperationId },
      validation: {
        format: 'cos-sandbox-scope-restore/v1',
        inserted: true,
        snapshotDigest: args.snapshotDigest,
        checkpointDigest: digest('checkpoint'),
        sandboxDatabaseFingerprint: digest('test database'),
        admissionRestored: false,
        eventJournalRestored: false,
        credentialsActivated: false,
        writerActivated: false,
      },
    };
  });
  const invoke = () =>
    restoreOwnerVaultBackup({
      settingsFile: root + '/settings.json',
      testEnvironmentFile: root + '/test.env',
      invokedHelper: retained + '/payload/dist/modules/chief-of-staff/ops/target-helper.js',
      args,
    });
  return { root, settings, manifest, binding, owner, native, args, order, checkDatabase, receiptRoot, invoke };
}
function selectCapture(f: ReturnType<typeof fixture>, slice: 'G01' | 'G02' | 'G03' | 'G04' | 'G05' | 'G06') {
  const manifest = { ...fixtureVaultRelease(slice), releaseId: 'release-capture-' + slice.toLowerCase() },
    directory = f.settings.releaseRoot + '/' + manifest.releaseId,
    receiptRoot = f.settings.stateRoot + '/releases/' + manifest.releaseId,
    receipt = readPrivate<Record<string, unknown>>(f.receiptRoot + '/deployment.json');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(receiptRoot, { recursive: true, mode: 0o700 });
  writeAtomic(directory, 'release.json', manifest);
  writeAtomic(receiptRoot, 'deployment.json', {
    ...receipt,
    releaseId: manifest.releaseId,
    manifestDigest: digest(manifest),
  });
  f.args.backupReleaseId = manifest.releaseId;
}
it.each(
  (['G05', 'G06'] as const).flatMap((helper) =>
    (['G02', 'G03', 'G04', 'G05', ...(helper === 'G06' ? (['G06'] as const) : [])] as const).map((slice) => ({
      helper,
      slice,
    })),
  ),
)(
  'admits an ordinary $slice state capture through $helper without draft setup or live activation',
  async ({ helper, slice }) => {
    const f = fixture(helper),
      native = f.native.serialize(),
      state = readTarget(f.settings.stateRoot, f.binding);
    selectCapture(f, slice);
    await expect(f.invoke()).resolves.toMatchObject({
      status: 'backup_test_restore_verified',
      admission_restored: false,
      event_journal_restored: false,
      credentials_activated: false,
      writer_activated: false,
    });
    expect(f.order).toEqual(['database', 'mount', 'restore']);
    expect(ports.restore).toHaveBeenCalledOnce();
    expect(ports.drafts).not.toHaveBeenCalled();
    expect(ports.credentials).not.toHaveBeenCalled();
    expect(fs.existsSync(f.settings.stateRoot + '/mail-drafts')).toBe(false);
    expect(f.native.serialize()).toEqual(native);
    expect(readTarget(f.settings.stateRoot, f.binding)).toEqual(state);
  },
);
it('refuses an unsupported G01 state capture through G05 before test database or NAS access', async () => {
  const f = fixture('G05');
  selectCapture(f, 'G01');
  await expect(f.invoke()).rejects.toThrow('backup_owner_restore_unavailable');
  expect(ports.separate).not.toHaveBeenCalled();
  expect(ports.mount).not.toHaveBeenCalled();
  expect(ports.restore).not.toHaveBeenCalled();
});
it('keeps a G05 capture outside an older G04 helper recovery boundary', async () => {
  const f = fixture('G04');
  selectCapture(f, 'G05');
  await expect(f.invoke()).rejects.toThrow('backup_owner_restore_unavailable');
  expect(ports.separate).not.toHaveBeenCalled();
  expect(ports.mount).not.toHaveBeenCalled();
  expect(ports.restore).not.toHaveBeenCalled();
});
it('keeps a schema21 G06 capture outside an older G05 helper recovery boundary', async () => {
  const f = fixture('G05');
  selectCapture(f, 'G06');
  await expect(f.invoke()).rejects.toThrow('backup_owner_restore_unavailable');
  expect(ports.separate).not.toHaveBeenCalled();
  expect(ports.mount).not.toHaveBeenCalled();
  expect(ports.restore).not.toHaveBeenCalled();
});
it('does not admit an ordinary state restore through a G01 helper', async () => {
  const f = fixture('G01');
  selectCapture(f, 'G02');
  await expect(f.invoke()).rejects.toThrow('backup_owner_restore_unavailable');
  expect(ports.separate).not.toHaveBeenCalled();
  expect(ports.mount).not.toHaveBeenCalled();
  expect(ports.restore).not.toHaveBeenCalled();
});
it.each([
  { helper: 'G05', capture: 'G05', schema: 20 },
  { helper: 'G06', capture: 'G05', schema: 20 },
  { helper: 'G06', capture: 'G06', schema: 21 },
] as const)(
  '$helper routes combined $capture recovery through the protected owner and separate marked test database lifetime',
  async ({ helper, capture, schema }) => {
    const f = fixture(helper);
    selectCapture(f, capture);
    const args = {
      ...f.args,
      command: 'mail-draft-restore-check' as const,
      writerBindingId: randomUUID(),
      captureOperationId: randomUUID(),
      credentialRequestId: randomUUID(),
    };
    let retained!: () => void;
    ports.drafts.mockImplementation(async (input) => {
      input.target.current();
      await input.checkDatabase();
      retained = input.target.current;
      expect(input.args).toEqual(args);
      expect(input.target.binding).toEqual(f.owner);
      expect(input.target.recovery.software.schemaVersion).toBe(schema);
      expect(input.target.expectedSnapshotDigest).toBe(args.snapshotDigest);
      expect(input.sandbox.testTargetId).toBe('fixture-test');
      return { status: 'mail_draft_restore_verified', writer_activated: false };
    });
    expect(
      await restoreOwnerVaultBackup({
        settingsFile: f.root + '/settings.json',
        testEnvironmentFile: f.root + '/test.env',
        invokedHelper:
          f.settings.releaseRoot +
          '/' +
          f.manifest.releaseId +
          '/payload/dist/modules/chief-of-staff/ops/target-helper.js',
        args,
      }),
    ).toEqual({ status: 'mail_draft_restore_verified', writer_activated: false });
    expect(f.order).toEqual(['database', 'mount']);
    expect(ports.drafts).toHaveBeenCalledOnce();
    expect(ports.restore).not.toHaveBeenCalled();
    expect(ports.credentials).not.toHaveBeenCalled();
    expect(() => retained()).toThrow();
  },
);
it('does not admit the draft recovery command through a G04 retained helper', async () => {
  const f = fixture('G04'),
    args = {
      ...f.args,
      command: 'mail-draft-restore-check' as const,
      writerBindingId: randomUUID(),
      captureOperationId: randomUUID(),
      credentialRequestId: randomUUID(),
    };
  await expect(
    restoreOwnerVaultBackup({
      settingsFile: f.root + '/settings.json',
      testEnvironmentFile: f.root + '/test.env',
      invokedHelper: '/fixture/retained/helper.js',
      args,
    }),
  ).rejects.toThrow('backup_owner_restore_unavailable');
  expect(ports.drafts).not.toHaveBeenCalled();
  expect(ports.mount).not.toHaveBeenCalled();
});
function credentialFixture(slice: 'G02' | 'G04' | 'G05' | 'G06' = 'G04') {
  const f = fixture(slice),
    owner = digest('vault owner'),
    bytes = Buffer.from('SYNTHETIC_RESTORED_CREDENTIAL'),
    event = makeCredentialEvent(
      {
        sourceKind: 'backup_repository',
        sourceKey: 'd'.repeat(64),
        generation: 1,
        phase: 'ready',
        files: [{ name: 'repository.json', bytes }],
      },
      owner,
    ),
    capture = makeCredentialCapture(
      owner,
      '2026-10-16T00:00:00.000Z',
      makeRoutedCredentialRecoveryManifest(owner, [
        { event, files: [{ name: 'repository.json', destination: 'backup-credentials/backup-repository.json' }] },
      ]),
    ),
    args = {
      command: 'backup-credentials-restore-check' as const,
      scopeId: 'scope',
      requestId: f.args.requestId,
      captureOperationId: capture.operationId,
    },
    inspect = vi.fn((name) => ({ file: name, ...event.files[0] })),
    payloadCurrent = vi.fn();
  ports.credentials.mockImplementation(async (roots, op, request, current, validate) => {
    current();
    expect(roots).toEqual({
      targetRoot: f.settings.stateRoot,
      installationRoot: f.settings.installationRoot,
      dataRoot: f.settings.dataRoot,
    });
    expect(op).toBe(capture.operationId);
    expect(request).toBe(args.requestId);
    const remote = {
        contract: 'cos-backup-credential-capture-restore/v1',
        operationId: op,
        capture,
        kind: 'credentials',
      },
      validation = await validate(
        { assertCurrent: current, assertPayloadCurrent: payloadCurrent, inspectFile: inspect },
        remote,
      );
    current();
    return { remote, validation };
  });
  const invoke = () =>
    restoreOwnerVaultBackup({
      settingsFile: f.root + '/settings.json',
      invokedHelper:
        f.settings.releaseRoot +
        '/' +
        f.manifest.releaseId +
        '/payload/dist/modules/chief-of-staff/ops/target-helper.js',
      args,
    });
  return { ...f, args, capture, inspect, payloadCurrent, invoke };
}
it.each(['G04', 'G05', 'G06'] as const)(
  'checks complete %s credential recovery without draft setup, a database profile or live activation',
  async (slice) => {
    const f = credentialFixture(slice),
      before = f.native.serialize(),
      state = readTarget(f.settings.stateRoot, f.binding);
    await expect(f.invoke()).resolves.toEqual({
      status: 'backup_credentials_restore_verified',
      request_id: f.args.requestId,
      capture_operation_id: f.capture.operationId,
      source_count: 1,
      file_count: 1,
      credential_set_digest: digest(f.capture.set),
      credentials_activated: false,
      admission_restored: false,
      event_journal_restored: false,
      writer_activated: false,
    });
    expect(f.inspect).toHaveBeenCalledOnce();
    expect(f.payloadCurrent).toHaveBeenCalled();
    expect(ports.mount).toHaveBeenCalledOnce();
    expect(ports.separate).not.toHaveBeenCalled();
    expect(ports.restore).not.toHaveBeenCalled();
    expect(ports.drafts).not.toHaveBeenCalled();
    expect(fs.existsSync(f.settings.stateRoot + '/mail-drafts')).toBe(false);
    expect(f.native.serialize()).toEqual(before);
    expect(readTarget(f.settings.stateRoot, f.binding)).toEqual(state);
  },
);
it.each(['slice', 'scope', 'health', 'payload', 'helper', 'evidence', 'args'])(
  'denies complete credential recovery on changed %s with no state import',
  async (reason) => {
    const f = credentialFixture(reason === 'slice' ? 'G02' : 'G04');
    if (reason === 'scope') f.args.scopeId = 'foreign';
    if (reason === 'health') ports.healthy.mockResolvedValue(false);
    if (reason === 'payload')
      f.inspect.mockImplementation((name) => ({
        file: name,
        ...f.capture.set.contents.sources[0].files[0],
        sha256: 'e'.repeat(64),
      }));
    if (reason === 'helper') ports.verify.mockRejectedValue(Error('PRIVATE_HELPER'));
    if (reason === 'evidence') ports.credentials.mockResolvedValue({ remote: {}, validation: {} });
    if (reason === 'args') Object.assign(f.args, { destination: '/foreign' });
    await expect(f.invoke()).rejects.toThrow('backup_owner_restore_unavailable');
    expect(ports.separate).not.toHaveBeenCalled();
    expect(ports.restore).not.toHaveBeenCalled();
  },
);
it.each(['owner', 'generation', 'journal', 'settings', 'args'])(
  'denies complete credential recovery after awaited %s changes',
  async (reason) => {
    const f = credentialFixture(),
      read = ports.credentials.getMockImplementation()!;
    ports.credentials.mockImplementation(async (...args) => {
      const result = await read(...args);
      await Promise.resolve();
      if (reason === 'owner')
        f.native
          .prepare('UPDATE cos_identity_boundaries SET binding=?')
          .run(JSON.stringify({ ...f.owner, sessionId: 'later-owner' }));
      if (reason === 'generation') {
        const state = readTarget(f.settings.stateRoot, f.binding);
        writeAtomic(f.settings.stateRoot, 'state.json', { ...state, generation: state.generation + 1 });
      }
      if (reason === 'journal') {
        const file = f.settings.stateRoot + '/actions/owner.json';
        const witness = readPrivate<Record<string, unknown>>(file);
        writeAtomic(f.settings.stateRoot + '/actions', 'owner.json', { ...witness, journalGeneration: randomUUID() });
      }
      if (reason === 'settings') writeAtomic(f.root, 'settings.json', { ...f.settings, service: 'foreign.service' });
      if (reason === 'args') f.args.captureOperationId = f.args.requestId;
      return result;
    });
    await expect(f.invoke()).rejects.toThrow('backup_owner_restore_unavailable');
    expect(ports.separate).not.toHaveBeenCalled();
    expect(ports.restore).not.toHaveBeenCalled();
  },
);
it('accepts only exact checkpoint, snapshot and retained release selections', () => {
  const f = fixture(),
    args = [
      'backup-restore-check',
      '--scope',
      f.args.scopeId,
      '--request-id',
      f.args.requestId,
      '--backup-operation-id',
      f.args.queueOperationId,
      '--backup-release',
      f.args.backupReleaseId,
      '--snapshot-digest',
      f.args.snapshotDigest,
    ];
  expect(parseBackupOwnerRestoreArguments(args)).toEqual(f.args);
  for (const changed of [
    args.slice(0, -2),
    [...args, '--root', '/foreign'],
    args.map((value) => (value === f.args.queueOperationId ? '../foreign' : value)),
  ])
    expect(() => parseBackupOwnerRestoreArguments(changed)).toThrow('invalid_owner_admin_arguments');
});
it('uses the fixed complete restore and preserves live state, pause and consumed counters', async () => {
  const f = fixture(),
    before = f.native.serialize(),
    state = readTarget(f.settings.stateRoot, f.binding);
  await expect(f.invoke()).resolves.toMatchObject({
    status: 'backup_test_restore_verified',
    inserted: true,
    snapshot_digest: f.args.snapshotDigest,
    admission_restored: false,
    event_journal_restored: false,
    credentials_activated: false,
    writer_activated: false,
  });
  expect(f.order).toEqual(['database', 'mount', 'restore']);
  expect(ports.restore.mock.calls[0][0]).toMatchObject({
    binding: f.owner,
    queueOperationId: f.args.queueOperationId,
    expectedSnapshotDigest: f.args.snapshotDigest,
  });
  expect(f.native.serialize()).toEqual(before);
  expect(readTarget(f.settings.stateRoot, f.binding)).toEqual(state);
  expect(f.checkDatabase).toHaveBeenCalled();
});
it.each([
  'scope',
  'settings',
  'release',
  'generation',
  'maintenance',
  'journal',
  'native_owner',
  'retained_receipt',
  'health',
  'result',
])('holds recovery after awaited %s withdrawal', async (change) => {
  const f = fixture();
  ports.mount.mockImplementation(async (check) => {
    check();
    await Promise.resolve();
    if (change === 'scope') f.args.scopeId = 'foreign';
    if (change === 'settings')
      writeAtomic(f.root, 'settings.json', { ...f.settings, databaseFingerprint: digest('changed') });
    if (change === 'release' || change === 'generation' || change === 'maintenance') {
      const state = readTarget(f.settings.stateRoot, f.binding);
      writeAtomic(f.settings.stateRoot, 'state.json', {
        ...state,
        ...(change === 'release'
          ? { releaseId: 'release-foreign' }
          : change === 'generation'
            ? { generation: state.generation + 1 }
            : { maintenance: true }),
      });
    }
    if (change === 'journal') writeAtomic(f.settings.stateRoot + '/actions', 'owner.json', { foreign: true });
    if (change === 'native_owner')
      f.native
        .prepare('UPDATE cos_identity_boundaries SET binding=?')
        .run(JSON.stringify({ ...f.owner, ownerId: 'foreign' }));
    if (change === 'retained_receipt') {
      const record = readPrivate<Record<string, unknown>>(f.receiptRoot + '/deployment.json');
      writeAtomic(f.receiptRoot, 'deployment.json', { ...record, bindingDigest: digest('foreign') });
    }
    if (change === 'health') ports.healthy.mockResolvedValue(false);
    if (change === 'result') ports.restore.mockResolvedValue({ validation: { writerActivated: true } });
  });
  await expect(f.invoke()).rejects.toThrow(/^backup_owner_restore_unavailable$/);
  if (change !== 'result') expect(ports.restore).not.toHaveBeenCalled();
});
it('does not steal the existing operation lock or access the NAS while another operation owns it', async () => {
  const f = fixture();
  await withDeploymentLock(f.settings.stateRoot + '.operation.lock', async () => {
    await expect(f.invoke()).rejects.toThrow(/^backup_owner_restore_unavailable$/);
    expect(ports.mount).not.toHaveBeenCalled();
    expect(ports.restore).not.toHaveBeenCalled();
  });
});
it('expires all owner callbacks and refuses a changed database before acknowledgment', async () => {
  const f = fixture();
  let borrowed: (() => void) | undefined;
  const restore = ports.restore.getMockImplementation()!;
  ports.restore.mockImplementation(async (identity, ...rest) => {
    borrowed = identity.current;
    const result = await restore(identity, ...rest);
    f.checkDatabase.mockRejectedValue(Error('PRIVATE_DATABASE_WITHDRAWAL'));
    return result;
  });
  await expect(f.invoke()).rejects.toThrow(/^backup_owner_restore_unavailable$/);
  expect(() => borrowed!()).toThrow();
});
it('refuses failed database admission before NAS access', async () => {
  const f = fixture();
  ports.separate.mockRejectedValue(Error('PRIVATE_DATABASE_WITHDRAWAL'));
  await expect(f.invoke()).rejects.toThrow(/^backup_owner_restore_unavailable$/);
  expect(ports.mount).not.toHaveBeenCalled();
  expect(ports.restore).not.toHaveBeenCalled();
});
it('requires healthy current ownership after the fixed restore returns', async () => {
  const f = fixture(),
    restore = ports.restore.getMockImplementation()!;
  ports.restore.mockImplementation(async (...args) => {
    const result = await restore(...args);
    ports.healthy.mockResolvedValue(false);
    return result;
  });
  await expect(f.invoke()).rejects.toThrow(/^backup_owner_restore_unavailable$/);
});
