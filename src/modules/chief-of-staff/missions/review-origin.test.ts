import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { initTestDb, closeDb } from '../../../db/connection.js';
import { installCosBoundary, type CosBinding } from '../../../cos-boundary.js';
import type { Session } from '../../../types.js';
import { ensureConversationSchema } from '../bridge/conversation-state.js';
import { digest } from '../domain/contracts.js';
import { installScheduledOrigin } from '../automation/scheduled-origin.js';
import {
  installReviewOrigin,
  reviewContext,
  interruptReviewOrigin,
  clearReviewOrigin,
  readReviewOrigin,
  renewReviewOrigin,
} from './review-origin.js';
import { CosController } from '../bridge/controller.js';
import { resolveKnowledgeContext } from '../knowledge/context.js';
afterEach(closeDb);
function fixture() {
  const db = initTestDb(),
    now = Date.now();
  const binding: CosBinding = {
    scopeId: 'scope',
    ownerId: 'owner',
    agentGroupId: 'main-group',
    sessionId: 'main',
    messagingGroupId: 'mg',
    instanceId: 'fixture',
    channelId: 'private',
    botId: 'bot',
    provider: 'codex',
  };
  const session = {
    id: 'main',
    agent_group_id: 'main-group',
    messaging_group_id: 'mg',
    status: 'active',
    thread_id: null,
    agent_provider: 'codex',
  } as Session;
  installCosBoundary(binding, db);
  ensureConversationSchema(db);
  db.prepare('UPDATE cos_identity_boundaries SET paused=0,ingress_id=?,ingress_at=?').run(
    'owner-input',
    new Date(now).toISOString(),
  );
  const identity = {
    missionId: 'mission-' + 'a'.repeat(64),
    submissionId: randomUUID(),
    attemptId: randomUUID(),
    generation: 1,
    sessionId: session.id,
    contextGeneration: randomUUID(),
  };
  db.prepare(
    "INSERT INTO cos_conversation_states(scope_id,binding_digest,account_fingerprint,generation,status,updated_at) VALUES(?,?,?,?,'active',?)",
  ).run(binding.scopeId, digest(binding), 'b'.repeat(64), identity.contextGeneration, new Date(now).toISOString());
  const grant = {
    identity,
    lease: { owner: 'review-host', fence: 1 },
    deadlineAt: new Date(now + 25000).toISOString(),
  };
  return { db, now, binding, session, identity, grant };
}
it('S05-T11 review origin uses the existing main session and generation without changing conversation history', () => {
  const f = fixture(),
    before = f.db.prepare('SELECT * FROM cos_conversation_states').get();
  expect(reviewContext(f.session, f.db, f.now)).toBeUndefined();
  expect(installReviewOrigin(f.db, f.binding, f.session, f.grant, f.now)).toBe(true);
  expect(installReviewOrigin(f.db, f.binding, f.session, f.grant, f.now)).toBe(true);
  expect(f.db.prepare('SELECT * FROM cos_conversation_states').get()).toEqual(before);
  expect(reviewContext(f.session, f.db, f.now)).toMatchObject({
    sessionId: 'main',
    agentGroupId: 'main-group',
    origin: {
      kind: 'mission_review',
      runId: f.identity.missionId,
      submissionId: f.identity.submissionId,
      generation: 1,
      owner: 'review-host',
      fence: 1,
    },
  });
  expect(readReviewOrigin(f.db, f.binding)).toEqual(f.grant);
});
it.each(['expired', 'pause', 'owner', 'generation', 'interrupted'])(
  'S05-T07 %s review origin stays a closed fence rather than falling back to ordinary owner authority',
  (change) => {
    const f = fixture();
    expect(installReviewOrigin(f.db, f.binding, f.session, f.grant, f.now)).toBe(true);
    if (change === 'pause') f.db.prepare('UPDATE cos_identity_boundaries SET paused=1').run();
    if (change === 'owner') f.db.prepare("UPDATE cos_identity_boundaries SET ingress_id='next-owner-message'").run();
    if (change === 'generation') f.db.prepare('UPDATE cos_conversation_states SET generation=?').run(randomUUID());
    if (change === 'interrupted') expect(interruptReviewOrigin(f.db, f.binding)).toBe(true);
    expect(reviewContext(f.session, f.db, f.now + (change === 'expired' ? 30000 : 0))).toBeNull();
    expect(clearReviewOrigin(f.db, f.binding, { ...f.grant, lease: { owner: 'stale', fence: 1 } })).toBe(false);
    expect(clearReviewOrigin(f.db, f.binding, f.grant)).toBe(true);
    expect(reviewContext(f.session, f.db, f.now)).toBeUndefined();
  },
);
it.each(['review-first', 'schedule-first'])(
  'S05-T11 %s cannot install simultaneous automatic tasks into the same main context',
  (order) => {
    const f = fixture();
    const schedule = {
      runId: 'c'.repeat(64),
      generation: 1,
      hostId: 'brief-host',
      deadlineAt: new Date(f.now + 20000).toISOString(),
    };
    if (order === 'review-first') {
      expect(installReviewOrigin(f.db, f.binding, f.session, f.grant, f.now)).toBe(true);
      expect(installScheduledOrigin(f.db, f.binding, f.session, schedule, f.now)).toBe(false);
    } else {
      expect(installScheduledOrigin(f.db, f.binding, f.session, schedule, f.now)).toBe(true);
      expect(installReviewOrigin(f.db, f.binding, f.session, f.grant, f.now)).toBe(false);
    }
  },
);
it('S05-T03 refuses foreign sessions, changed grants and forged context generations', () => {
  const f = fixture();
  expect(
    installReviewOrigin(
      f.db,
      f.binding,
      f.session,
      { ...f.grant, identity: { ...f.identity, sessionId: 'specialist' } },
      f.now,
    ),
  ).toBe(false);
  expect(
    installReviewOrigin(
      f.db,
      f.binding,
      f.session,
      { ...f.grant, identity: { ...f.identity, contextGeneration: randomUUID() } },
      f.now,
    ),
  ).toBe(false);
  expect(installReviewOrigin(f.db, f.binding, f.session, f.grant, f.now)).toBe(true);
  expect(
    installReviewOrigin(f.db, f.binding, f.session, { ...f.grant, lease: { owner: 'other', fence: 2 } }, f.now),
  ).toBe(false);
});
it('S05-T05 renews only the exact unexpired review origin and cannot revive an interrupted task', () => {
  const f = fixture();
  installReviewOrigin(f.db, f.binding, f.session, f.grant, f.now);
  const deadlineAt = new Date(f.now + 40000).toISOString();
  expect(renewReviewOrigin(f.db, f.binding, f.session, f.grant, deadlineAt, f.now)).toBe(true);
  expect(readReviewOrigin(f.db, f.binding)).toEqual({ ...f.grant, deadlineAt });
  expect(clearReviewOrigin(f.db, f.binding, f.grant)).toBe(false);
  interruptReviewOrigin(f.db, f.binding);
  expect(
    renewReviewOrigin(
      f.db,
      f.binding,
      f.session,
      { ...f.grant, deadlineAt },
      new Date(f.now + 50000).toISOString(),
      f.now,
    ),
  ).toBe(false);
});
it.each(['message', 'pause'])(
  'S05-T11 authenticated owner %s preempts review while retaining its closed local fence',
  async (action) => {
    const f = fixture();
    installReviewOrigin(f.db, f.binding, f.session, f.grant, f.now);
    const stop = vi.fn(),
      verifyReview = vi.fn(async () => true),
      verifyScheduled = vi.fn(async () => true);
    const dependencies = {
      db: f.db,
      enabled: () => true,
      session: () => f.session,
      now: () => f.now,
      facts: async () => ({
        id: 'private',
        type: 'P' as const,
        delete_at: 0,
        members: ['owner', 'bot'],
        activeSubscription: true,
      }),
      decide: async () => ({ status: 'denied' as const }),
      acknowledge: vi.fn(),
      stop,
      project: vi.fn(),
      wake: async () => undefined,
      verifyScheduled,
    };
    expect(await new CosController(dependencies).context(f.session)).toBeNull();
    const controller = new CosController({ ...dependencies, verifyReview });
    const context = await controller.context(f.session);
    expect(context?.origin?.kind).toBe('mission_review');
    expect(verifyScheduled).not.toHaveBeenCalled();
    expect(resolveKnowledgeContext(f.session, context!, f.db)?.generation).toBe(f.identity.contextGeneration);
    await controller.ingress(f.binding, {
      channelType: 'mattermost',
      platformId: 'mattermost:fixture:private',
      threadId: null,
      message: {
        id: 'new-owner-event',
        kind: 'chat',
        timestamp: new Date(f.now).toISOString(),
        content: JSON.stringify({
          senderId: 'mattermost:owner',
          text: action === 'pause' ? 'cos pause automation' : 'Please handle this first',
        }),
      },
    });
    expect(stop).toHaveBeenCalledExactlyOnceWith('main');
    expect(controller.localContext(f.session)).toBeNull();
    expect(readReviewOrigin(f.db, f.binding)).toEqual(f.grant);
    expect(resolveKnowledgeContext(f.session, context!, f.db)).toBeNull();
  },
);
