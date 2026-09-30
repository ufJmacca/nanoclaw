import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { installCosBoundary, type CosBinding } from '../../../cos-boundary.js';
import type { Session } from '../../../types.js';
import { ensureConversationSchema } from '../bridge/conversation-state.js';
import { digest } from '../domain/contracts.js';
import { KnowledgeInvalidation } from './invalidation.js';

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture(paused = 0) {
  const db = new Database(':memory:');
  databases.push(db);
  const binding: CosBinding = {
    scopeId: 'scope',
    agentGroupId: 'group',
    messagingGroupId: 'mg',
    sessionId: 'session',
    provider: 'codex',
    instanceId: 'fixture',
    channelId: 'private',
    ownerId: 'owner',
    botId: 'bot',
  };
  const session = {
    id: 'session',
    agent_group_id: 'group',
    messaging_group_id: 'mg',
    thread_id: null,
    status: 'active',
    agent_provider: 'codex',
  } as Session;
  installCosBoundary(binding, db);
  ensureConversationSchema(db);
  db.prepare('UPDATE cos_identity_boundaries SET paused=?,ingress_id=?').run(paused, 'ingress');
  db.prepare(
    "INSERT INTO cos_conversation_states(scope_id,binding_digest,account_fingerprint,generation,status,updated_at) VALUES(?,?,?,?,'active',?)",
  ).run(binding.scopeId, digest(binding), 'a'.repeat(64), randomUUID(), new Date().toISOString());
  const store = {
    pendingInvalidations: vi.fn().mockResolvedValue({ status: 'ok', items: [{ id: 'job' }] }),
    contextReady: vi.fn().mockResolvedValue({ status: 'denied' }),
    acknowledgeInvalidation: vi.fn().mockResolvedValue({ status: 'ok' }),
  };
  const retained = () =>
    db.prepare('SELECT status,generation FROM cos_conversation_states').get() as { status: string; generation: string };
  const pause = () => (db.prepare('SELECT paused FROM cos_identity_boundaries').get() as { paused: number }).paused;
  const stop = vi.fn(() => {
    expect(retained().status).toBe('invalidated');
    expect(pause()).toBe(1);
  });
  const reconciler = new KnowledgeInvalidation({ db, store, session: () => session, stop });
  return { db, binding, store, retained, pause, stop, reconciler };
}
it.each([0, 1])('persists denial before stopping the exposed context, including paused=%s', async (paused) => {
  const f = fixture(paused),
    generation = f.retained().generation;
  await f.reconciler.drain(f.binding);
  expect(f.retained()).toEqual({ status: 'invalidated', generation });
  expect(f.stop).toHaveBeenCalledWith('session');
  expect(f.store.acknowledgeInvalidation).toHaveBeenCalledWith('scope', 'job');
});
it('retries a failed stop without acknowledging or restoring the invalidated context', async () => {
  const f = fixture();
  f.stop.mockImplementationOnce(() => {
    throw new Error('fixture stop failed');
  });
  await expect(f.reconciler.drain(f.binding)).rejects.toThrow('fixture stop failed');
  expect(f.retained().status).toBe('invalidated');
  expect(f.pause()).toBe(1);
  expect(f.store.acknowledgeInvalidation).not.toHaveBeenCalled();
  await new KnowledgeInvalidation(f.reconciler.dependencies).drain(f.binding);
  expect(f.stop).toHaveBeenCalledTimes(2);
  expect(f.store.acknowledgeInvalidation).toHaveBeenCalledOnce();
});
it('acknowledges obsolete work without terminating a clean current generation', async () => {
  const f = fixture();
  f.store.contextReady.mockResolvedValue({ status: 'ok' });
  await f.reconciler.drain(f.binding);
  expect(f.pause()).toBe(0);
  expect(f.retained().status).toBe('active');
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.store.acknowledgeInvalidation).toHaveBeenCalledOnce();
});
it('database uncertainty leaves work pending and never grants execution', async () => {
  const f = fixture(1);
  f.store.contextReady.mockResolvedValue({ status: 'unavailable' });
  await f.reconciler.drain(f.binding);
  expect(f.pause()).toBe(1);
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.store.acknowledgeInvalidation).not.toHaveBeenCalled();
});
it('does not apply an old check to a generation replaced while the check was in flight', async () => {
  const f = fixture(),
    generation = randomUUID();
  f.store.contextReady.mockImplementation(async () => {
    f.db.prepare('UPDATE cos_conversation_states SET generation=?').run(generation);
    return { status: 'denied' };
  });
  await f.reconciler.drain(f.binding);
  expect(f.retained()).toEqual({ status: 'active', generation });
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.store.acknowledgeInvalidation).not.toHaveBeenCalled();
});
