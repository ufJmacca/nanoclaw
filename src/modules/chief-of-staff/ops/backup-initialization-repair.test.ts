import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { DeploymentSettings } from './deployment-settings.js';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { digest } from '../domain/contracts.js';
import { initializeTarget, protectTarget, readTarget, writeAtomic } from './target-state.js';
import { payloadDigest } from './payload.js';
import { artifactHash } from './release-artifacts.js';
const ports = vi.hoisted(() => ({
  memory: vi.fn(),
  binding: vi.fn(),
  create: vi.fn(),
  verify: vi.fn(),
  healthy: vi.fn(),
  mount: vi.fn(),
  initialize: vi.fn(),
}));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: ports.memory }));
vi.mock('./target-host.js', () => ({ targetBinding: ports.binding }));
vi.mock('./backup-initialize-job.js', async (original) => ({
  ...(await original<typeof import('./backup-initialize-job.js')>()),
  createBackupInitializationEffects: ports.create,
}));
import {
  verifyBackupInitializationRepair,
  createBackupInitializationRepairEffects,
} from './backup-initialization-repair.js';
const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-init-repair-'));
  roots.push(base);
  const binding = {
      hostFingerprint: 'a'.repeat(64),
      databaseFingerprint: 'b'.repeat(64),
      service: 'fixture.service',
      installationRoot: base + '/app',
      dataRoot: base + '/app/data',
    },
    settings = {
      releaseRoot: base + '/releases',
      stagingRoot: base + '/staging',
      sourceRoot: base + '/sources',
      stateRoot: base + '/state',
    };
  initializeTarget(settings.stateRoot, binding);
  protectTarget(settings.stateRoot, binding);
  const runtime = fixtureVaultRelease('G02'),
    helper = fixtureVaultRelease('G02');
  runtime.releaseId = 'release-runtime';
  helper.releaseId = 'release-repair';
  helper.source = { ...helper.source, commit: '2'.repeat(40), tree: '3'.repeat(40) };
  const repairSeal = {
    ...helper.vaultArtifact!.seal,
    sourceCommit: helper.source.commit,
    sourceTree: helper.source.tree,
  };
  helper.vaultArtifact = { digest: digest(repairSeal), seal: repairSeal };
  for (const check of Object.values(helper.checks)) check.sourceCommit = helper.source.commit;
  helper.previousReleaseIds = [runtime.releaseId];
  const materialize = async (manifest: typeof runtime) => {
    const directory = settings.releaseRoot + '/' + manifest.releaseId,
      payload = directory + '/payload',
      invoked = payload + '/dist/modules/chief-of-staff/ops/target-helper.js';
    fs.mkdirSync(path.dirname(invoked), { recursive: true, mode: 0o700 });
    fs.writeFileSync(invoked, 'immutable-' + manifest.releaseId);
    manifest.hostPayloadDigest = await payloadDigest(payload);
    writeAtomic(directory, 'release.json', manifest);
    return { directory, payload, invoked };
  };
  const current = await materialize(runtime),
    staged = await materialize(helper),
    stage = settings.stagingRoot + '/' + helper.releaseId;
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  writeAtomic(stage, 'release.json', helper);
  writeAtomic(stage, 'source.json', {
    contract: helper.source.syncContract,
    repository: helper.source.repository,
    commit: helper.source.commit,
    tree: helper.source.tree,
    checkout: settings.sourceRoot + '/' + helper.releaseId,
    verifiedAt: '2026-10-12T00:00:00Z',
  });
  const prepared = {
    status: 'prepared',
    releaseId: helper.releaseId,
    payload: staged.payload,
    hostPayloadDigest: helper.hostPayloadDigest,
    manifestHash: await artifactHash(stage + '/release.json'),
    archiveHash: 'f'.repeat(64),
  };
  writeAtomic(stage, 'prepared.json', prepared);
  const receiptRoot = settings.stateRoot + '/releases/' + runtime.releaseId;
  fs.mkdirSync(receiptRoot, { recursive: true, mode: 0o700 });
  const record = {
    version: 1,
    releaseId: runtime.releaseId,
    manifestDigest: digest(runtime),
    bindingDigest: digest(binding),
    status: 'healthy',
    pending: null,
    completed: ['source', 'artifacts', 'quiesce', 'backup', 'migrate', 'activate', 'health'],
  };
  writeAtomic(receiptRoot, 'deployment.json', record);
  writeAtomic(settings.stateRoot, 'state.json', {
    ...readTarget(settings.stateRoot, binding),
    releaseId: runtime.releaseId,
    maintenance: false,
  });
  // A real pending checkpoint must not become repair or new deployment authority.
  writeAtomic(settings.stateRoot, 'pending-checkpoint.json', { operationId: 'retained', bytes: 2121728 });
  return { settings, binding, runtime, helper, current, staged, stage, prepared, receiptRoot, record };
}
it('verifies the separately tested staged helper and healthy runtime without activating code or changing a pending checkpoint', async () => {
  const f = await fixture(),
    before = fs.readFileSync(f.settings.stateRoot + '/state.json'),
    pending = fs.readFileSync(f.settings.stateRoot + '/pending-checkpoint.json');
  const result = await verifyBackupInitializationRepair(f.settings, f.binding, f.staged.invoked);
  expect(result).toEqual({ runtime: f.runtime, helper: f.helper });
  expect(fs.readFileSync(f.settings.stateRoot + '/state.json')).toEqual(before);
  expect(fs.readFileSync(f.settings.stateRoot + '/pending-checkpoint.json')).toEqual(pending);
  expect(fs.existsSync(f.settings.stateRoot + '/releases/' + f.helper.releaseId + '/deployment.json')).toBe(false);
});
it.each([
  'missing-preparation',
  'wrong-preparation-hash',
  'wrong-source',
  'unhealthy-runtime',
  'runtime-payload-change',
  'repair-payload-change',
  'missing-final-check',
  'maintenance',
  'unprotected',
  'wrong-runtime',
  'not-a-predecessor',
  'helper-path',
])('refuses %s before repository initialization is available', async (reason) => {
  const f = await fixture();
  let invoked = f.staged.invoked;
  if (reason === 'missing-preparation') fs.unlinkSync(f.stage + '/prepared.json');
  if (reason === 'wrong-preparation-hash')
    writeAtomic(f.stage, 'prepared.json', { ...f.prepared, manifestHash: '9'.repeat(64) });
  if (reason === 'wrong-source') writeAtomic(f.stage, 'source.json', { commit: '9'.repeat(40) });
  if (reason === 'unhealthy-runtime') writeAtomic(f.receiptRoot, 'deployment.json', { ...f.record, status: 'failed' });
  if (reason === 'runtime-payload-change') fs.appendFileSync(f.current.invoked, 'changed');
  if (reason === 'repair-payload-change') fs.appendFileSync(f.staged.invoked, 'changed');
  if (reason === 'missing-final-check') {
    delete f.helper.checks.backup_transfer;
    writeAtomic(f.staged.directory, 'release.json', f.helper);
  }
  if (reason === 'maintenance' || reason === 'wrong-runtime') {
    const state = readTarget(f.settings.stateRoot, f.binding);
    writeAtomic(f.settings.stateRoot, 'state.json', {
      ...state,
      ...(reason === 'maintenance'
        ? { maintenance: true, maintenanceId: '01234567-89ab-4def-8123-456789abcdef' }
        : { releaseId: 'release-foreign' }),
    });
  }
  if (reason === 'unprotected') {
    fs.unlinkSync(f.settings.stateRoot + '/protected.json');
    const state = JSON.parse(fs.readFileSync(f.settings.stateRoot + '/state.json', 'utf8'));
    writeAtomic(f.settings.stateRoot, 'state.json', { ...state, lifecycle: 'implementation_disposable' });
  }
  if (reason === 'not-a-predecessor') {
    f.helper.previousReleaseIds = ['release-unrelated'];
    writeAtomic(f.staged.directory, 'release.json', f.helper);
    writeAtomic(f.stage, 'release.json', f.helper);
    writeAtomic(f.stage, 'prepared.json', {
      ...f.prepared,
      manifestHash: await artifactHash(f.stage + '/release.json'),
    });
  }
  if (reason === 'helper-path') invoked = f.staged.invoked.replace('target-helper.js', 'owner-helper.js');
  await expect(verifyBackupInitializationRepair(f.settings, f.binding, invoked)).rejects.toThrow(
    'backup_initialization_repair_unverified',
  );
});

it('production repair uses only installed runtime ports with the current memory guard and preserves stable operation and admission checks', async () => {
  const f = await fixture(),
    settings = f.settings as DeploymentSettings;
  ports.binding.mockReturnValue(f.binding);
  ports.verify.mockResolvedValue(f.runtime);
  ports.healthy.mockResolvedValue(true);
  ports.create.mockReturnValue({
    verify: ports.verify,
    healthy: ports.healthy,
    mount: ports.mount,
    initialize: ports.initialize,
  });
  const effects = createBackupInitializationRepairEffects(settings, f.staged.invoked),
    guard = vi.fn(),
    check = vi.fn(),
    id = '01234567-89ab-4def-8123-456789abcdef';
  expect(await effects.verifyRepair()).toEqual({ runtime: f.runtime, helper: f.helper });
  expect(ports.create).toHaveBeenCalledWith(settings, f.current.invoked);
  expect(ports.memory).toHaveBeenCalledTimes(2);
  await effects.healthy();
  await effects.mount(guard);
  await effects.initialize(f.runtime, id, guard, check);
  expect(ports.mount).toHaveBeenCalledWith(guard);
  expect(ports.initialize).toHaveBeenCalledWith(f.runtime, id, guard, check);
});
it('production memory failure and installed manifest mismatch refuse repair before initialization', async () => {
  const f = await fixture(),
    settings = f.settings as DeploymentSettings;
  ports.binding.mockReturnValue(f.binding);
  ports.create.mockReturnValue({
    verify: ports.verify,
    healthy: ports.healthy,
    mount: ports.mount,
    initialize: ports.initialize,
  });
  ports.memory.mockImplementationOnce(() => {
    throw Error('unprotected');
  });
  const effects = createBackupInitializationRepairEffects(settings, f.staged.invoked);
  await expect(effects.verifyRepair()).rejects.toThrow('unprotected');
  expect(ports.create).not.toHaveBeenCalled();
  ports.verify.mockResolvedValue({ ...f.runtime, releaseId: 'release-foreign' });
  await expect(effects.verifyRepair()).rejects.toThrow('repair_runtime_changed');
  expect(ports.initialize).not.toHaveBeenCalled();
});
