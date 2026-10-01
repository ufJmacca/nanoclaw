import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { initTestDb, closeDb } from '../../../db/connection.js';
import { installCosBoundary, type CosBinding } from '../../../cos-boundary.js';
import type { Session } from '../../../types.js';
import { digest } from '../domain/contracts.js';
import { ensureConversationSchema } from '../bridge/conversation-state.js';
import { resolveKnowledgeContext } from '../knowledge/context.js';
import {
  installScheduledOrigin,
  scheduledContext,
  interruptScheduledOrigin,
  clearScheduledOrigin,
  readScheduledLease,
} from './scheduled-origin.js';
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
const now = Date.now(),
  lease = { runId: 'a'.repeat(64), generation: 1, hostId: 'host-a', deadlineAt: new Date(now + 120000).toISOString() };
afterEach(() => closeDb());
function fixture() {
  const db = initTestDb();
  installCosBoundary(binding, db);
  db.prepare('UPDATE cos_identity_boundaries SET paused=0,ingress_id=?,ingress_at=?').run(
    'old-owner-message',
    new Date(now - 600000).toISOString(),
  );
  return db;
}
it('S04 can recover an interrupted or expired local lease without treating it as execution authority', () => {
  const db = fixture();
  expect(readScheduledLease(db, binding)).toBeNull();
  expect(installScheduledOrigin(db, binding, session, lease, now)).toBe(true);
  interruptScheduledOrigin(db, binding);
  expect(scheduledContext(session, db, now + 150000)).toBeNull();
  expect(readScheduledLease(db, binding)).toEqual(lease);
  expect(readScheduledLease(db, { ...binding, ownerId: 'foreign' })).toBeNull();
});
it('S04 scheduled work uses an explicit lease origin without forging or extending owner ingress', () => {
  const db = fixture(),
    before = db.prepare('SELECT ingress_id,ingress_at FROM cos_identity_boundaries').get();
  expect(installScheduledOrigin(db, binding, session, lease, now)).toBe(true);
  expect(scheduledContext(session, db, now)).toEqual({
    scopeId: 'scope',
    ownerId: 'owner',
    sessionId: 'session',
    agentGroupId: 'group',
    ingressId: `brief:${lease.runId}:1`,
    origin: { kind: 'schedule', runId: lease.runId, generation: 1 },
  });
  expect(db.prepare('SELECT ingress_id,ingress_at FROM cos_identity_boundaries').get()).toEqual(before);
  expect(installScheduledOrigin(db, binding, session, lease, now)).toBe(true);
  expect(installScheduledOrigin(db, binding, session, { ...lease, runId: 'b'.repeat(64) }, now)).toBe(false);
});
it('S04 scheduled tools retain the existing CoS knowledge and provider context generation', () => {
  const db = fixture();
  expect(installScheduledOrigin(db, binding, session, lease, now)).toBe(true);
  ensureConversationSchema(db);
  const generation = randomUUID();
  db.prepare(
    "INSERT INTO cos_conversation_states(scope_id,binding_digest,account_fingerprint,generation,status,updated_at) VALUES(?,?,?,?,'active',?)",
  ).run(binding.scopeId, digest(binding), 'a'.repeat(64), generation, new Date(now).toISOString());
  const context = scheduledContext(session, db, now)!;
  expect(resolveKnowledgeContext(session, context, db)).toMatchObject({
    generation,
    provider: 'codex',
    origin: { kind: 'schedule', runId: lease.runId },
  });
  expect(db.prepare('SELECT generation FROM cos_conversation_states').get()).toEqual({ generation });
});
it('S04 pause, deadline, owner preemption and binding changes fence the origin instead of falling back to ordinary authority', () => {
  const db = fixture();
  expect(installScheduledOrigin(db, binding, session, lease, now)).toBe(true);
  expect(scheduledContext(session, db, now + 120001)).toBeNull();
  db.prepare('UPDATE cos_identity_boundaries SET paused=1').run();
  expect(scheduledContext(session, db, now)).toBeNull();
  db.prepare('UPDATE cos_identity_boundaries SET paused=0,ingress_id=?').run('new-owner-message');
  expect(scheduledContext(session, db, now)).toBeNull();
  db.prepare('UPDATE cos_identity_boundaries SET ingress_id=?').run('old-owner-message');
  expect(interruptScheduledOrigin(db, binding)).toBe(true);
  expect(scheduledContext(session, db, now)).toBeNull();
  expect(installScheduledOrigin(db, binding, session, lease, now)).toBe(false);
  expect(clearScheduledOrigin(db, binding, { ...lease, generation: 2 })).toBe(false);
  expect(clearScheduledOrigin(db, binding, lease)).toBe(true);
  expect(scheduledContext(session, db, now)).toBeUndefined();
});
it('S04 cannot install a stale, unbound, foreign or enlarged scheduled lease', () => {
  const db = fixture();
  for (const patch of [
    { runId: 'forged' },
    { generation: 0 },
    { hostId: '../host' },
    { deadlineAt: new Date(now - 1).toISOString() },
    { deadlineAt: new Date(now + 301000).toISOString() },
  ])
    expect(installScheduledOrigin(db, binding, session, { ...lease, ...patch }, now)).toBe(false);
  expect(installScheduledOrigin(db, { ...binding, ownerId: 'intruder' }, session, lease, now)).toBe(false);
  expect(installScheduledOrigin(db, binding, { ...session, id: 'foreign' }, lease, now)).toBe(false);
});
