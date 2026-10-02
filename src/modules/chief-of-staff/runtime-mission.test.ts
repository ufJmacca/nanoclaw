import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { initTestDb, closeDb } from '../../db/connection.js';
import { installCosBoundary, type CosBinding } from '../../cos-boundary.js';
import { setDeliveryAdapter } from '../../delivery.js';
import type { Session } from '../../types.js';
import type { PriorityStore } from './store/priorities.js';
import { createCosRuntime } from './runtime.js';
import { ensureConversationSchema } from './bridge/conversation-state.js';
import { digest } from './domain/contracts.js';

let runtime: ReturnType<typeof createCosRuntime>;
afterEach(() => {
  runtime?.dispose();
  closeDb();
});
function fixture() {
  const db = initTestDb(),
    generation = randomUUID(),
    reviewId = randomUUID();
  const binding: CosBinding = {
    scopeId: 'scope',
    ownerId: 'owner',
    agentGroupId: 'group',
    sessionId: 'main',
    messagingGroupId: 'mg',
    provider: 'codex',
    instanceId: 'fixture',
    channelId: 'private',
    botId: 'bot',
  };
  const session = {
    id: 'main',
    agent_group_id: 'group',
    messaging_group_id: 'mg',
    thread_id: null,
    status: 'active',
    agent_provider: 'codex',
  } as Session;
  installCosBoundary(binding, db);
  ensureConversationSchema(db);
  db.prepare('UPDATE cos_identity_boundaries SET paused=0,ingress_id=?,ingress_at=?').run(
    'owner-message',
    new Date().toISOString(),
  );
  db.prepare(
    "INSERT INTO cos_conversation_states(scope_id,binding_digest,account_fingerprint,generation,status,updated_at) VALUES(?,?,?,?,'active',?)",
  ).run(binding.scopeId, digest(binding), 'a'.repeat(64), generation, new Date().toISOString());
  let started = false;
  const missionNotifications = {
    pending: vi.fn(async () => ({ status: 'ok', review_ids: [reviewId] })),
    begin: vi.fn(async () => {
      if (started) return { status: 'denied' };
      started = true;
      return { status: 'ok', notification_id: 'mission-review-' + reviewId };
    }),
    read: vi.fn(async () => ({ status: 'ok', text: 'Reviewed fixture result' })),
    finish: vi.fn(async (_c, _r, _a, receipt) => ({ status: 'ok', state: receipt.state })),
  };
  const deliver = vi.fn(async () => 'fixture-post');
  setDeliveryAdapter({ deliver });
  const facts = vi.fn(async () => ({
    id: 'private',
    type: 'P' as const,
    delete_at: 0,
    members: ['owner', 'bot'],
    activeSubscription: true,
  }));
  runtime = createCosRuntime({
    db,
    enabled: true,
    store: {
      missionNotifications,
      pendingOutbox: vi.fn(async () => ({ status: 'ok', items: [] })),
    } as unknown as PriorityStore,
    session: () => session,
    facts,
    destination: () => undefined,
    stop: vi.fn(),
    wake: vi.fn(),
  });
  return { db, binding, generation, reviewId, missionNotifications, deliver, facts };
}
it('S05 host pump delivers a reviewed result to the existing bound private main conversation', async () => {
  const f = fixture();
  await runtime.pump(f.binding);
  expect(f.deliver).toHaveBeenCalledExactlyOnceWith(
    'mattermost',
    'mattermost:fixture:private',
    null,
    'chat',
    JSON.stringify({ text: 'Reviewed fixture result' }),
    undefined,
    'mission-review-' + f.reviewId,
  );
  expect(f.missionNotifications.read).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'main', generation: f.generation }),
    f.reviewId,
    expect.any(String),
  );
  await runtime.pump(f.binding);
  expect(f.deliver).toHaveBeenCalledTimes(1);
});
it.each(['pause', 'membership', 'context'])('S05 host pump withholds result after %s changes', async (change) => {
  const f = fixture();
  if (change === 'pause') f.db.prepare('UPDATE cos_identity_boundaries SET paused=1').run();
  if (change === 'membership')
    f.facts.mockResolvedValue({
      id: 'private',
      type: 'P',
      delete_at: 0,
      members: ['owner', 'bot', 'outsider'],
      activeSubscription: true,
    });
  if (change === 'context')
    f.missionNotifications.read.mockImplementation(async () => {
      f.db.prepare('UPDATE cos_conversation_states SET generation=?').run(randomUUID());
      return { status: 'ok', text: 'Stale result' };
    });
  await runtime.pump(f.binding);
  expect(f.deliver).not.toHaveBeenCalled();
});
