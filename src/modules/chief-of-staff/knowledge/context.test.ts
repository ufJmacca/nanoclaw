import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { installCosBoundary, type CosBinding } from '../../../cos-boundary.js';
import { ensureConversationSchema } from '../bridge/conversation-state.js';
import { digest } from '../domain/contracts.js';
import type { Session } from '../../../types.js';
import { resolveBriefPreparationContext, resolveKnowledgeContext } from './context.js';
import { installScheduledOrigin } from '../automation/scheduled-origin.js';

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
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
  const context = {
    scopeId: 'scope',
    ownerId: 'owner',
    agentGroupId: 'group',
    sessionId: 'session',
    ingressId: 'verified',
  };
  const generation = randomUUID();
  installCosBoundary(binding, db);
  ensureConversationSchema(db);
  db.prepare('UPDATE cos_identity_boundaries SET paused=0,ingress_id=?').run(context.ingressId);
  db.prepare(
    "INSERT INTO cos_conversation_states(scope_id,binding_digest,account_fingerprint,generation,status,updated_at) VALUES(?,?,?,?,'active',?)",
  ).run(binding.scopeId, digest(binding), 'a'.repeat(64), generation, new Date().toISOString());
  return { db, binding, session, context, generation };
}
it('derives knowledge generation and provider only from the current host binding and retained conversation', () => {
  const f = fixture();
  expect(resolveKnowledgeContext(f.session, f.context, f.db)).toEqual({
    ...f.context,
    provider: 'codex',
    generation: f.generation,
  });
  expect(resolveKnowledgeContext(f.session, { ...f.context, ownerId: 'foreign' }, f.db)).toBeNull();
  expect(resolveKnowledgeContext(f.session, { ...f.context, ingressId: 'old' }, f.db)).toBeNull();
  expect(resolveKnowledgeContext({ ...f.session, agent_provider: 'claude' }, f.context, f.db)).toBeNull();
  f.db.exec('UPDATE cos_identity_boundaries SET paused=1');
  expect(resolveKnowledgeContext(f.session, f.context, f.db)).toBeNull();
});
it.each([null, 'verified'])('prepares a host brief with owner ingress %s without granting an owner turn', (ingress) => {
  const f = fixture(),
    context = { ...f.context, ingressId: 'host-brief-reservation' };
  f.db.prepare('UPDATE cos_identity_boundaries SET ingress_id=?,ingress_at=NULL').run(ingress);
  const before = f.db.serialize();
  expect(resolveBriefPreparationContext(f.session, context, f.db)).toEqual({
    ...context,
    provider: 'codex',
    generation: f.generation,
  });
  expect(resolveKnowledgeContext(f.session, context, f.db)).toBeNull();
  expect(resolveBriefPreparationContext(f.session, { ...context, ownerId: 'foreign' }, f.db)).toBeNull();
  expect(resolveBriefPreparationContext(f.session, f.context, f.db)).toBeNull();
  expect(f.db.serialize()).toEqual(before);
});
it.each([
  'paused',
  'invalidated',
  'preparing',
  'mismatched_binding',
  'malformed_generation',
  'missing',
  'scheduled',
  'expired',
])('denies %s host preparation without repairing or bypassing retained state', (reason) => {
  const f = fixture(),
    context = { ...f.context, ingressId: 'host-brief-reservation' };
  f.db.exec('UPDATE cos_identity_boundaries SET ingress_id=NULL');
  if (reason === 'paused') f.db.exec('UPDATE cos_identity_boundaries SET paused=1');
  else if (reason === 'missing') f.db.exec('DROP TABLE cos_conversation_states');
  else if (reason === 'mismatched_binding')
    f.db.prepare('UPDATE cos_conversation_states SET binding_digest=?').run('b'.repeat(64));
  else if (reason === 'malformed_generation')
    f.db.prepare('UPDATE cos_conversation_states SET generation=?').run('../foreign');
  else if (reason === 'scheduled' || reason === 'expired') {
    const now = Date.now();
    expect(
      installScheduledOrigin(
        f.db,
        f.binding,
        f.session,
        {
          runId: 'a'.repeat(64),
          generation: 1,
          hostId: 'host',
          deadlineAt: new Date(now + 10000).toISOString(),
        },
        now,
      ),
    ).toBe(true);
    if (reason === 'expired')
      f.db.prepare('UPDATE cos_scheduled_origins SET deadline_at=?').run(new Date(now - 1).toISOString());
  } else f.db.prepare('UPDATE cos_conversation_states SET status=?').run(reason);
  const before = f.db.serialize();
  expect(resolveBriefPreparationContext(f.session, context, f.db)).toBeNull();
  expect(f.db.serialize()).toEqual(before);
});
it.each(['invalidated', 'preparing', 'mismatched_binding', 'malformed_generation', 'missing'])(
  'denies %s retained context without creating or repairing it',
  (reason) => {
    const f = fixture();
    if (reason === 'missing') f.db.exec('DROP TABLE cos_conversation_states');
    else if (reason === 'mismatched_binding')
      f.db.prepare('UPDATE cos_conversation_states SET binding_digest=?').run('b'.repeat(64));
    else if (reason === 'malformed_generation')
      f.db.prepare('UPDATE cos_conversation_states SET generation=?').run('../foreign');
    else f.db.prepare('UPDATE cos_conversation_states SET status=?').run(reason);
    expect(resolveKnowledgeContext(f.session, f.context, f.db)).toBeNull();
    if (reason === 'missing')
      expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name='cos_conversation_states'").get()).toBeUndefined();
  },
);
