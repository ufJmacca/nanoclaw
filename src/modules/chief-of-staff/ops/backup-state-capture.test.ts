import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { initializeTarget, writeAtomic } from './target-state.js';
import { beginMaintenance, confirmQuiescence } from './maintenance.js';
import { machineFingerprint } from './target-identity.js';
import { targetBinding } from './target-host.js';
import { initializeTargetActionWitness } from '../actions/host-ownership.js';
import { acquireHostExecutionLease, releaseHostExecutionLease } from '../../../db/host-execution-lease.js';
import type { DeploymentSettings } from './deployment-settings.js';
import { captureTargetVaultState, verifyTargetVaultState } from './backup-state-capture.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
const f = vi.hoisted(() => ({
  observe: vi.fn(),
  containers: vi.fn(),
  capture: vi.fn(),
  calendar: vi.fn(),
  memory: vi.fn(),
  connect: vi.fn(),
  areas: {} as Record<string, string>,
}));
vi.mock('./host-fingerprint.js', () => ({ machineFingerprint: () => 'a'.repeat(64) }));
vi.mock('./target-host.js', async (original) => ({
  ...(await original<typeof import('./target-host.js')>()),
  targetCommands: () => ({ observe: f.observe, ownedContainers: f.containers }),
  checkedTargetDatabase: f.connect,
}));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: f.memory }));
vi.mock('./vault-storage.js', () => ({
  verifyVaultStorage: () => ({
    targetDigest: 'a'.repeat(64),
    volume: { filesystemUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  }),
  withVaultDirectory: async (_roots: unknown, area: string, operation: (directory: string) => Promise<unknown>) =>
    operation(f.areas[area]),
}));
vi.mock('./recovery-manifest.js', () => ({ captureOperationsState: f.capture }));
vi.mock('../calendar/backup.js', () => ({ captureCalendarState: f.calendar }));
const cleanup: Array<() => void> = [];
function rootCanaryMetadataFixture(properties: Partial<fs.Stats> = {}) {
  const lstat = fs.lstatSync,
    fstat = fs.fstatSync,
    open = fs.openSync,
    read = fs.readSync,
    close = fs.closeSync,
    held = new Set<number>(),
    reads: number[] = [];
  const observed = (stat: fs.Stats) =>
    Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 0, gid: 0 }, properties);
  vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, options?: fs.StatOptions) => {
    const stat = lstat(file, options as never);
    return String(file).endsWith('/.vault-canary') && stat ? observed(stat) : stat;
  }) as typeof fs.lstatSync);
  vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
    const fd = open(file, flags, mode);
    if (String(file).endsWith('/.vault-canary') && typeof flags === 'number' && flags & 0x200000) held.add(fd);
    return fd;
  });
  vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, options?: fs.StatOptions) => {
    const stat = fstat(fd, options as never);
    return held.has(fd) ? observed(stat) : stat;
  }) as typeof fs.fstatSync);
  vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, ...args: unknown[]) => {
    if (held.has(fd)) reads.push(fd);
    return (read as (...args: unknown[]) => unknown)(fd, ...args);
  }) as typeof fs.readSync);
  vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
    held.delete(fd);
    close(fd);
  });
  return { reads, held };
}
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
async function fixture(databaseFingerprint = 'd'.repeat(64), scopeId = 'scope') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-full-vault-capture-'));
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
    hostFingerprint: machineFingerprint(),
    databaseFingerprint,
  };
  fs.mkdirSync(settings.dataRoot, { recursive: true, mode: 0o700 });
  const initial = initializeTarget(settings.stateRoot, targetBinding(settings));
  writeAtomic(settings.stateRoot, 'protected.json', { bindingDigest: digest(initial.binding), generation: 1 });
  writeAtomic(settings.stateRoot, 'state.json', {
    ...initial,
    lifecycle: 'protected',
    maintenance: false,
    releaseId: 'release-current',
  });
  const operationId = 'release-action-' + randomUUID(),
    maintenance = beginMaintenance(settings.stateRoot, initial.binding, 'fixture-admin', 'deployment');
  await confirmQuiescence(settings.stateRoot, initial.binding, maintenance, async () => ({
    activeCoordinators: 0,
    activeDatabaseOperations: 0,
  }));
  const native = new Database(settings.dataRoot + '/v2.db');
  cleanup.push(() => native.close());
  native.exec(
    'CREATE TABLE sessions(id TEXT,agent_group_id TEXT); CREATE TABLE cos_identity_boundaries(scope_id TEXT,agent_group_id TEXT,messaging_group_id TEXT,session_id TEXT,binding TEXT,paused INTEGER); CREATE TABLE host_execution_lease(singleton_id INTEGER PRIMARY KEY,owner_id TEXT,pid INTEGER,acquired_at TEXT)',
  );
  const binding = {
    scopeId,
    ownerId: 'owner',
    botId: 'bot',
    instanceId: 'fixture',
    channelId: 'private',
    agentGroupId: scopeId === 'scope' ? 'main' : scopeId,
    messagingGroupId: 'chat',
    provider: 'codex',
    sessionId: 'main',
  };
  native.prepare('INSERT INTO sessions VALUES(?,?)').run('main', binding.agentGroupId);
  native
    .prepare('INSERT INTO cos_identity_boundaries VALUES(?,?,?,?,?,?)')
    .run(binding.scopeId, binding.agentGroupId, 'chat', 'main', JSON.stringify(binding), 1);
  const hostLease = acquireHostExecutionLease(native);
  cleanup.push(() => releaseHostExecutionLease(native, hostLease));
  const witness = initializeTargetActionWitness(settings.stateRoot, digest(initial.binding));
  for (const name of ['staging', 'journals', 'backup-credentials']) {
    const area = root + '/vault-' + name;
    fs.mkdirSync(area, { mode: 0o700 });
    f.areas[name] = area;
  }
  fs.writeFileSync(f.areas['backup-credentials'] + '/smb-credentials', 'PRIVATE_SYNTHETIC_CREDENTIAL', { mode: 0o600 });
  fs.mkdirSync(f.areas.journals + '/empty', { mode: 0o700 });
  fs.writeFileSync(f.areas.journals + '/credential-event.json', '{"event":"synthetic"}', { mode: 0o600 });
  fs.writeFileSync(witness.root + '/' + randomUUID() + '.json', '{"event":"synthetic-effect"}', { mode: 0o600 });
  fs.mkdirSync(settings.stateRoot + '/conversations', { mode: 0o700 });
  f.observe.mockResolvedValue({ pid: 0, cwd: settings.installationRoot, activeState: 'inactive' });
  f.containers.mockResolvedValue([]);
  const end = vi.fn(async () => {});
  f.connect.mockResolvedValue({ end });
  const recovery = {
    releaseId: 'release-current',
    manifestDigest: 'c'.repeat(64),
    software: {
      sourceCommit: '1'.repeat(40),
      sourceTree: '2'.repeat(40),
      hostPayloadSha256: '3'.repeat(64),
      schemaVersion: 18,
      nativeSchemaVersion: 22,
    },
  };
  f.calendar.mockImplementation(async (_options, sink) => {
    sink.write('calendar-state/token.json', Buffer.from('SYNTHETIC_CALENDAR_TOKEN'));
    return { contract: 'cos-calendar-capture/v1', present: true, sha256: '4'.repeat(64), directories: [] };
  });
  f.capture.mockImplementation(async (options, sink) => {
    await options.base.quiescent();
    sink.write('coordinated/remote.json', Buffer.from('SYNTHETIC_SCOPED_DATABASE'));
    sink.write('coordinated/sqlite/0/native.sqlite', native.serialize());
    return {
      checkpoint: {
        operationId,
        remote: { sha256: '5'.repeat(64) },
        journal: { installationDigest: witness.installationDigest, generation: witness.generation },
      },
      operations: { admissionRestored: false, effectsEnabled: false, software: recovery.software },
    };
  });
  const admin = { native, hostLease, maintenance, check: async () => {} };
  return {
    root,
    settings,
    operationId,
    admin,
    native,
    binding,
    witness,
    recovery,
    end,
    queue: () => f.areas.staging + '/backup-queue/full',
  };
}
it('captures the full selected state directly into the fixed encrypted queue slot', async () => {
  const s = await fixture(),
    result = await captureTargetVaultState(s.settings, s.operationId, s.admin, s.recovery);
  expect(result).toMatchObject({
    status: 'queued',
    operationId: s.operationId,
    queueOperationId: s.operationId.slice('release-action-'.length),
    writerActivated: false,
    admissionRestored: false,
  });
  const data = s.queue() + '/data';
  expect(fs.readFileSync(data + '/vault-backup-credentials/smb-credentials', 'utf8')).toBe(
    'PRIVATE_SYNTHETIC_CREDENTIAL',
  );
  expect(fs.readFileSync(data + '/calendar-state/token.json', 'utf8')).toBe('SYNTHETIC_CALENDAR_TOKEN');
  expect(fs.existsSync(data + '/coordinated/sqlite/0/native.sqlite')).toBe(true);
  expect(fs.existsSync(data + '/effects/owner.json')).toBe(true);
  expect(fs.existsSync(data + '/vault-journals/credential-event.json')).toBe(true);
  expect(JSON.parse(fs.readFileSync(data + '/vault-journals.capture.json', 'utf8')).directories).toContain('empty');
  expect(fs.existsSync(s.settings.stateRoot + '/releases')).toBe(false);
  expect(s.end).toHaveBeenCalledTimes(1);
});
it('skips another full capture before database or credential reads when the slot is occupied', async () => {
  const s = await fixture();
  await captureTargetVaultState(s.settings, s.operationId, s.admin, s.recovery);
  f.connect.mockClear();
  f.capture.mockClear();
  f.calendar.mockClear();
  const second = await captureTargetVaultState(s.settings, 'release-action-' + randomUUID(), s.admin, s.recovery);
  expect(second.status).toBe('skipped_pending');
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.capture).not.toHaveBeenCalled();
  expect(f.calendar).not.toHaveBeenCalled();
});
it('refuses unpaused CoS even when the main application is stopped', async () => {
  const s = await fixture();
  s.native.exec('UPDATE cos_identity_boundaries SET paused=0');
  await expect(captureTargetVaultState(s.settings, s.operationId, s.admin, s.recovery)).rejects.toThrow(
    'target_vault_capture_unavailable',
  );
  expect(f.connect).not.toHaveBeenCalled();
});
it('refuses a lost real native host lease and does not publish success', async () => {
  const s = await fixture();
  f.capture.mockImplementation(async () => {
    releaseHostExecutionLease(s.native, s.admin.hostLease);
    return {};
  });
  await expect(captureTargetVaultState(s.settings, s.operationId, s.admin, s.recovery)).rejects.toThrow(
    'target_vault_capture_unavailable',
  );
  expect(s.end).toHaveBeenCalledTimes(1);
});
it('preserves a failed slot and closes the database if capture fails', async () => {
  const s = await fixture();
  f.capture.mockRejectedValue(Error('PRIVATE_DATABASE_ERROR'));
  await expect(captureTargetVaultState(s.settings, s.operationId, s.admin, s.recovery)).rejects.toThrow(
    'target_vault_capture_unavailable',
  );
  expect(JSON.parse(fs.readFileSync(s.queue() + '/receipt.json', 'utf8')).state).toBe('failed');
  expect(s.end).toHaveBeenCalledTimes(1);
});
it('refuses unsafe credential files without following them', async () => {
  const s = await fixture();
  fs.symlinkSync(s.settings.stateRoot + '/state.json', f.areas['backup-credentials'] + '/foreign');
  await expect(captureTargetVaultState(s.settings, s.operationId, s.admin, s.recovery)).rejects.toThrow(
    'target_vault_capture_unavailable',
  );
  expect(f.connect).not.toHaveBeenCalled();
});
it('records the G01 root-owned recovery canary as excluded forensic metadata without reading or copying its bytes', async () => {
  const s = await fixture();
  fs.writeFileSync(f.areas.journals + '/.vault-canary', 'SYNTHETIC_HOST_BOUND_PROOF', { mode: 0o600 });
  const observed = rootCanaryMetadataFixture();
  expect((await captureTargetVaultState(s.settings, s.operationId, s.admin, s.recovery)).status).toBe('queued');
  const receipt = JSON.parse(fs.readFileSync(s.queue() + '/data/vault-journals.capture.json', 'utf8'));
  expect(receipt.excluded).toEqual([
    {
      name: '.vault-canary',
      reason: 'host_bound_vault_proof',
      metadataDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  ]);
  expect(receipt.files.map((file: { name: string }) => file.name)).not.toContain('.vault-canary');
  expect(fs.existsSync(s.queue() + '/data/vault-journals/.vault-canary')).toBe(false);
  expect(observed.reads).toEqual([]);
});
it.each(['owner-marker', 'linked-marker', 'public-marker', 'other-hidden-file'] as const)(
  'refuses %s while excluding only the intact G01 root proof',
  async (reason) => {
    const s = await fixture();
    fs.writeFileSync(
      f.areas.journals + (reason === 'other-hidden-file' ? '/.other-canary' : '/.vault-canary'),
      'SYNTHETIC_PRIVATE_FILE',
      { mode: 0o600 },
    );
    if (reason !== 'owner-marker')
      rootCanaryMetadataFixture(
        reason === 'linked-marker' ? { nlink: 2 } : reason === 'public-marker' ? { mode: 0o100644 } : {},
      );
    await expect(captureTargetVaultState(s.settings, s.operationId, s.admin, s.recovery)).rejects.toThrow(
      'target_vault_capture_unavailable',
    );
    expect(f.connect).not.toHaveBeenCalled();
  },
);
it('refuses replacement of the pinned root canary while checking current capture authority', async () => {
  const s = await fixture(),
    file = f.areas.journals + '/.vault-canary';
  fs.writeFileSync(file, 'SYNTHETIC_HOST_BOUND_PROOF', { mode: 0o600 });
  const observed = rootCanaryMetadataFixture();
  let changed = false;
  s.admin.check = async () => {
    if (observed.held.size && !changed) {
      changed = true;
      fs.renameSync(file, file + '.original');
      fs.writeFileSync(file, 'SYNTHETIC_REPLACEMENT', { mode: 0o600 });
    }
  };
  await expect(captureTargetVaultState(s.settings, s.operationId, s.admin, s.recovery)).rejects.toThrow(
    'target_vault_capture_unavailable',
  );
  expect(changed).toBe(true);
  expect(observed.reads).toEqual([]);
  expect(f.connect).not.toHaveBeenCalled();
});
it('fails closed before reads when the memory policy is unavailable', async () => {
  const s = await fixture();
  f.memory.mockImplementation(() => {
    throw Error('PRIVATE_MEMORY_ERROR');
  });
  await expect(captureTargetVaultState(s.settings, s.operationId, s.admin, s.recovery)).rejects.toThrow(
    'target_vault_capture_unavailable',
  );
  expect(f.connect).not.toHaveBeenCalled();
  expect(fs.existsSync(f.areas.staging + '/backup-queue')).toBe(false);
});

it('connects the real coordinated/native/operations/history producers to the actual queue with scoped query and OS protection fixtures', async () => {
  const s = await fixture();
  const { captureOperationsState } =
    await vi.importActual<typeof import('./recovery-manifest.js')>('./recovery-manifest.js');
  const { captureCalendarState } =
    await vi.importActual<typeof import('../calendar/backup.js')>('../calendar/backup.js');
  const { MIGRATIONS } = await import('../store/migrations.js');
  f.capture.mockImplementation(captureOperationsState);
  f.calendar.mockImplementation(captureCalendarState);
  const query = vi.fn(async (sql: string, parameters?: string[]) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('to_regclass')) return { rows: [{ ledger: 'cos.schema_migrations' }] };
    if (sql.includes('FROM cos.schema_migrations'))
      return { rows: MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })) };
    if (sql.includes('SELECT owner_id,agent_group_id'))
      return { rows: [{ owner_id: s.binding.ownerId, agent_group_id: s.binding.agentGroupId }] };
    if (sql.includes('FROM pg_attribute'))
      return {
        rows: (parameters?.[0] === 'cos.scopes' ? ['id', 'owner_id', 'agent_group_id'] : ['scope_id']).map(
          (attname) => ({ attname }),
        ),
      };
    if (sql.includes('to_jsonb(t)'))
      return {
        rows: sql.includes('cos."scopes"')
          ? [{ body: { id: s.binding.scopeId, owner_id: s.binding.ownerId, agent_group_id: s.binding.agentGroupId } }]
          : [],
      };
    if (sql.includes('clock_timestamp')) return { rows: [{ now: new Date() }] };
    return { rows: [] };
  });
  f.connect.mockResolvedValue({ query, end: s.end });
  const result = await captureTargetVaultState(s.settings, s.operationId, s.admin, s.recovery);
  expect(result.status).toBe('queued');
  const data = s.queue() + '/data',
    checkpoint = JSON.parse(fs.readFileSync(data + '/coordinated/manifest.json', 'utf8')),
    operations = JSON.parse(fs.readFileSync(data + '/' + s.operationId + '.operations.json', 'utf8')),
    header = JSON.parse(fs.readFileSync(data + '/state-capture.json', 'utf8'));
  if (result.status !== 'queued') throw Error('fixture_checkpoint_not_queued');
  expect(checkpoint.sqlite).toHaveLength(1);
  expect(operations.coordinatedDigest).toBe(digest(checkpoint));
  expect(header.operations.manifestDigest).toBe(digest(operations));
  expect(header.checkpointDigest).toBe(digest(checkpoint));
  expect(header.inputs.context.scopeId).toBe(s.binding.scopeId);
  const { verifyCoordinatedBackup } = await import('./coordinated-backup.js');
  expect(
    await verifyCoordinatedBackup({
      ...header.inputs,
      receiptRoot: data,
      operationId: s.operationId,
      databaseFingerprint: s.settings.databaseFingerprint,
      artifacts: { root: header.inputs.artifactsRoot },
      witness: s.witness,
    }),
  ).toEqual(checkpoint);
  expect(await verifyTargetVaultState(s.settings, s.operationId, s.admin, s.recovery, result.snapshotDigest)).toEqual(
    result,
  );
  await expect(verifyTargetVaultState(s.settings, s.operationId, s.admin, s.recovery, 'f'.repeat(64))).rejects.toThrow(
    'target_vault_capture_unavailable',
  );
  await expect(
    verifyTargetVaultState(s.settings, s.operationId, s.admin, { ...s.recovery, releaseId: 'release-foreign' }),
  ).rejects.toThrow('target_vault_capture_unavailable');
  expect(JSON.parse(fs.readFileSync(data + '/calendar-capture-receipt.json', 'utf8')).present).toBe(false);
  expect(fs.existsSync(s.settings.stateRoot + '/actions/coordinated')).toBe(false);
  expect(fs.existsSync(s.settings.stateRoot + '/releases')).toBe(false);
  expect(query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  expect(query).toHaveBeenCalledWith('SELECT pg_advisory_unlock(73101003)');
  expect(s.end).toHaveBeenCalledOnce();
  const copy = new Database(data + '/coordinated/sqlite/0/native.sqlite', { readonly: true });
  try {
    expect(copy.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
    expect(copy.prepare('SELECT owner_id FROM host_execution_lease').get()).toEqual({
      owner_id: s.admin.hostLease.ownerId,
    });
  } finally {
    copy.close();
  }
  fs.appendFileSync(data + '/coordinated/remote.json', 'changed');
  await expect(verifyTargetVaultState(s.settings, s.operationId, s.admin, s.recovery)).rejects.toThrow(
    'target_vault_capture_unavailable',
  );
});

it.runIf(process.env.COS_TEST_TARGET_ID !== undefined)(
  'captures the admitted separate PostgreSQL scope through real producers without exposing foreign records or resetting native state',
  async () => {
    const { connectFixtureDatabase, fixtureDatabaseConfig, fixtureProfile } =
      await import('../../../contracts/chief-of-staff/fixture-database.js');
    const { migrationStatus, SCHEMA_VERSION } = await import('../store/migrations.js');
    const { databaseFingerprint } = await import('./target-identity.js');
    const { captureOperationsState } =
      await vi.importActual<typeof import('./recovery-manifest.js')>('./recovery-manifest.js');
    const { captureCalendarState } =
      await vi.importActual<typeof import('../calendar/backup.js')>('../calendar/backup.js');
    expect(fixtureProfile()).toBe('test');
    const admin = await connectFixtureDatabase(process.env, 'migration'),
      scope = 'vault-capture-' + randomUUID(),
      foreign = 'vault-capture-foreign-' + randomUUID();
    let inserted = false;
    try {
      expect((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked).toBe(true);
      expect(await migrationStatus(admin)).toBe(SCHEMA_VERSION);
      const fingerprint = await databaseFingerprint(admin, await fixtureDatabaseConfig(process.env, 'migration')),
        s = await fixture(fingerprint, scope),
        sentinel = 'SYNTHETIC_PG_PRIVATE_' + randomUUID();
      await admin.query('BEGIN');
      for (const id of [scope, foreign]) {
        await admin.query(
          "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'owner','fixture',$1,$1,'active')",
          [id],
        );
        await admin.query(
          "INSERT INTO cos.records(id,scope_id,kind,title,description,lifecycle,version,provenance) VALUES($1,$2,'goal',$3,$3,'active',1,'{}')",
          ['goal-' + id, id, id === scope ? sentinel : 'SYNTHETIC_FOREIGN_PRIVATE_' + foreign],
        );
      }
      await admin.query(
        "INSERT INTO cos.sources(id,scope_id,source_key,title,status,processing_providers,access_policy,provenance) VALUES($1,$2,$1,'synthetic source','revoked',ARRAY['codex'],'{}','{}')",
        ['source-' + scope, scope],
      );
      await admin.query(
        "INSERT INTO cos.revocation_tombstones(scope_id,source_id,kind,version,provenance) VALUES($1,$2,'revoke',2,'{}')",
        [scope, 'source-' + scope],
      );
      await admin.query('COMMIT');
      inserted = true;
      s.native.exec(
        "CREATE TABLE ordinary_messages(id TEXT PRIMARY KEY,body TEXT); INSERT INTO ordinary_messages VALUES('message','SYNTHETIC_ORDINARY_HISTORY'); CREATE TABLE cos_model_budgets(activation_id TEXT,consumed INTEGER); INSERT INTO cos_model_budgets VALUES('synthetic-activation',3)",
      );
      const generation = randomUUID(),
        history = s.settings.stateRoot + '/conversations/' + generation;
      fs.mkdirSync(history, { mode: 0o700 });
      fs.writeFileSync(history + '/history', 'SYNTHETIC_MAIN_CONTEXT', { mode: 0o600 });
      fs.writeFileSync(history + '/auth.json', 'SYNTHETIC_PROVIDER_ACCESS_CACHE', { mode: 0o600 });
      const mission = s.settings.stateRoot + '/missions/' + randomUUID();
      fs.mkdirSync(mission + '/provider', { recursive: true, mode: 0o700 });
      fs.mkdirSync(mission + '/context', { mode: 0o700 });
      fs.writeFileSync(mission + '/provider/history', 'SYNTHETIC_SPECIALIST_HISTORY', { mode: 0o600 });
      fs.writeFileSync(mission + '/provider/auth.json', 'SYNTHETIC_SPECIALIST_ACCESS_CACHE', { mode: 0o600 });
      const roots = {
          targetRoot: s.settings.stateRoot,
          installationRoot: s.settings.installationRoot,
          dataRoot: s.settings.dataRoot,
        },
        calendar = roots.targetRoot + '/calendar',
        calendarBackups = s.root + '/calendar-backups';
      for (const directory of [calendar, calendarBackups, calendar + '/credentials', calendar + '/access-denials'])
        fs.mkdirSync(directory, { mode: 0o700 });
      fs.writeFileSync(calendar + '/credentials/token.json', 'SYNTHETIC_GOOGLE_TOKEN', { mode: 0o600 });
      fs.writeFileSync(calendar + '/access-denials/denial.json', 'SYNTHETIC_GOOGLE_REVOCATION', { mode: 0o600 });
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
      const { configureCalendarStorage } = await import('../calendar/storage-policy.js');
      configureCalendarStorage(roots, calendarBackups, inspect);
      const { openKnowledgeArtifacts } = await import('../knowledge/config.js'),
        artifacts = openKnowledgeArtifacts(roots.targetRoot, [roots.installationRoot, roots.dataRoot]),
        artifactName = 'a'.repeat(64) + '-' + 'b'.repeat(64) + '.blob';
      fs.writeFileSync(artifacts.root + '/' + artifactName, 'SYNTHETIC_SELECTED_ARTIFACT', { mode: 0o600 });
      f.capture.mockImplementation(captureOperationsState);
      f.calendar.mockImplementation((options, sink) => captureCalendarState({ ...options, inspect }, sink));
      let connections = 0;
      f.connect.mockImplementation(async () => {
        connections++;
        return connectFixtureDatabase(process.env);
      });
      const before = {
        paused: s.native.prepare('SELECT paused FROM cos_identity_boundaries').get(),
        messages: s.native.prepare('SELECT * FROM ordinary_messages').all(),
        budgets: s.native.prepare('SELECT * FROM cos_model_budgets').all(),
      };
      const result = await captureTargetVaultState(s.settings, s.operationId, s.admin, s.recovery);
      expect(result.status).toBe('queued');
      expect(connections).toBe(1);
      if (result.status !== 'queued') throw Error('fixture_checkpoint_not_queued');
      expect(
        await verifyTargetVaultState(s.settings, s.operationId, s.admin, s.recovery, result.snapshotDigest),
      ).toEqual(result);
      expect(connections).toBe(1);
      const data = s.queue() + '/data',
        remote = JSON.parse(fs.readFileSync(data + '/coordinated/remote.json', 'utf8')),
        operations = JSON.parse(fs.readFileSync(data + '/' + s.operationId + '.operations.json', 'utf8'));
      expect(remote.scopeId).toBe(scope);
      expect(remote.rows.records).toHaveLength(1);
      expect(remote.rows.records[0].title).toBe(sentinel);
      expect(JSON.stringify(remote)).not.toContain(foreign);
      expect(operations.revocations).toEqual([{ sourceId: 'source-' + scope, kind: 'revoke', version: 2 }]);
      expect(fs.readFileSync(data + '/conversation-backup/history/' + generation + '/history', 'utf8')).toBe(
        'SYNTHETIC_MAIN_CONTEXT',
      );
      expect(fs.existsSync(data + '/conversation-backup/history/' + generation + '/auth.json')).toBe(false);
      expect(
        fs.readFileSync(
          data + '/mission-backup/history/missions/' + path.basename(mission) + '/provider/history',
          'utf8',
        ),
      ).toBe('SYNTHETIC_SPECIALIST_HISTORY');
      expect(
        fs.existsSync(data + '/mission-backup/history/missions/' + path.basename(mission) + '/provider/auth.json'),
      ).toBe(false);
      expect(fs.readFileSync(data + '/calendar-state/credentials/token.json', 'utf8')).toBe('SYNTHETIC_GOOGLE_TOKEN');
      expect(fs.readFileSync(data + '/calendar-state/access-denials/denial.json', 'utf8')).toBe(
        'SYNTHETIC_GOOGLE_REVOCATION',
      );
      expect(fs.readFileSync(data + '/coordinated/artifacts/' + artifactName, 'utf8')).toBe(
        'SYNTHETIC_SELECTED_ARTIFACT',
      );
      expect(fs.readdirSync(calendarBackups)).toEqual(['.cos-calendar-backups']);
      expect(s.native.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual(before.paused);
      expect(s.native.prepare('SELECT * FROM ordinary_messages').all()).toEqual(before.messages);
      expect(s.native.prepare('SELECT * FROM cos_model_budgets').all()).toEqual(before.budgets);
      const copy = new Database(data + '/coordinated/sqlite/0/native.sqlite', { readonly: true });
      try {
        expect(copy.prepare('SELECT * FROM ordinary_messages').all()).toEqual(before.messages);
        expect(copy.prepare('SELECT * FROM cos_model_budgets').all()).toEqual(before.budgets);
      } finally {
        copy.close();
      }
      const second = await captureTargetVaultState(s.settings, 'release-action-' + randomUUID(), s.admin, s.recovery);
      expect(second.status).toBe('skipped_pending');
      expect(connections).toBe(1);
      expect(fs.existsSync(s.settings.stateRoot + '/releases')).toBe(false);
    } finally {
      if (!inserted) await admin.query('ROLLBACK');
      else {
        await admin.query('BEGIN');
        await admin.query('DELETE FROM cos.revocation_tombstones WHERE scope_id=$1', [scope]);
        await admin.query('DELETE FROM cos.sources WHERE scope_id=$1', [scope]);
        for (const id of [scope, foreign]) {
          await admin.query('DELETE FROM cos.records WHERE scope_id=$1', [id]);
          await admin.query('DELETE FROM cos.scopes WHERE id=$1', [id]);
        }
        await admin.query('COMMIT');
      }
      await admin.end();
    }
  },
  60000,
);
