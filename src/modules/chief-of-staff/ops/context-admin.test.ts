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
