import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { digest } from '../domain/contracts.js';
import type { DeploymentSettings } from './deployment-settings.js';
import { targetBinding } from './target-host.js';
import { initializeTarget, readTarget, writeAtomic } from './target-state.js';
import { beginMaintenance, confirmQuiescence } from './maintenance.js';
import { createCheckpointMaintenanceEffects } from './checkpoint-maintenance-effects.js';
import { createOperationsMaintenanceEffects } from './operations-maintenance-effects.js';
const f = vi.hoisted(() => ({
  retained: vi.fn(),
  service: vi.fn(),
  capture: vi.fn(),
  verifyCapture: vi.fn(),
  inspect: vi.fn(),
  memory: vi.fn(),
}));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: f.memory }));
vi.mock('./retained-admin-helper.js', () => ({ verifyRetainedAdminHelper: f.retained }));
vi.mock('./target-host.js', async (original) => ({
  ...(await original<typeof import('./target-host.js')>()),
  verifyTargetPaths: () => {},
  targetCommands: () => ({ service: f.service, ownedContainers: async () => [] }),
}));
vi.mock('./backup-state-capture.js', () => ({
  captureScheduledTargetVaultState: f.capture,
  verifyScheduledTargetVaultState: f.verifyCapture,
}));
vi.mock('./backup-queue.js', () => ({ createVaultBackupQueue: () => ({ inspect: f.inspect }) }));
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.resetAllMocks();
});
function fixture(paused = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-checkpoint-ports-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings: DeploymentSettings = {
    version: 1,
    target: 'pi',
    sshAlias: 'fixture',
    userHome: root,
    stateRoot: root + '/state',
    installationRoot: root + '/app',
    dataRoot: root + '/app/data',
    releaseRoot: root + '/releases',
    stagingRoot: root + '/staging',
    sourceRoot: root + '/sources',
    runtimeEnvironment: root + '/runtime',
    migrationEnvironment: root + '/migration',
    service: 'fixture.service',
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
  };
  const manifest = fixtureVaultRelease('G02'),
    binding = targetBinding(settings),
    requestId = randomUUID();
  initializeTarget(settings.stateRoot, binding);
  fs.mkdirSync(settings.dataRoot, { recursive: true, mode: 0o700 });
  const native = new Database(settings.dataRoot + '/v2.db');
  cleanup.push(() => native.close());
  native.exec(
    "CREATE TABLE cos_identity_boundaries(paused INTEGER); CREATE TABLE messages(body TEXT); CREATE TABLE cos_model_budgets(used INTEGER); INSERT INTO messages VALUES('ordinary-message'); INSERT INTO cos_model_budgets VALUES(3);",
  );
  native.prepare('INSERT INTO cos_identity_boundaries VALUES(?)').run(paused);
  const directory = settings.stateRoot + '/releases/' + manifest.releaseId;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const receipt = {
    version: 1,
    releaseId: manifest.releaseId,
    manifestDigest: digest(manifest),
    bindingDigest: digest(binding),
    status: 'healthy',
    pending: null,
    completed: ['source', 'artifacts', 'quiesce', 'backup', 'migrate', 'activate', 'health'],
  };
  writeAtomic(directory, 'deployment.json', receipt);
  f.retained.mockResolvedValue(manifest);
  f.inspect.mockResolvedValue([]);
  f.capture.mockResolvedValue({ status: 'queued' });
  f.verifyCapture.mockResolvedValue({ status: 'queued' });
  const effects = createCheckpointMaintenanceEffects(settings, '/fixture/target-helper.js', requestId);
  return { settings, native, manifest, binding, requestId, effects, directory, receipt };
}
it.each([0, 1])('scheduled service guards preserve native pause=%s, messages and used allowance', async (paused) => {
  const s = fixture(paused),
    before = s.native.serialize();
  await s.effects.verify();
  await s.effects.stopNative();
  s.native.prepare('UPDATE cos_identity_boundaries SET paused=1').run();
  const later = s.native.serialize();
  await s.effects.startNative();
  expect(s.native.serialize().equals(later)).toBe(true);
  expect(s.native.prepare('SELECT used FROM cos_model_budgets').get()).toEqual({ used: 3 });
  expect(s.native.prepare('SELECT body FROM messages').all()).toEqual([{ body: 'ordinary-message' }]);
  expect(f.service.mock.calls).toEqual([['stop'], ['start']]);
  expect(before.length).toBe(later.length);
});
it('existing owner maintenance continues to refuse an unpaused native boundary', async () => {
  const s = fixture();
  await expect(createOperationsMaintenanceEffects(s.settings, '/fixture/target-helper.js').verify()).rejects.toThrow(
    'operations_maintenance_unverified',
  );
  expect(f.service).not.toHaveBeenCalled();
});
it.each(['failed', 'phase-order', 'foreign-binding', 'older-release'] as const)(
  'scheduled ports reject %s provenance before capture or service effects',
  async (reason) => {
    const s = fixture();
    const receipt = { ...s.receipt };
    if (reason === 'failed') receipt.status = 'failed';
    if (reason === 'phase-order')
      receipt.completed = ['health', 'source', 'artifacts', 'quiesce', 'backup', 'migrate', 'activate'];
    if (reason === 'foreign-binding') receipt.bindingDigest = 'c'.repeat(64);
    if (reason === 'older-release') f.retained.mockResolvedValue(fixtureVaultRelease('G01'));
    writeAtomic(s.directory, 'deployment.json', receipt);
    await expect(s.effects.verify()).rejects.toThrow('checkpoint_maintenance_unverified');
    expect(f.service).not.toHaveBeenCalled();
    expect(f.capture).not.toHaveBeenCalled();
  },
);
it('capture and readback require the current scheduled owner lease and recorded release', async () => {
  const s = fixture();
  await s.effects.verify();
  const lease = beginMaintenance(s.settings.stateRoot, s.binding, 'release-backup-' + s.requestId, 'deployment');
  await confirmQuiescence(s.settings.stateRoot, s.binding, lease, async () => ({
    activeCoordinators: 0,
    activeDatabaseOperations: 0,
  }));
  await s.effects.capture(lease);
  await s.effects.verifyCapture(lease, 'c'.repeat(64));
  expect(f.capture.mock.calls[0].slice(0, 2)).toEqual([s.settings, 'release-backup-' + s.requestId]);
  expect(f.verifyCapture.mock.calls[0][3]).toBe('c'.repeat(64));
  const state = readTarget(s.settings.stateRoot, s.binding);
  writeAtomic(s.settings.stateRoot, 'state.json', { ...state, generation: state.generation + 1 });
  await expect(s.effects.capture(lease)).rejects.toThrow('stale_maintenance_lease');
  expect(f.capture).toHaveBeenCalledOnce();
});
it('changed deployment provenance after asynchronous verification prevents capture', async () => {
  const s = fixture();
  await s.effects.verify();
  const lease = beginMaintenance(s.settings.stateRoot, s.binding, 'release-backup-' + s.requestId, 'deployment');
  await confirmQuiescence(s.settings.stateRoot, s.binding, lease, async () => ({
    activeCoordinators: 0,
    activeDatabaseOperations: 0,
  }));
  f.retained.mockImplementationOnce(async () => {
    writeAtomic(s.directory, 'deployment.json', { ...s.receipt, pending: 'migrate' });
    return s.manifest;
  });
  await expect(s.effects.capture(lease)).rejects.toThrow('checkpoint_maintenance_unverified');
  expect(f.capture).not.toHaveBeenCalled();
});
