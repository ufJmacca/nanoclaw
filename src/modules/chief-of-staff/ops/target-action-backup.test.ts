import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  observe: vi.fn(),
  containers: vi.fn(),
  client: { end: vi.fn(), query: vi.fn() },
  paired: vi.fn(),
}));
vi.mock('./target-host.js', async (original) => ({
  ...(await original<typeof import('./target-host.js')>()),
  targetCommands: () => ({ observe: f.observe, ownedContainers: f.containers }),
  checkedTargetDatabase: async () => f.client,
}));
vi.mock('./target-identity.js', async (original) => ({
  ...(await original<typeof import('./target-identity.js')>()),
  localTarget: (root: string, installationRoot: string, dataRoot: string) => {
    const value = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
    if (value.binding.installationRoot !== installationRoot || value.binding.dataRoot !== dataRoot)
      throw Error('wrong_target');
    return value;
  },
}));
vi.mock('./coordinated-backup.js', async (original) => ({
  ...(await original<typeof import('./coordinated-backup.js')>()),
  backupCoordinatedState: f.paired,
}));
import { backupTargetActionState } from './target-action-backup.js';
import { initializeTarget, readPrivate, type TargetState } from './target-state.js';
import { beginMaintenance, confirmQuiescence } from './maintenance.js';
import { targetBinding } from './target-host.js';
import type { DeploymentSettings } from './deployment-settings.js';
import { digest } from '../domain/contracts.js';
import type { CoordinatedBackupOptions } from './coordinated-backup.js';
const roots: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-target-action-backup-'));
  roots.push(root);
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
    hostFingerprint: digest('fixture host'),
    databaseFingerprint: digest('fixture DB'),
  };
  fs.mkdirSync(settings.dataRoot, { recursive: true, mode: 0o700 });
  initializeTarget(settings.stateRoot, targetBinding(settings));
  const operationId = 'release-fixture-actions',
    lease = beginMaintenance(settings.stateRoot, targetBinding(settings), operationId, 'deployment');
  await confirmQuiescence(settings.stateRoot, targetBinding(settings), lease, async () => ({
    activeCoordinators: 0,
    activeDatabaseOperations: 0,
  }));
  fs.mkdirSync(path.join(settings.stateRoot, 'releases', operationId), { recursive: true, mode: 0o700 });
  const binding = {
    scopeId: 'scope',
    ownerId: 'owner',
    botId: 'bot',
    instanceId: 'fixture',
    channelId: 'private',
    agentGroupId: 'main',
    messagingGroupId: 'chat',
    provider: 'codex',
    sessionId: 'main',
  };
  const db = new Database(path.join(settings.dataRoot, 'v2.db'));
  db.exec(
    'CREATE TABLE sessions(id TEXT,agent_group_id TEXT); CREATE TABLE host_execution_lease(singleton_id INTEGER,pid INTEGER); CREATE TABLE cos_identity_boundaries(scope_id TEXT,agent_group_id TEXT,messaging_group_id TEXT,session_id TEXT,binding TEXT)',
  );
  db.prepare('INSERT INTO sessions VALUES(?,?)').run('main', 'main');
  db.prepare('INSERT INTO sessions VALUES(?,?)').run('ordinary', 'ordinary');
  db.prepare('INSERT INTO cos_identity_boundaries VALUES(?,?,?,?,?)').run(
    'scope',
    'main',
    'chat',
    'main',
    JSON.stringify(binding),
  );
  db.close();
  const sessionFile = path.join(settings.dataRoot, 'v2-sessions', 'ordinary', 'ordinary', 'inbound.db');
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
  const session = new Database(sessionFile);
  session.exec("CREATE TABLE messages(body);INSERT INTO messages VALUES('ordinary history')");
  session.close();
  f.observe.mockResolvedValue({ pid: 0, cwd: settings.installationRoot, activeState: 'inactive' });
  f.containers.mockResolvedValue([]);
  f.paired.mockImplementation(async (options: CoordinatedBackupOptions) => {
    await options.quiescent();
    return {
      format: 'cos-coordinated-backup/v1',
      operationId,
      schemaVersion: 16,
      journal: { installationDigest: options.witness.installationDigest, generation: options.witness.generation },
    };
  });
  return { root, settings, operationId, lease, binding, sessionFile };
}
it('S09 target backup pairs every existing native store with the exact main binding under the current maintenance lease', async () => {
  const s = await fixture(),
    result = await backupTargetActionState(s.settings, s.operationId),
    options = f.paired.mock.calls[0][0] as CoordinatedBackupOptions;
  expect(options.nativeDatabases).toEqual([path.join(s.settings.dataRoot, 'v2.db'), s.sessionFile]);
  expect(options.context).toMatchObject({
    scopeId: 'scope',
    ownerId: 'owner',
    sessionId: 'main',
    agentGroupId: 'main',
  });
  expect(await options.quiescent()).toEqual({
    generation: s.lease.generation,
    activeWorkers: 0,
    activeOperations: 0,
    nativeWriters: 0,
    effectsEnabled: false,
  });
  expect(result.nativeBindingDigest).toBe(digest(s.binding));
  expect(result.targetBindingDigest).toBe(digest(targetBinding(s.settings)));
  expect(options.restrictionFiles).toContain(path.join(s.settings.stateRoot, 'maintenance.json'));
  expect(f.client.end).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain('ordinary history');
  expect(
    readPrivate(path.join(s.settings.stateRoot, 'releases', s.operationId, 'action-state', 'action-backup.json')),
  ).toEqual(result);
});
it.each(['service', 'container', 'native-writer', 'lease', 'foreign-operation', 'missing-binding', 'replaced-binding'])(
  'S09 refuses %s before pairing or initializing the effect journal',
  async (kind) => {
    const s = await fixture();
    if (kind === 'service')
      f.observe.mockResolvedValue({ pid: process.pid, cwd: s.settings.installationRoot, activeState: 'active' });
    if (kind === 'container') f.containers.mockResolvedValue(['owned-running']);
    if (['native-writer', 'missing-binding', 'replaced-binding'].includes(kind)) {
      const db = new Database(path.join(s.settings.dataRoot, 'v2.db'));
      if (kind === 'native-writer') db.prepare('INSERT INTO host_execution_lease VALUES(1,?)').run(process.pid);
      if (kind === 'missing-binding') db.exec('DELETE FROM cos_identity_boundaries');
      if (kind === 'replaced-binding')
        db.prepare('UPDATE cos_identity_boundaries SET binding=?').run(
          JSON.stringify({ ...s.binding, sessionId: 'ordinary' }),
        );
      db.close();
    }
    if (kind === 'lease') {
      const state = readPrivate<TargetState>(path.join(s.settings.stateRoot, 'state.json'));
      state.generation++;
      fs.writeFileSync(path.join(s.settings.stateRoot, 'state.json'), JSON.stringify(state));
    }
    await expect(
      backupTargetActionState(s.settings, kind === 'foreign-operation' ? 'release-foreign' : s.operationId),
    ).rejects.toThrow('target_action_backup_unavailable');
    expect(f.paired).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(s.settings.stateRoot, 'actions', 'effects', 'owner.json'))).toBe(false);
  },
);
it('never repairs a previously owned action root or a lost effect journal on retry', async () => {
  const s = await fixture();
  await backupTargetActionState(s.settings, s.operationId);
  fs.unlinkSync(path.join(s.settings.stateRoot, 'actions', 'effects', 'owner.json'));
  f.paired.mockClear();
  await expect(backupTargetActionState(s.settings, s.operationId)).rejects.toThrow('target_action_backup_unavailable');
  expect(f.paired).not.toHaveBeenCalled();
  expect(fs.readdirSync(path.join(s.settings.stateRoot, 'actions', 'effects'))).toEqual([]);
});
it('rejects a worker becoming active across the awaited paired backup without publishing acceptance', async () => {
  const s = await fixture();
  f.paired.mockImplementation(async () => {
    f.containers.mockResolvedValue(['late-worker']);
    return {};
  });
  await expect(backupTargetActionState(s.settings, s.operationId)).rejects.toThrow('target_action_backup_unavailable');
  expect(
    fs.existsSync(path.join(s.settings.stateRoot, 'releases', s.operationId, 'action-state', 'action-backup.json')),
  ).toBe(false);
  expect(f.client.end).toHaveBeenCalledOnce();
});
it.each(['null-generation', 'wrong-generation', 'owner-hardlink', 'journal-hardlink'])(
  'rejects %s in existing journal ownership instead of admitting a replacement',
  async (kind) => {
    const s = await fixture();
    await backupTargetActionState(s.settings, s.operationId);
    const root = path.join(s.settings.stateRoot, 'actions'),
      owner = path.join(root, 'owner.json');
    if (kind.endsWith('generation')) {
      const value = readPrivate<Record<string, unknown>>(owner);
      value.journalGeneration = kind === 'null-generation' ? null : '11111111-1111-4111-8111-111111111111';
      fs.writeFileSync(owner, JSON.stringify(value));
    } else {
      const file = kind === 'owner-hardlink' ? owner : path.join(root, 'effects', 'owner.json');
      fs.linkSync(file, file + '.copy');
    }
    f.paired.mockClear();
    await expect(backupTargetActionState(s.settings, s.operationId)).rejects.toThrow(
      'target_action_backup_unavailable',
    );
    expect(f.paired).not.toHaveBeenCalled();
  },
);
