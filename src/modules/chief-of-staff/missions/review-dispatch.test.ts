import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { initTestDb, closeDb } from '../../../db/connection.js';
import { INBOUND_SCHEMA } from '../../../db/schema.js';
import { installCosBoundary, type CosBinding } from '../../../cos-boundary.js';
import type { Session } from '../../../types.js';
import { ensureConversationSchema } from '../bridge/conversation-state.js';
import { digest } from '../domain/contracts.js';
import { NativeMissionReviewTasks } from './review-task.js';
import { readReviewOrigin, reviewContext } from './review-origin.js';
import { MissionReviewDispatch } from './review-dispatch.js';
import { CoordinatorReviewRuns } from './coordinator-review-runs.js';
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  closeDb();
});
function fixture(missionId = 'mission') {
  const db = initTestDb(),
    inbound = new Database(':memory:');
  databases.push(inbound);
  inbound.exec(INBOUND_SCHEMA);
  const binding: CosBinding = {
    scopeId: 'scope',
    ownerId: 'owner',
    agentGroupId: 'main-group',
    sessionId: 'main',
    messagingGroupId: 'mg',
    provider: 'codex',
    instanceId: 'fixture',
    channelId: 'private',
    botId: 'bot',
  };
  const session = {
    id: 'main',
    agent_group_id: 'main-group',
    messaging_group_id: 'mg',
    agent_provider: 'codex',
    status: 'active',
    thread_id: null,
  } as Session;
  installCosBoundary(binding, db);
  ensureConversationSchema(db);
  const generation = randomUUID();
  db.prepare('UPDATE cos_identity_boundaries SET paused=0,ingress_id=?,ingress_at=?').run(
    'owner-event',
    new Date(Date.now() - 600000).toISOString(),
  );
  db.prepare(
    "INSERT INTO cos_conversation_states(scope_id,binding_digest,account_fingerprint,generation,status,updated_at) VALUES(?,?,?,?,'active',?)",
  ).run(binding.scopeId, digest(binding), 'a'.repeat(64), generation, new Date().toISOString());
  const identity = {
    missionId,
    submissionId: randomUUID(),
    attemptId: randomUUID(),
    generation: 1,
    sessionId: 'main',
    contextGeneration: generation,
  };
  const lease = { owner: 'cos-review-' + digest(binding), fence: 1 },
    deadline = () => new Date(Date.now() + 30000).toISOString();
  const task = {
    identity,
    inputId: 'cos-mission-review-' + digest({ scope: binding.scopeId, identity }),
    issuedAt: new Date(Date.now() - 600000).toISOString(),
  };
  let state = 'awaiting_review',
    retired = false,
    running = false,
    available = true;
  const runs = {
    pending: vi.fn(async () => ({
      status: 'ok' as const,
      items: retired ? [] : [{ mission_id: identity.missionId, submission_id: identity.submissionId }],
    })),
    claim: vi.fn(async () => ({
      status: 'ok' as const,
      identity,
      lease,
      deadline_at: deadline(),
      input_id: task.inputId,
      issued_at: task.issuedAt,
    })),
    inspect: vi.fn(async () => ({
      status: available ? ('ok' as const) : ('unavailable' as const),
      identity,
      lease,
      task,
      state,
      retired,
      deadline_at: deadline(),
    })),
    authorize: vi.fn(async () => ({
      status: !retired && state === 'awaiting_review' ? ('ok' as const) : ('denied' as const),
    })),
    renew: vi.fn(async () => ({ status: 'ok' as const, deadline_at: deadline() })),
    retire: vi.fn(async () => {
      if (!available) return { status: 'pending' as const };
      retired = true;
      return { status: 'ok' as const };
    }),
  };
  const tasks = new NativeMissionReviewTasks(inbound),
    wake = vi.fn(async () => false),
    stop = vi.fn(() => {
      running = false;
    });
  const d = {
    db,
    runs,
    session: () => session,
    admitted: vi.fn(async () => true),
    running: () => running,
    stop,
    wake,
    withTasks: async <T>(_s: Session, operation: (tasks: NativeMissionReviewTasks) => Promise<T>) => operation(tasks),
  };
  return {
    db,
    inbound,
    binding,
    session,
    identity,
    task,
    tasks,
    runs,
    d,
    wake,
    stop,
    dispatch: new MissionReviewDispatch(d),
    setState: (s: string) => {
      state = s;
    },
    setRunning: (r: boolean) => {
      running = r;
    },
    setAvailable: (a: boolean) => {
      available = a;
    },
  };
}
it('S05-T05/T11 dispatches into the existing main context and preserves a deferred native input across restart', async () => {
  const f = fixture();
  expect((await f.dispatch.drain(f.binding)).status).toBe('pending');
  expect(f.wake).toHaveBeenCalledExactlyOnceWith(f.session);
  expect(f.tasks.state(f.binding, f.task)).toBe('pending');
  expect(readReviewOrigin(f.db, f.binding)?.identity).toEqual(f.identity);
  expect((await new MissionReviewDispatch(f.d).drain(f.binding)).status).toBe('pending');
  expect(f.runs.claim).toHaveBeenCalledTimes(1);
  expect(f.inbound.prepare('SELECT count(*) AS n FROM messages_in').get()).toEqual({ n: 1 });
  expect(f.db.prepare('SELECT generation FROM cos_conversation_states').get()).toEqual({
    generation: f.identity.contextGeneration,
  });
});
it('S05-T06 retires the remote grant and exact native task only after physical stop is confirmed', async () => {
  const f = fixture();
  await f.dispatch.drain(f.binding);
  f.setState('completed');
  f.setRunning(true);
  f.stop.mockImplementation(() => undefined);
  expect((await f.dispatch.drain(f.binding)).status).toBe('pending');
  expect(f.runs.retire).toHaveBeenCalled();
  expect(f.tasks.state(f.binding, f.task)).toBe('completed');
  expect(reviewContext(f.session, f.db)).toBeNull();
  expect(readReviewOrigin(f.db, f.binding)).not.toBeNull();
  f.setRunning(false);
  expect((await f.dispatch.drain(f.binding)).state).toBe('retired');
  expect(reviewContext(f.session, f.db)).toBeUndefined();
});
it('S05-T06/T10 database uncertainty stops locally and retains a closed origin through restart', async () => {
  const f = fixture();
  await f.dispatch.drain(f.binding);
  f.wake.mockClear();
  f.setRunning(true);
  f.setAvailable(false);
  expect((await f.dispatch.drain(f.binding)).status).toBe('pending');
  expect(f.stop).toHaveBeenCalledWith('main');
  expect(reviewContext(f.session, f.db)).toBeNull();
  f.setAvailable(true);
  expect((await new MissionReviewDispatch(f.d).drain(f.binding)).state).toBe('retired');
  expect(f.wake).not.toHaveBeenCalled();
});
it.each(['owner', 'source', 'private', 'pause', 'context'])(
  'S05-T07 %s change fences review without waking it again',
  async (change) => {
    const f = fixture();
    await f.dispatch.drain(f.binding);
    f.wake.mockClear();
    if (change === 'owner') f.db.prepare('UPDATE cos_identity_boundaries SET ingress_id=?').run('new-owner-event');
    if (change === 'source') f.runs.authorize.mockResolvedValue({ status: 'denied' });
    if (change === 'private') f.d.admitted.mockResolvedValue(false);
    if (change === 'pause') f.db.prepare('UPDATE cos_identity_boundaries SET paused=1').run();
    if (change === 'context') f.db.prepare('UPDATE cos_conversation_states SET generation=?').run(randomUUID());
    expect((await f.dispatch.drain(f.binding)).state).toBe('retired');
    expect(f.wake).not.toHaveBeenCalled();
    expect(f.tasks.state(f.binding, f.task)).toBe('completed');
  },
);
it('S05-T06 reconciles a crash after origin installation but before native staging', async () => {
  const f = fixture(),
    stage = vi.spyOn(f.tasks, 'stage').mockImplementationOnce(() => {
      throw Error('fixture crash');
    });
  expect((await f.dispatch.drain(f.binding)).status).toBe('pending');
  expect(readReviewOrigin(f.db, f.binding)).not.toBeNull();
  expect(f.wake).not.toHaveBeenCalled();
  stage.mockRestore();
  expect((await new MissionReviewDispatch(f.d).drain(f.binding)).state).toBe('retired');
  expect(f.inbound.prepare('SELECT count(*) AS n FROM messages_in').get()).toEqual({ n: 0 });
});
it('S05-T06 refuses to clear the fence around a changed native task', async () => {
  const f = fixture();
  await f.dispatch.drain(f.binding);
  f.wake.mockClear();
  f.inbound.prepare("UPDATE messages_in SET content='tampered'").run();
  expect((await f.dispatch.drain(f.binding)).status).toBe('pending');
  expect(reviewContext(f.session, f.db)).toBeNull();
  expect(f.runs.retire).toHaveBeenCalled();
  expect(f.wake).not.toHaveBeenCalled();
});
it('S05-T06 lost renewal acknowledgement keeps the local fence until remote retirement is reconciled', async () => {
  const f = fixture();
  await f.dispatch.drain(f.binding);
  f.wake.mockClear();
  f.runs.renew.mockImplementationOnce(async () => {
    f.setAvailable(false);
    throw Error('unknown renewal');
  });
  expect((await f.dispatch.drain(f.binding)).status).toBe('pending');
  expect(reviewContext(f.session, f.db)).toBeNull();
  f.setAvailable(true);
  expect((await new MissionReviewDispatch(f.d).drain(f.binding)).state).toBe('retired');
  expect(f.wake).not.toHaveBeenCalled();
});
it('S05-T07 owner preemption during a remote claim never stages or wakes review work', async () => {
  const f = fixture(),
    claim = f.runs.claim.getMockImplementation()!;
  f.runs.claim.mockImplementation(async () => {
    const result = await claim();
    f.db.prepare('UPDATE cos_identity_boundaries SET ingress_id=?').run('new-owner-event');
    return result;
  });
  expect((await f.dispatch.drain(f.binding)).status).toBe('pending');
  expect(f.runs.retire).toHaveBeenCalled();
  expect(f.wake).not.toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
  expect(readReviewOrigin(f.db, f.binding)).toBeNull();
});
it('S05-T06 missing native review state while a container is running never recreates a runnable task', async () => {
  const f = fixture();
  await f.dispatch.drain(f.binding);
  f.wake.mockClear();
  f.inbound.prepare('DELETE FROM messages_in').run();
  f.inbound.prepare('DELETE FROM cos_mission_review_tasks').run();
  f.setRunning(true);
  await f.dispatch.drain(f.binding);
  expect(f.stop).toHaveBeenCalledWith('main');
  expect(f.inbound.prepare('SELECT count(*) AS n FROM messages_in').get()).toEqual({ n: 0 });
  expect(f.wake).not.toHaveBeenCalled();
});
it('S05-T11 leaves a busy main session free of review origins and tasks', async () => {
  const f = fixture();
  f.setRunning(true);
  await f.dispatch.drain(f.binding);
  expect(f.runs.claim).not.toHaveBeenCalled();
  expect(readReviewOrigin(f.db, f.binding)).toBeNull();
  expect(f.inbound.prepare('SELECT count(*) AS n FROM messages_in').get()).toEqual({ n: 0 });
});

it('S06-T05/T06/T07 team wakes reuse the main native task and retain its identity for pause/cancellation recovery', async () => {
  const f = fixture('team-' + 'a'.repeat(64));
  const teams = { ...f.runs, reserve: vi.fn(async () => ({ status: 'ok' as const, reserved: false })) },
    singles = {
      ...teams,
      pending: vi.fn(async () => ({ status: 'ok' as const, items: [] })),
      claim: vi.fn(async () => ({ status: 'denied' as const })),
    },
    runs = new CoordinatorReviewRuns(singles, teams),
    d = { ...f.d, runs };
  const dispatch = new MissionReviewDispatch(d);
  expect((await dispatch.drain(f.binding)).status).toBe('pending');
  expect(f.wake).toHaveBeenCalledExactlyOnceWith(f.session);
  expect(teams.claim).toHaveBeenCalledTimes(1);
  expect(singles.claim).not.toHaveBeenCalled();
  expect(readReviewOrigin(f.db, f.binding)?.identity).toEqual(f.identity);
  expect((await new MissionReviewDispatch(d).drain(f.binding)).status).toBe('pending');
  expect(teams.claim).toHaveBeenCalledTimes(1);
  expect(f.inbound.prepare('SELECT count(*) AS n FROM messages_in').get()).toEqual({ n: 1 });
  const task = f.inbound.prepare('SELECT content,thread_id FROM messages_in').get() as {
    content: string;
    thread_id: string | null;
  };
  expect(task.thread_id).toBeNull();
  expect(JSON.parse(task.content).cosMissionReview.missionId).toBe(f.identity.missionId);
  f.setState('cancelled');
  f.db.prepare('UPDATE cos_identity_boundaries SET paused=1').run();
  expect((await dispatch.drain(f.binding)).state).toBe('retired');
  expect(readReviewOrigin(f.db, f.binding)).toBeNull();
  expect(teams.retire).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: f.session.id, generation: f.identity.contextGeneration }),
    f.identity.missionId,
    f.identity.submissionId,
    expect.any(Object),
  );
  expect(f.db.prepare('SELECT generation FROM cos_conversation_states').get()).toEqual({
    generation: f.identity.contextGeneration,
  });
});
