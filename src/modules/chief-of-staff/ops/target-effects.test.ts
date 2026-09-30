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
