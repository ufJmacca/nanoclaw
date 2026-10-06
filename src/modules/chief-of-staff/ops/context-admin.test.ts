import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../../config.js', async () => ({
  ...(await vi.importActual('../../../config.js')),
  DATA_DIR: '/tmp/nanoclaw-context-admin/data',
  GROUPS_DIR: '/tmp/nanoclaw-context-admin/groups',
}));
vi.mock('../host-store.js', () => ({ connectCosHostStore: vi.fn() }));
vi.mock('./calendar-admin.js', async () => ({
  ...(await vi.importActual('./calendar-admin.js')),
  runCalendarAdmin: vi.fn(),
}));
import { runCalendarAdmin } from './calendar-admin.js';
vi.mock('./calendar-account-admin.js', async () => ({
  ...(await vi.importActual('./calendar-account-admin.js')),
  runCalendarAccountAdmin: vi.fn(),
}));
import { runCalendarAccountAdmin } from './calendar-account-admin.js';
vi.mock('./action-account-admin.js', async () => ({
  ...(await vi.importActual('./action-account-admin.js')),
  runActionAccountAdmin: vi.fn(),
}));
import { runActionAccountAdmin } from './action-account-admin.js';
vi.mock('./action-admin.js', async () => ({
  ...(await vi.importActual('./action-admin.js')),
  runActionAdmin: vi.fn(),
}));
import { runActionAdmin } from './action-admin.js';
vi.mock('./action-recovery-admin.js', async () => ({
  ...(await vi.importActual('./action-recovery-admin.js')),
  runActionRecoveryAdmin: vi.fn(),
}));
import { runActionRecoveryAdmin } from './action-recovery-admin.js';
vi.mock('./mission-admin.js', async () => ({
  ...(await vi.importActual('./mission-admin.js')),
  runMissionAdmin: vi.fn(),
}));
import { runMissionAdmin } from './mission-admin.js';
import { connectCosHostStore } from '../host-store.js';
import type { PriorityStore } from '../store/priorities.js';
import { initDb, closeDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { subscribeMattermostChannelStrict } from '../../../channels/mattermost-subscription.js';
import { resolveSession, openInboundDb, openOutboundDb } from '../../../session-manager.js';
import { bindCoordinator } from './bind.js';
import { initializeTarget, writeAtomic, readTarget } from './target-state.js';
import { beginMaintenance, confirmQuiescence } from './maintenance.js';
import { contextAdminCommand } from './context-admin.js';
import { reserveSubscriptionAttempt, type SubscriptionActivation } from '../bridge/model-policy.js';
const root = '/tmp/nanoclaw-context-admin',
  state = root + '/state',
  central = root + '/data/v2.db';
const targetBinding = {
  hostFingerprint: 'a'.repeat(64),
  databaseFingerprint: 'b'.repeat(64),
  service: 'fixture.service',
  installationRoot: root,
  dataRoot: root + '/data',
};
const facts = vi.fn(async () => ({
  id: 'private',
  type: 'P',
  delete_at: 0,
  members: ['bot', 'owner'],
  activeSubscription: true,
}));
const quiescent = vi.fn(async () => true);
const dependencies = { target: () => readTarget(state, targetBinding), quiescent, facts };
const env = { COS_ENABLED: 'true', COS_TARGET_STATE_DIR: state };
beforeEach(async () => {
  fs.mkdirSync(root, { mode: 0o700 });
  fs.mkdirSync(root + '/data', { mode: 0o700 });
  runMigrations(initDb(central));
  const group = subscribeMattermostChannelStrict({ instanceKey: 'fixture', channelId: 'private' });
  resolveSession(group.agentGroup.id, group.messagingGroup.id, null, 'shared');
  await bindCoordinator(
    {
      scopeId: 'fixture',
      instanceId: 'fixture',
      channelId: 'private',
      ownerId: 'owner',
      botId: 'bot',
      provider: 'codex',
    },
    { facts, bindScope: async () => ({ status: 'ok' }) },
  );
  closeDb();
  initializeTarget(state, targetBinding);
  const lease = beginMaintenance(state, targetBinding, 'fixture-operation', 'deployment');
  await confirmQuiescence(state, targetBinding, lease, async () => ({
    activeCoordinators: 0,
    activeDatabaseOperations: 0,
  }));
  fs.mkdirSync(state + '/codex-auth', { mode: 0o700 });
  writeAtomic(state + '/codex-auth', 'account-binding.json', {
    accountHash: 'c'.repeat(64),
    sourcePathHash: createHash('sha256')
      .update(path.join(os.homedir(), '.codex', 'auth.json'))
      .digest('hex'),
  });
  facts.mockClear();
  quiescent.mockClear();
});
it('S11-T02/T09 trusted owner-local pause works with service active and Mattermost/database/model unavailable, preserving ordinary state', async () => {
  const db = initDb(central);
  db.exec(
    "CREATE TABLE ordinary_canary(id TEXT,body TEXT);INSERT INTO ordinary_canary VALUES('message','protected ordinary content');UPDATE cos_identity_boundaries SET paused=0",
  );
  const binding = JSON.parse(
    (db.prepare('SELECT binding FROM cos_identity_boundaries WHERE scope_id=?').get('fixture') as { binding: string })
      .binding,
  );
  closeDb();
  facts.mockRejectedValue(Error('Mattermost unavailable'));
  quiescent.mockResolvedValue(false);
  const stop = vi.fn();
  const request = {
    command: 'operator-control' as const,
    scopeId: 'fixture',
    requestId: '11111111-1111-4111-8111-111111111111',
    text: 'cos pause admission',
  };
  expect(await contextAdminCommand(request, { ...env, COS_ENABLED: 'false' }, { ...dependencies, stop })).toMatchObject(
    { status: 'ok', state: 'admission_paused', effects: 'requires_reconciliation', live_model: 'not_invoked' },
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(await contextAdminCommand(request, { ...env, COS_ENABLED: 'false' }, { ...dependencies, stop })).toMatchObject(
    { status: 'ok', state: 'admission_paused' },
  );
  expect(stop).toHaveBeenCalledWith(
    expect.objectContaining({ id: binding.sessionId, agent_group_id: binding.agentGroupId }),
  );
  expect(facts).not.toHaveBeenCalled();
  expect(quiescent).not.toHaveBeenCalled();
  expect(connectCosHostStore).not.toHaveBeenCalled();
  const native = new Database(central, { readonly: true });
  try {
    expect(native.prepare('SELECT count(*) AS n FROM cos_operator_denials').get()).toEqual({ n: 1 });
    expect(native.prepare('SELECT * FROM ordinary_canary').all()).toEqual([
      { id: 'message', body: 'protected ordinary content' },
    ]);
    expect(native.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
  } finally {
    native.close();
  }
});
afterEach(() => {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  quiescent.mockResolvedValue(true);
  facts.mockResolvedValue({
    id: 'private',
    type: 'P',
    delete_at: 0,
    members: ['bot', 'owner'],
    activeSubscription: true,
  });
});
it('reports local state without model, channel, database-network calls or creating context; explicit prepare remains paused', async () => {
  const result = await contextAdminCommand({ command: 'context-status', scopeId: 'fixture' }, env, dependencies);
  expect(result).toMatchObject({
    context: 'not_initialized',
    live_model: 'not_verified',
    activation: 'not_configured',
  });
  expect(facts).not.toHaveBeenCalled();
  expect(quiescent).not.toHaveBeenCalled();
  expect(fs.existsSync(state + '/conversations')).toBe(false);
  const prepared = await contextAdminCommand({ command: 'context-prepare', scopeId: 'fixture' }, env, dependencies);
  expect(prepared).toMatchObject({ status: 'prepared_paused', accountFingerprint: 'c'.repeat(64) });
  const status = await contextAdminCommand({ command: 'context-status', scopeId: 'fixture' }, env, dependencies);
  expect(status).toMatchObject({
    context: 'active',
    paused: true,
    activation: 'not_configured',
    live_model: 'not_verified',
  });
});
it('performs guarded recovery with protected native backups and leaves activation absent', async () => {
  const prepared = await contextAdminCommand({ command: 'context-prepare', scopeId: 'fixture' }, env, dependencies);
  const old = path.join(state, 'conversations', String(prepared.generation));
  fs.writeFileSync(old + '/history', 'retained');
  const recoveryId = randomUUID();
  const result = await contextAdminCommand(
    { command: 'context-recover', scopeId: 'fixture', expectedGeneration: String(prepared.generation), recoveryId },
    env,
    dependencies,
  );
  expect(result).toMatchObject({ status: 'recovered_paused' });
  expect(result.generation).not.toBe(prepared.generation);
  expect(fs.readFileSync(old + '/history', 'utf8')).toBe('retained');
  expect(fs.existsSync(state + '/model-activation.json')).toBe(false);
  const backup = state + '/context-recovery-backups/' + recoveryId;
  expect(fs.existsSync(backup + '/native.sqlite')).toBe(true);
  expect(fs.readFileSync(backup + '/conversation-backup/history/' + prepared.generation + '/history', 'utf8')).toBe(
    'retained',
  );
  expect(fs.existsSync(backup + '/inbound/native.sqlite')).toBe(true);
  expect(fs.existsSync(backup + '/outbound/native.sqlite')).toBe(true);
});
it('recovery preserves a valid remaining allowance through the actual owner command without resuming', async () => {
  const prepared = await contextAdminCommand({ command: 'context-prepare', scopeId: 'fixture' }, env, dependencies);
  const policy: SubscriptionActivation = {
    version: 2,
    runtime: 'codex-subscription/v1',
    activationId: 'f'.repeat(32),
    scopeId: 'fixture',
    provider: 'codex',
    model: 'fixture-model',
    consentRef: 'fixture-only-authority',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    maxAttempts: 2,
    accountFingerprint: 'c'.repeat(64),
    contextGeneration: String(prepared.generation),
  };
  writeAtomic(state, 'fixture-consent.json', policy);
  await contextAdminCommand(
    { command: 'model-activate', scopeId: 'fixture', policyFile: state + '/fixture-consent.json' },
    env,
    dependencies,
  );
  const db = new Database(central);
  expect(reserveSubscriptionAttempt(db, policy, 'fixture-ingress', randomUUID())).toBe(true);
  db.close();
  const result = await contextAdminCommand(
    {
      command: 'context-recover',
      scopeId: 'fixture',
      expectedGeneration: policy.contextGeneration,
      recoveryId: randomUUID(),
    },
    env,
    dependencies,
  );
  expect(result).toMatchObject({
    status: 'recovered_paused',
    activation: { status: 'rebound_paused', remainingAttempts: 1, expiresAt: policy.expiresAt },
  });
  expect(await contextAdminCommand({ command: 'context-status', scopeId: 'fixture' }, env, dependencies)).toMatchObject(
    { paused: true, generation: result.generation, activation: 'configured', remainingAttempts: 1 },
  );
});
it('refuses preparation when service/containers are active, a foreign host owns the lease or channel membership changed', async () => {
  quiescent.mockResolvedValueOnce(false);
  await expect(
    contextAdminCommand({ command: 'context-prepare', scopeId: 'fixture' }, env, dependencies),
  ).rejects.toThrow('target_not_quiescent');
  expect(fs.existsSync(state + '/conversations')).toBe(false);
  const db = new Database(central);
  db.prepare('INSERT INTO host_execution_lease VALUES(1,?,?,?)').run('foreign', 1, 'fixture');
  db.close();
  await expect(
    contextAdminCommand({ command: 'context-prepare', scopeId: 'fixture' }, env, dependencies),
  ).rejects.toThrow('live process');
  const again = new Database(central);
  again.exec('DELETE FROM host_execution_lease');
  again.close();
  facts.mockResolvedValueOnce({
    id: 'private',
    type: 'P',
    delete_at: 0,
    members: ['bot', 'owner', 'other'],
    activeSubscription: true,
  });
  await expect(
    contextAdminCommand({ command: 'context-prepare', scopeId: 'fixture' }, env, dependencies),
  ).rejects.toThrow('private_owner_membership_required');
  expect(fs.existsSync(state + '/conversations')).toBe(false);
});
it('distinguishes configured consent, exhausted attempts, stale consent and unavailable history without claiming live readiness', async () => {
  const prepared = await contextAdminCommand({ command: 'context-prepare', scopeId: 'fixture' }, env, dependencies);
  const policy: SubscriptionActivation = {
    version: 2,
    runtime: 'codex-subscription/v1',
    activationId: 'a'.repeat(32),
    scopeId: 'fixture',
    provider: 'codex',
    model: 'fixture-model',
    consentRef: 'fixture-consent',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    maxAttempts: 1,
    accountFingerprint: 'c'.repeat(64),
    contextGeneration: String(prepared.generation),
  };
  writeAtomic(state, 'model-activation.json', policy);
  const status = () => contextAdminCommand({ command: 'context-status', scopeId: 'fixture' }, env, dependencies);
  expect(await status()).toMatchObject({
    activation: 'configured',
    remainingAttempts: 1,
    paused: true,
    live_model: 'not_verified',
  });
  const db = new Database(central);
  expect(reserveSubscriptionAttempt(db, policy, 'synthetic-ingress', randomUUID())).toBe(true);
  db.close();
  expect(await status()).toMatchObject({ activation: 'exhausted', remainingAttempts: 0 });
  writeAtomic(state, 'model-activation.json', { ...policy, contextGeneration: randomUUID() });
  expect(await status()).toMatchObject({ activation: 'invalid_or_expired' });
  fs.rmdirSync(path.join(state, 'conversations', String(prepared.generation)));
  expect(await status()).toMatchObject({ context: 'recovery_required' });
  expect(fs.existsSync(path.join(state, 'conversations', String(prepared.generation)))).toBe(false);
});
it('issues consent through the real host command and requires a separate resume; replay preserves a later pause', async () => {
  const prepared = await contextAdminCommand({ command: 'context-prepare', scopeId: 'fixture' }, env, dependencies);
  const policy: SubscriptionActivation = {
    version: 2,
    runtime: 'codex-subscription/v1',
    activationId: 'e'.repeat(32),
    scopeId: 'fixture',
    provider: 'codex',
    model: 'fixture-model',
    consentRef: 'fixture-only-authority',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    maxAttempts: 2,
    accountFingerprint: 'c'.repeat(64),
    contextGeneration: String(prepared.generation),
  };
  writeAtomic(state, 'fixture-consent.json', policy);
  const activated = await contextAdminCommand(
    { command: 'model-activate', scopeId: 'fixture', policyFile: state + '/fixture-consent.json' },
    env,
    dependencies,
  );
  expect(activated).toMatchObject({ status: 'activation_configured_paused', remainingAttempts: 2 });
  expect(await contextAdminCommand({ command: 'context-status', scopeId: 'fixture' }, env, dependencies)).toMatchObject(
    { paused: true, activation: 'configured', live_model: 'not_verified' },
  );
  const request = {
    command: 'context-resume' as const,
    scopeId: 'fixture',
    activationId: policy.activationId,
    resumeId: randomUUID(),
  };
  const native = initDb(central);
  const binding = JSON.parse(
    (native.prepare('SELECT binding FROM cos_identity_boundaries').get() as { binding: string }).binding,
  );
  const output = openOutboundDb(binding.agentGroupId, binding.sessionId, { readonly: false });
  output.exec("INSERT INTO messages_out(id,kind,timestamp,content) VALUES('cancelled','chat','fixture','old answer')");
  output.close();
  closeDb();
  expect(await contextAdminCommand(request, env, dependencies)).toMatchObject({ status: 'resumed', paused: false });
  initDb(central);
  const input = openInboundDb(binding.agentGroupId, binding.sessionId);
  expect(input.prepare("SELECT status FROM delivered WHERE message_out_id='cancelled'").get()).toEqual({
    status: 'quarantined_pause',
  });
  input.close();
  closeDb();
  const db = new Database(central);
  db.exec('UPDATE cos_identity_boundaries SET paused=1');
  db.close();
  expect(await contextAdminCommand(request, env, dependencies)).toMatchObject({
    status: 'resume_replayed',
    paused: true,
  });
  expect(readTarget(state, targetBinding).maintenance).toBe(true);
});

it('owner source commands derive scope and identity from the paused binding without needing model credentials', async () => {
  fs.rmSync(state + '/codex-auth', { recursive: true });
  const knowledge = {
    importSource: vi.fn(async () => ({ status: 'ok', source_id: 'fixture-source' })),
    inventory: vi.fn(async () => ({ status: 'ok', items: [], next_after: null })),
    reconcileArtifacts: vi.fn(async () => ({ status: 'ok', removed: 0 })),
  };
  const end = vi.fn(async () => {});
  vi.mocked(connectCosHostStore).mockResolvedValue({
    knowledge,
    database: { pool: { end } },
  } as unknown as PriorityStore);
  const requestId = randomUUID();
  const manifest = {
    sourceKey: 'fixture-note',
    filename: 'note.md',
    title: 'Note',
    processingProviders: ['codex'],
    expectedVersion: 0,
  };
  writeAtomic(state, 'import.json', manifest);
  const result = await contextAdminCommand(
    { command: 'source-import', scopeId: 'fixture', requestId, manifestFile: state + '/import.json' },
    env,
    dependencies,
  );
  expect(result).toMatchObject({ status: 'ok', paused: true, live_model: 'not_invoked' });
  expect(knowledge.importSource).toHaveBeenCalledWith(
    expect.objectContaining({ scopeId: 'fixture', ownerId: 'owner', ingressId: 'owner-import-' + requestId }),
    requestId,
    manifest,
  );
  expect(end).toHaveBeenCalledOnce();
  const [, roots, admitted] = vi.mocked(connectCosHostStore).mock.calls.at(-1)!;
  expect(roots).toEqual({ targetRoot: state, installationRoot: root, dataRoot: root + '/data' });
  // The admission callback cannot outlive its host execution lease.
  expect(() => admitted()).toThrow();
  const listed = await contextAdminCommand(
    { command: 'source-inventory', scopeId: 'fixture', page: { limit: 2, status: 'failed' } },
    env,
    dependencies,
  );
  expect(listed).toMatchObject({ status: 'ok', items: [], next_after: null });
  expect(knowledge.inventory).toHaveBeenLastCalledWith(
    expect.objectContaining({ scopeId: 'fixture', ownerId: 'owner' }),
    { limit: 2, status: 'failed' },
  );
  await contextAdminCommand({ command: 'source-reconcile', scopeId: 'fixture' }, env, dependencies);
  expect(knowledge.reconcileArtifacts).toHaveBeenCalledWith();
  expect(fs.existsSync(state + '/conversations')).toBe(false);
  expect(fs.existsSync(state + '/model-activation.json')).toBe(false);
});
it('calendar commands use native owner and maintenance authority without a model login or allowance', async () => {
  fs.rmSync(state + '/codex-auth', { recursive: true });
  const args = { command: 'calendar-status' as const, scopeId: 'fixture', offset: 0 };
  const run = vi.mocked(runCalendarAdmin);
  run.mockClear();
  run.mockImplementation(async (options) => {
    expect(options.binding).toMatchObject({ scopeId: 'fixture', ownerId: 'owner', provider: 'codex' });
    expect(options.roots).toEqual({ targetRoot: state, installationRoot: root, dataRoot: root + '/data' });
    await options.check();
    return { status: 'ok', paused: true, live_model: 'not_invoked' };
  });
  expect(await contextAdminCommand(args, env, dependencies)).toMatchObject({ status: 'ok', paused: true });
  const { assertAuthority } = run.mock.calls[0][0];
  expect(() => assertAuthority()).toThrow();
  expect(fs.existsSync(state + '/conversations')).toBe(false);
  expect(fs.existsSync(state + '/model-activation.json')).toBe(false);
  run.mockClear();
  quiescent.mockResolvedValueOnce(false);
  await expect(contextAdminCommand(args, env, dependencies)).rejects.toThrow('target_not_quiescent');
  facts.mockResolvedValueOnce({
    id: 'private',
    type: 'P',
    delete_at: 0,
    members: ['owner', 'bot', 'outsider'],
    activeSubscription: true,
  });
  await expect(contextAdminCommand(args, env, dependencies)).rejects.toThrow('private_owner_membership_required');
  expect(run).not.toHaveBeenCalled();
});
it.each(['mission-configure', 'team-configure'] as const)(
  '%s requires private owner, pause and maintenance authority without consuming model access',
  async (command) => {
    fs.rmSync(state + '/codex-auth', { recursive: true });
    const args = {
      command,
      scopeId: 'fixture',
      requestId: randomUUID(),
      manifestFile: state + '/mission.json',
    };
    const run = vi.mocked(runMissionAdmin);
    run.mockClear();
    run.mockImplementation(async (options) => {
      await options.check();
      expect(options.binding).toMatchObject({ scopeId: 'fixture', ownerId: 'owner', provider: 'codex' });
      expect(options.databaseFingerprint).toBe(targetBinding.databaseFingerprint);
      expect(options.root).toBe(state);
      return { status: 'configured_paused' };
    });
    expect(await contextAdminCommand(args, env, dependencies)).toEqual({ status: 'configured_paused' });
    expect(() => run.mock.calls[0][0].assertAuthority()).toThrow();
    expect(fs.existsSync(state + '/model-activation.json')).toBe(false);
    expect(fs.existsSync(state + '/conversations')).toBe(false);
    run.mockClear();
    quiescent.mockResolvedValueOnce(false);
    await expect(contextAdminCommand(args, env, dependencies)).rejects.toThrow('target_not_quiescent');
    facts.mockResolvedValueOnce({
      id: 'private',
      type: 'P',
      delete_at: 0,
      members: ['owner', 'bot', 'outsider'],
      activeSubscription: true,
    });
    await expect(contextAdminCommand(args, env, dependencies)).rejects.toThrow('private_owner_membership_required');
    expect(run).not.toHaveBeenCalled();
  },
);
it('account linking uses the same paused native authority and cannot run after its lease is released', async () => {
  fs.rmSync(state + '/codex-auth', { recursive: true });
  const run = vi.mocked(runCalendarAccountAdmin);
  run.mockImplementation(async (options) => {
    await options.check();
    expect(options.binding).toMatchObject({ scopeId: 'fixture', ownerId: 'owner', provider: 'codex' });
    return { status: 'ok', paused: true, live_model: 'not_invoked' };
  });
  const args = {
    command: 'calendar-link' as const,
    scopeId: 'fixture',
    bindingId: randomUUID(),
    requestId: randomUUID(),
    manifestFile: state + '/selection.json',
  };
  expect(await contextAdminCommand(args, env, dependencies)).toMatchObject({ status: 'ok', paused: true });
  expect(() => run.mock.calls.at(-1)![0].assertAuthority()).toThrow();
  expect(fs.existsSync(state + '/model-activation.json')).toBe(false);
});
it.each(['action-setup', 'action-link', 'action-configure', 'action-disable'] as const)(
  'S09 %s requires paused private native authority and cannot use a released lease',
  async (command) => {
    fs.rmSync(state + '/codex-auth', { recursive: true });
    const args = {
      command,
      scopeId: 'fixture',
      requestId: randomUUID(),
      bindingId: randomUUID(),
      manifestFile: state + '/action.json',
      backupRoot: state + '/backup',
    };
    const assertOptions = async (
      options: Parameters<typeof runActionAccountAdmin>[0] | Parameters<typeof runActionAdmin>[0],
    ) => {
      await options.check();
      options.assertAuthority();
      expect(options.binding).toMatchObject({ scopeId: 'fixture', ownerId: 'owner', provider: 'codex' });
      return { status: 'configured_paused', live_model: 'not_invoked' };
    };
    vi.mocked(runActionAccountAdmin).mockImplementation(assertOptions);
    vi.mocked(runActionAdmin).mockImplementation(assertOptions);
    expect(await contextAdminCommand(args, env, dependencies)).toMatchObject({ status: 'configured_paused' });
    const options =
      command === 'action-setup' || command === 'action-link'
        ? vi.mocked(runActionAccountAdmin).mock.calls.at(-1)![0]
        : vi.mocked(runActionAdmin).mock.calls.at(-1)![0];
    expect(() => options.assertAuthority()).toThrow();
    expect(fs.existsSync(state + '/model-activation.json')).toBe(false);
    expect(fs.existsSync(state + '/conversations')).toBe(false);
    quiescent.mockResolvedValueOnce(false);
    await expect(contextAdminCommand(args, env, dependencies)).rejects.toThrow('target_not_quiescent');
    facts.mockResolvedValueOnce({
      id: 'private',
      type: 'P',
      delete_at: 0,
      members: ['owner', 'bot', 'outsider'],
      activeSubscription: true,
    });
    await expect(contextAdminCommand(args, env, dependencies)).rejects.toThrow('private_owner_membership_required');
  },
);
it.each(['action-backup', 'action-restore-check'] as const)(
  'S09 %s retains the paused private owner and exact native lease controls',
  async (command) => {
    fs.rmSync(state + '/codex-auth', { recursive: true });
    const args = {
      command,
      scopeId: 'fixture',
      requestId: randomUUID(),
      settingsFile: state + '/settings.json',
      backupOperationId: 'release-fixture-actions',
    };
    const run = vi.mocked(runActionRecoveryAdmin);
    run.mockClear();
    run.mockImplementation(async (options) => {
      await options.check();
      options.assertAuthority();
      expect(options.binding).toMatchObject({ scopeId: 'fixture', ownerId: 'owner', provider: 'codex' });
      expect(options.native.name).toBe(central);
      expect(options.hostLease.pid).toBe(process.pid);
      return { status: 'verified_paused', writer_enabled: false, live_model: 'not_invoked' };
    });
    expect(await contextAdminCommand(args, env, dependencies)).toMatchObject({ status: 'verified_paused' });
    expect(() => run.mock.calls.at(-1)![0].assertAuthority()).toThrow();
    expect(fs.existsSync(state + '/model-activation.json')).toBe(false);
    expect(fs.existsSync(state + '/conversations')).toBe(false);
    run.mockClear();
    quiescent.mockResolvedValueOnce(false);
    await expect(contextAdminCommand(args, env, dependencies)).rejects.toThrow('target_not_quiescent');
    facts.mockResolvedValueOnce({
      id: 'private',
      type: 'P',
      delete_at: 0,
      members: ['bot', 'owner', 'outsider'],
      activeSubscription: true,
    });
    await expect(contextAdminCommand(args, env, dependencies)).rejects.toThrow('private_owner_membership_required');
    expect(run).not.toHaveBeenCalled();
  },
);
it('source setup requires quiescence and private owner membership, and closes the pool on import failure', async () => {
  const connect = vi.mocked(connectCosHostStore);
  connect.mockClear();
  quiescent.mockResolvedValue(false);
  const args = { command: 'source-inventory', scopeId: 'fixture', page: {} } as const;
  await expect(contextAdminCommand(args, env, dependencies)).rejects.toThrow('target_not_quiescent');
  expect(connect).not.toHaveBeenCalled();
  quiescent.mockResolvedValue(true);
  facts.mockResolvedValue({
    id: 'private',
    type: 'P',
    delete_at: 0,
    members: ['bot', 'owner', 'outsider'],
    activeSubscription: true,
  });
  await expect(contextAdminCommand(args, env, dependencies)).rejects.toThrow('private_owner_membership_required');
  expect(connect).not.toHaveBeenCalled();
  facts.mockResolvedValue({
    id: 'private',
    type: 'P',
    delete_at: 0,
    members: ['bot', 'owner'],
    activeSubscription: true,
  });
  const end = vi.fn(async () => {});
  connect.mockResolvedValue({
    knowledge: {
      importSource: vi.fn(async () => {
        throw new Error('unsupported_source');
      }),
    },
    database: { pool: { end } },
  } as unknown as PriorityStore);
  writeAtomic(state, 'import.json', {
    sourceKey: 'fixture',
    filename: 'binary.txt',
    title: 'Fixture',
    processingProviders: ['codex'],
    expectedVersion: 0,
  });
  await expect(
    contextAdminCommand(
      { command: 'source-import', scopeId: 'fixture', requestId: randomUUID(), manifestFile: state + '/import.json' },
      env,
      dependencies,
    ),
  ).rejects.toThrow('unsupported_source');
  expect(end).toHaveBeenCalledOnce();
});
it('the owner purge command supplies native ownership and cache cleanup only after guarded recovery', async () => {
  const old = await contextAdminCommand({ command: 'context-prepare', scopeId: 'fixture' }, env, dependencies);
  const generation = String(old.generation),
    directory = state + '/conversations/' + generation;
  fs.writeFileSync(directory + '/history.jsonl', 'DELETE_CANARY', { mode: 0o600 });
  await contextAdminCommand(
    { command: 'context-recover', scopeId: 'fixture', expectedGeneration: generation, recoveryId: randomUUID() },
    env,
    dependencies,
  );
  const native = new Database(central, { readonly: true });
  const binding = JSON.parse(
    (native.prepare('SELECT binding FROM cos_identity_boundaries').get() as { binding: string }).binding,
  );
  native.close();
  const end = vi.fn(async () => {}),
    purgeDue = vi.fn(async () => ({ status: 'ok' }));
  vi.mocked(connectCosHostStore).mockImplementation(
    async (_env, _roots, _admitted, retention) =>
      ({
        database: { pool: { end } },
        knowledge: {
          inventory: async () => ({ status: 'ok', items: [] }),
          purgeDue: async (scope: string) => {
            expect(scope).toBe('fixture');
            expect(retention?.purgeContexts).toBeTypeOf('function');
            const result = await retention!.purgeContexts!({
              scopeId: scope,
              sourceId: 'fixture-source',
              contexts: [{ sessionId: binding.sessionId, generation }],
            });
            await purgeDue();
            return result;
          },
        },
      }) as unknown as PriorityStore,
  );
  const result = await contextAdminCommand({ command: 'source-purge', scopeId: 'fixture' }, env, dependencies);
  expect(result).toMatchObject({ status: 'ok', paused: true, generations: 1, live_model: 'not_invoked' });
  expect(fs.existsSync(directory)).toBe(false);
  expect(fs.existsSync(state + '/context-recovery-backups')).toBe(true);
  expect(purgeDue).toHaveBeenCalledOnce();
  expect(end).toHaveBeenCalledOnce();
});
