import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
const calls = vi.hoisted(() => ({
  service: vi.fn(),
  docker: vi.fn(),
  database: vi.fn(),
  observe: vi.fn(),
  ownedContainers: vi.fn(),
}));
vi.mock('./target-host.js', async () => ({
  ...(await vi.importActual('./target-host.js')),
  targetCommands: () => ({ ...calls }),
  checkedTargetDatabase: calls.database,
}));
import { createTargetEffects } from './target-effects.js';
import { fixtureRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import type { DeploymentSettings } from './deployment-settings.js';
import * as maintenance from './maintenance.js';
import * as migrations from '../store/migrations.js';
import * as nativeInstallation from './native-installation.js';
import { targetBinding } from './target-host.js';
import { writeAtomic } from './target-state.js';
import { digest } from '../domain/contracts.js';
import type { DeploymentReceipt } from './deployment.js';
it('S05 target activation and legacy rollback refuse permanent child state even when PostgreSQL matches old code', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-child-downgrade-'));
  const settings = {
    stateRoot: root + '/state',
    releaseRoot: root + '/releases',
    stagingRoot: root + '/staging',
    sourceRoot: root + '/source',
    userHome: root,
    installationRoot: root,
    dataRoot: root + '/data',
    service: 'nano.service',
    hostFingerprint: '1'.repeat(64),
    databaseFingerprint: '2'.repeat(64),
  } as DeploymentSettings;
  fs.mkdirSync(settings.dataRoot, { mode: 0o700 });
  const db = new Database(settings.dataRoot + '/v2.db');
  db.exec(
    "CREATE TABLE cos_mission_boundaries(opaque TEXT); INSERT INTO cos_mission_boundaries VALUES('retained'); CREATE TABLE messages(body TEXT); INSERT INTO messages VALUES('KEEP'); CREATE TABLE host_execution_lease(singleton_id INTEGER,pid INTEGER)",
  );
  db.close();
  vi.spyOn(maintenance, 'maintenanceLeaseForOwner').mockReturnValue({} as any);
  vi.spyOn(maintenance, 'assertMaintenanceLease').mockReturnValue({} as any);
  vi.spyOn(migrations, 'migrationStatus').mockResolvedValue(6);
  const install = vi
    .spyOn(nativeInstallation, 'installServiceOverride')
    .mockReturnValue({ file: '/fixture', sha256: 'a'.repeat(64) });
  calls.database.mockResolvedValue({ end: vi.fn() });
  calls.service.mockClear();
  calls.observe.mockResolvedValue({ pid: 0, cwd: root, activeState: 'inactive' });
  calls.ownedContainers.mockResolvedValue([]);
  const manifest = fixtureRelease('S04'),
    receipt = path.join(settings.stateRoot, 'releases', manifest.releaseId);
  fs.mkdirSync(receipt, { recursive: true, mode: 0o700 });
  writeAtomic(receipt, 'baseline.json', {
    version: 1,
    bindingDigest: digest(targetBinding(settings)),
    releaseId: null,
    executable: '/legacy/node',
    entryPoint: '/legacy/index.js',
    unit: 'legacy',
  });
  try {
    const effects = createTargetEffects(settings, manifest, digest(manifest));
    vi.spyOn(effects, 'artifacts').mockResolvedValue();
    await expect(effects.activate()).rejects.toThrow('specialist_release_required');
    expect(install).not.toHaveBeenCalled();
    expect(calls.service).not.toHaveBeenCalled();
    await expect(effects.rollback(null)).resolves.toBe(false);
    expect(calls.service).not.toHaveBeenCalled();
    const prior = { ...fixtureRelease('S04'), releaseId: 'release-prior' };
    const candidate = { ...manifest, previousReleaseIds: [prior.releaseId] };
    fs.mkdirSync(path.join(settings.releaseRoot, prior.releaseId), { recursive: true, mode: 0o700 });
    writeAtomic(path.join(settings.releaseRoot, prior.releaseId), 'release.json', prior);
    writeAtomic(receipt, 'baseline.json', {
      version: 1,
      bindingDigest: digest(targetBinding(settings)),
      releaseId: prior.releaseId,
      executable: '/prior/node',
      entryPoint: '/prior/index.js',
      unit: 'prior',
    });
    await expect(createTargetEffects(settings, candidate, digest(candidate)).rollback(prior.releaseId)).resolves.toBe(
      false,
    );
    expect(calls.service).not.toHaveBeenCalled();
    const check = new Database(settings.dataRoot + '/v2.db', { readonly: true });
    expect(check.prepare('SELECT * FROM messages').all()).toEqual([{ body: 'KEEP' }]);
    expect(check.prepare('SELECT * FROM cos_mission_boundaries').all()).toEqual([{ opaque: 'retained' }]);
    check.close();
    // Even if preflight sees no children, a final in-flight allocation before shutdown must block restoration.
    const mutable = new Database(settings.dataRoot + '/v2.db');
    mutable.exec('DELETE FROM cos_mission_boundaries');
    mutable.close();
    writeAtomic(receipt, 'baseline.json', {
      version: 1,
      bindingDigest: digest(targetBinding(settings)),
      releaseId: null,
      executable: '/legacy/node',
      entryPoint: '/legacy/index.js',
      unit: 'legacy',
    });
    calls.service.mockImplementation(async (action) => {
      if (action === 'stop') {
        const late = new Database(settings.dataRoot + '/v2.db');
        late.exec("INSERT INTO cos_mission_boundaries VALUES('late-child')");
        late.close();
      }
    });
    await expect(effects.rollback(null)).resolves.toBe(false);
    expect(calls.service.mock.calls).toEqual([['stop']]);
  } finally {
    vi.restoreAllMocks();
    calls.database.mockReset();
    calls.service.mockReset();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it('cannot stop, migrate, activate or roll back without the current Pi-owned maintenance lease', async () => {
  const settings = {
    stateRoot: '/tmp/nonexistent-cos-target-fixture',
    releaseRoot: '/tmp/cos-release-fixture',
    stagingRoot: '/tmp/cos-staging-fixture',
    sourceRoot: '/tmp/cos-source-fixture',
    userHome: '/tmp',
    installationRoot: '/tmp/cos-install-fixture',
    dataRoot: '/tmp/cos-install-fixture/data',
    service: 'nano.service',
    hostFingerprint: '1'.repeat(64),
    databaseFingerprint: '2'.repeat(64),
  } as DeploymentSettings;
  const effects = createTargetEffects(settings, fixtureRelease(), '3'.repeat(64));
  for (const action of [
    () => effects.quiesce(),
    () => effects.backup(),
    () => effects.migrate(),
    () => effects.activate(),
    () => effects.rollback(null),
  ])
    await expect(action()).rejects.toThrow();
  expect(calls.service).not.toHaveBeenCalled();
  expect(calls.docker).not.toHaveBeenCalled();
  expect(calls.database).not.toHaveBeenCalled();
});

it.each([
  ['S02', 2, 'S01'],
  ['S03', 3, 'S02'],
  ['S04', 6, 'S03'],
  ['S05', 9, 'S04'],
] as const)(
  'activates %s only on schema %s and refuses predecessor rollback after migration',
  async (slice, version, priorSlice) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-target-schema-'));
    const settings = {
      stateRoot: path.join(root, 'state'),
      releaseRoot: path.join(root, 'releases'),
      stagingRoot: path.join(root, 'staging'),
      sourceRoot: path.join(root, 'source'),
      userHome: root,
      installationRoot: root,
      dataRoot: path.join(root, 'data'),
      service: 'nano.service',
      hostFingerprint: '1'.repeat(64),
      databaseFingerprint: '2'.repeat(64),
    } as DeploymentSettings;
    vi.spyOn(maintenance, 'maintenanceLeaseForOwner').mockReturnValue(
      {} as ReturnType<typeof maintenance.maintenanceLeaseForOwner>,
    );
    vi.spyOn(maintenance, 'assertMaintenanceLease').mockReturnValue(
      {} as ReturnType<typeof maintenance.assertMaintenanceLease>,
    );
    const schema = vi.spyOn(migrations, 'migrationStatus').mockResolvedValue(version - 1);
    const install = vi
      .spyOn(nativeInstallation, 'installServiceOverride')
      .mockReturnValue({ file: '/fixture/override', sha256: 'a'.repeat(64) });
    const end = vi.fn();
    calls.database.mockResolvedValue({ end });
    calls.service.mockClear();
    const previous = { ...fixtureRelease(priorSlice), releaseId: 'release-prior' };
    const manifest = { ...fixtureRelease(slice), previousReleaseIds: [previous.releaseId] };
    const receipt = path.join(settings.stateRoot, 'releases', manifest.releaseId);
    fs.mkdirSync(settings.dataRoot, { recursive: true, mode: 0o700 });
    const native = new Database(path.join(settings.dataRoot, 'v2.db'));
    native.exec('CREATE TABLE agent_groups(id TEXT,folder TEXT,agent_provider TEXT)');
    native.close();
    try {
      const effects = createTargetEffects(settings, manifest, digest(manifest));
      const artifacts = vi.spyOn(effects, 'artifacts').mockResolvedValue(undefined);
      await expect(effects.activate()).rejects.toThrow('schema_incompatible');
      expect(artifacts).not.toHaveBeenCalled();
      expect(install).not.toHaveBeenCalled();
      expect(calls.service).not.toHaveBeenCalled();
      schema.mockResolvedValue(version);
      await effects.activate();
      expect(artifacts).toHaveBeenCalledOnce();
      expect(install).toHaveBeenCalledOnce();
      expect(calls.service.mock.calls).toEqual([['daemon-reload'], ['restart']]);
      expect(end).toHaveBeenCalledTimes(2);

      for (const directory of [
        receipt,
        path.join(settings.releaseRoot, previous.releaseId),
        path.join(settings.stateRoot, 'releases', previous.releaseId),
        settings.dataRoot,
      ])
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeAtomic(receipt, 'baseline.json', {
        version: 1,
        bindingDigest: digest(targetBinding(settings)),
        releaseId: previous.releaseId,
        executable: '/prior/node',
        entryPoint: '/prior/index.js',
        unit: 'prior unit',
      });
      writeAtomic(path.join(settings.releaseRoot, previous.releaseId), 'release.json', previous);
      writeAtomic(path.join(settings.stateRoot, 'releases', previous.releaseId), 'deployment.json', {
        status: 'healthy',
        manifestDigest: digest(previous),
      });
      calls.service.mockClear();
      await expect(effects.rollback(previous.releaseId)).resolves.toBe(false);
      expect(calls.service).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      calls.database.mockReset();
      calls.service.mockClear();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
it('refuses backup and migration if a container survives despite a stopped service and quiescent lease', async () => {
  vi.spyOn(maintenance, 'maintenanceLeaseForOwner').mockReturnValue(
    {} as ReturnType<typeof maintenance.maintenanceLeaseForOwner>,
  );
  vi.spyOn(maintenance, 'assertMaintenanceLease').mockReturnValue(
    {} as ReturnType<typeof maintenance.assertMaintenanceLease>,
  );
  calls.observe.mockResolvedValue({ pid: 0, cwd: '/tmp/cos-install-fixture', activeState: 'inactive' });
  calls.ownedContainers.mockResolvedValue(['a'.repeat(64)]);
  const settings = {
    stateRoot: '/tmp/nonexistent-cos-target-fixture',
    releaseRoot: '/tmp/cos-release-fixture',
    stagingRoot: '/tmp/cos-staging-fixture',
    sourceRoot: '/tmp/cos-source-fixture',
    userHome: '/tmp',
    installationRoot: '/tmp/cos-install-fixture',
    dataRoot: '/tmp/cos-install-fixture/data',
    service: 'nano.service',
    hostFingerprint: '1'.repeat(64),
    databaseFingerprint: '2'.repeat(64),
  } as DeploymentSettings;
  try {
    const effects = createTargetEffects(settings, fixtureRelease(), '3'.repeat(64));
    await expect(effects.backup()).rejects.toThrow('target_not_quiescent');
    await expect(effects.migrate()).rejects.toThrow('target_not_quiescent');
    expect(calls.database).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});
it('includes native history in the actual deployment backup and blocks migration after snapshot corruption', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-target-history-'));
  vi.spyOn(maintenance, 'maintenanceLeaseForOwner').mockReturnValue(
    {} as ReturnType<typeof maintenance.maintenanceLeaseForOwner>,
  );
  vi.spyOn(maintenance, 'assertMaintenanceLease').mockReturnValue(
    {} as ReturnType<typeof maintenance.assertMaintenanceLease>,
  );
  const settings = {
    stateRoot: path.join(root, 'state'),
    releaseRoot: path.join(root, 'releases'),
    stagingRoot: path.join(root, 'staging'),
    sourceRoot: path.join(root, 'source'),
    userHome: root,
    installationRoot: root,
    dataRoot: path.join(root, 'data'),
    service: 'nano.service',
    hostFingerprint: '1'.repeat(64),
    databaseFingerprint: '2'.repeat(64),
  } as DeploymentSettings;
  calls.observe.mockResolvedValue({ pid: 0, cwd: root, activeState: 'inactive' });
  calls.ownedContainers.mockResolvedValue([]);
  const manifest = fixtureRelease(),
    receipt = path.join(settings.stateRoot, 'releases', manifest.releaseId);
  fs.mkdirSync(receipt, { recursive: true, mode: 0o700 });
  fs.mkdirSync(settings.dataRoot, { mode: 0o700 });
  const generation = '11111111-1111-4111-8111-111111111111';
  const source = path.join(settings.stateRoot, 'conversations', generation);
  fs.mkdirSync(source, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(source, 'history.jsonl'), 'retained history');
  const specialist = path.join(settings.stateRoot, 'missions', generation, 'provider');
  fs.mkdirSync(specialist, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(specialist, 'history.jsonl'), 'retained specialist history');
  fs.writeFileSync(path.join(specialist, 'auth.json'), 'SECRET');
  const db = new Database(path.join(settings.dataRoot, 'v2.db'));
  db.exec('CREATE TABLE sessions(id TEXT, agent_group_id TEXT)');
  db.exec('CREATE TABLE cos_conversation_states(generation TEXT)');
  db.prepare('INSERT INTO cos_conversation_states VALUES(?)').run(generation);
  db.close();
  try {
    const effects = createTargetEffects(settings, manifest, '3'.repeat(64));
    fs.renameSync(source, path.join(root, 'temporarily-unavailable'));
    await expect(effects.backup()).rejects.toThrow('conversation_backup_missing_history');
    fs.renameSync(path.join(root, 'temporarily-unavailable'), source);
    await effects.backup();
    const record = JSON.parse(fs.readFileSync(path.join(receipt, 'native-state.json'), 'utf8'));
    expect(record.conversations.present).toBe(true);
    expect(record.conversations.files).toBe(1);
    expect(record.calendar.present).toBe(false);
    expect(record.missions.files).toBe(1);
    const missionCopy = path.join(receipt, 'mission-backup/history/missions', generation, 'provider/history.jsonl');
    expect(fs.readFileSync(missionCopy, 'utf8')).toBe('retained specialist history');
    fs.appendFileSync(missionCopy, 'corrupt');
    await expect(effects.migrate()).rejects.toThrow('mission_backup_conflict');
    expect(calls.database).not.toHaveBeenCalled();
    fs.writeFileSync(missionCopy, 'retained specialist history');
    const calendarReceipt = path.join(receipt, 'calendar-backup.json'),
      calendarBytes = fs.readFileSync(calendarReceipt);
    fs.writeFileSync(calendarReceipt, JSON.stringify({ forged: true }));
    await expect(effects.migrate()).rejects.toThrow('calendar_backup_unavailable');
    expect(calls.database).not.toHaveBeenCalled();
    fs.writeFileSync(calendarReceipt, calendarBytes);
    const copied = path.join(receipt, 'conversation-backup/history', generation, 'history.jsonl');
    expect(fs.readFileSync(copied, 'utf8')).toBe('retained history');
    fs.appendFileSync(copied, 'corrupt');
    await expect(effects.migrate()).rejects.toThrow('conversation_backup_conflict');
    expect(calls.database).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('prepares a stopped-service recovery baseline without adopting a failed candidate as a rollback target', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-native-recovery-'));
  const settings = {
    stateRoot: path.join(root, 'state'),
    releaseRoot: path.join(root, 'releases'),
    stagingRoot: path.join(root, 'staging'),
    sourceRoot: path.join(root, 'source'),
    userHome: root,
    installationRoot: root,
    dataRoot: path.join(root, 'data'),
    service: 'nano.service',
    hostFingerprint: '1'.repeat(64),
    databaseFingerprint: '2'.repeat(64),
  } as DeploymentSettings;
  const previous = { ...fixtureRelease('S02'), releaseId: 'release-failed' };
  const manifest = {
    ...fixtureRelease('S02'),
    releaseId: 'release-corrected',
    previousReleaseIds: [previous.releaseId],
  };
  const priorRoot = path.join(settings.stateRoot, 'releases', previous.releaseId);
  const receiptRoot = path.join(settings.stateRoot, 'releases', manifest.releaseId);
  for (const directory of [
    priorRoot,
    receiptRoot,
    path.join(settings.releaseRoot, previous.releaseId),
    settings.dataRoot,
  ])
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const binding = targetBinding(settings);
  const prior = {
    version: 1,
    releaseId: previous.releaseId,
    manifestDigest: digest(previous),
    bindingDigest: digest(binding),
    previousReleaseId: null,
    completed: ['source', 'artifacts', 'quiesce', 'backup', 'migrate'],
    pending: 'activate',
    status: 'health_failed',
    lease: null,
    updatedAt: new Date().toISOString(),
  } as DeploymentReceipt;
  writeAtomic(priorRoot, 'deployment.json', prior);
  writeAtomic(priorRoot, 'baseline.json', {
    version: 1,
    bindingDigest: digest(binding),
    releaseId: null,
    executable: '/original/node',
    entryPoint: '/original/index.js',
    unit: 'original unit',
  });
  writeAtomic(path.join(settings.releaseRoot, previous.releaseId), 'release.json', previous);
  writeAtomic(receiptRoot, 'deployment.json', { recoveryFrom: previous.releaseId });
  writeAtomic(settings.stateRoot, 'state.json', {
    version: 1,
    binding,
    generation: 1,
    maintenance: true,
    maintenanceId: null,
    releaseId: previous.releaseId,
    lifecycle: 'implementation_disposable',
  });
  const db = new Database(path.join(settings.dataRoot, 'v2.db'));
  db.exec(
    "CREATE TABLE host_execution_lease(singleton_id INTEGER,pid INTEGER); CREATE TABLE messages(body TEXT); INSERT INTO messages VALUES('preserved')",
  );
  db.close();
  vi.spyOn(maintenance, 'maintenanceLeaseForOwner').mockReturnValue(
    {} as ReturnType<typeof maintenance.maintenanceLeaseForOwner>,
  );
  vi.spyOn(maintenance, 'assertMaintenanceLease').mockReturnValue(
    {} as ReturnType<typeof maintenance.assertMaintenanceLease>,
  );
  vi.spyOn(migrations, 'migrationStatus').mockResolvedValue(2);
  calls.database.mockResolvedValue({ end: vi.fn(), query: vi.fn(async () => ({ rows: [{ locked: true }] })) });
  calls.observe.mockResolvedValue({ pid: 0, cwd: root, activeState: 'inactive' });
  calls.ownedContainers.mockResolvedValue([]);
  calls.service.mockImplementation(async (action) => (action === 'cat' ? 'failed candidate unit' : undefined));
  try {
    const effects = createTargetEffects(settings, manifest, digest(manifest));
    await expect(effects.prepareRecovery!({ ...prior, manifestDigest: '0'.repeat(64) })).rejects.toThrow(
      'deployment_recovery_denied',
    );
    vi.mocked(migrations.migrationStatus).mockResolvedValueOnce(1);
    await expect(effects.prepareRecovery!(prior)).rejects.toThrow('deployment_recovery_denied');
    await expect(effects.prepareRecovery!(prior)).resolves.toEqual({
      activeCoordinators: 0,
      activeDatabaseOperations: 0,
    });
    const baseline = JSON.parse(fs.readFileSync(path.join(receiptRoot, 'baseline.json'), 'utf8'));
    expect(baseline).toMatchObject({
      recoveryFrom: previous.releaseId,
      releaseId: previous.releaseId,
      unit: 'failed candidate unit',
    });
    writeAtomic(priorRoot, 'deployment.json', { ...prior, status: 'superseded', supersededBy: manifest.releaseId });
    calls.service.mockClear();
    await expect(effects.rollback(previous.releaseId)).resolves.toBe(false);
    expect(calls.service).not.toHaveBeenCalled();
    await expect(effects.quiesce()).resolves.toEqual({ activeCoordinators: 0, activeDatabaseOperations: 0 });
    const retained = new Database(path.join(settings.dataRoot, 'v2.db'), { readonly: true });
    expect(retained.prepare('SELECT body FROM messages').all()).toEqual([{ body: 'preserved' }]);
    retained.close();
  } finally {
    vi.restoreAllMocks();
    calls.database.mockReset();
    calls.service.mockReset();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
