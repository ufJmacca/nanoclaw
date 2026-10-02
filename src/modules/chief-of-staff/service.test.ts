import { describe, it, expect, vi, afterEach } from 'vitest';
import { initTestDb, closeDb } from '../../db/connection.js';
import { ensureCosBoundarySchema, installCosBoundary, type CosBinding } from '../../cos-boundary.js';
import { CosService } from './service.js';
import type { PriorityStore } from './store/priorities.js';
import { randomUUID } from 'node:crypto';
import { digest } from './domain/contracts.js';
import { ensureConversationSchema } from './bridge/conversation-state.js';
import { installReviewOrigin, reviewContext } from './missions/review-origin.js';
import type { Session } from '../../types.js';
const services: CosService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  closeDb();
});
function fixture(enabled: boolean) {
  const db = initTestDb();
  ensureCosBoundarySchema(db);
  const end = vi.fn().mockResolvedValue(undefined),
    query = vi.fn().mockResolvedValue({ rows: [{ version: 1 }] });
  const store = {
    database: { pool: { end }, run: vi.fn().mockImplementation((fn) => fn({ query })) },
    pendingOutbox: vi.fn().mockResolvedValue({ status: 'ok', items: [] }),
  } as unknown as PriorityStore;
  const connect = vi.fn().mockResolvedValue(store);
  const admission = vi.fn().mockReturnValue(true),
    stop = vi.fn();
  const service = new CosService({
    db,
    enabled,
    connect,
    facts: vi.fn(),
    session: () => undefined,
    destination: () => undefined,
    stop,
    admission,
    wake: vi.fn().mockResolvedValue(undefined),
  });
  services.push(service);
  return { db, service, connect, end, query, admission, stop };
}
describe('S01-T01 host startup and dependency service', () => {
  it('disabled operation starts and ticks without connecting to PostgreSQL', async () => {
    const f = fixture(false);
    await f.service.tick();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.service.status).toBe('disabled');
  });
  it('creates one runtime pool and recovers bounded connection failures without rejecting host work', async () => {
    const f = fixture(true);
    f.connect.mockRejectedValueOnce(new Error('private database diagnostic'));
    await expect(f.service.tick()).resolves.toBeUndefined();
    expect(f.service.status).toBe('unreachable');
    await f.service.tick();
    expect(f.service.status).toBe('ready');
    await f.service.tick();
    expect(f.connect).toHaveBeenCalledTimes(2);
  });
  it('does not start another connection while a previous tick is in progress', async () => {
    const f = fixture(true);
    let resolve!: () => void;
    const store = await f.connect();
    f.connect.mockClear();
    f.connect.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = () => done(store);
        }),
    );
    const first = f.service.tick();
    await f.service.tick();
    expect(f.connect).toHaveBeenCalledOnce();
    resolve();
    await first;
  });
  it('closes the pool and prevents reconnection after shutdown', async () => {
    const f = fixture(true);
    await f.service.tick();
    await f.service.stop();
    await f.service.tick();
    expect(f.end).toHaveBeenCalledOnce();
    expect(f.connect).toHaveBeenCalledOnce();
  });
});
it('S02 reconciles durable denial work for paused bindings without reactivating them', async () => {
  const f = fixture(true);
  await f.service.tick();
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
  installCosBoundary(binding, f.db);
  const pump = vi.spyOn(f.service.runtime, 'pump');
  await f.service.tick();
  expect(pump).toHaveBeenCalledWith(binding);
  expect(f.db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
});

it('closes only CoS admission during maintenance and reconnects after verified reopening', async () => {
  const f = fixture(true);
  await f.service.tick();
  f.admission.mockReturnValue(false);
  await f.service.tick();
  expect(f.service.status).toBe('maintenance');
  expect(f.end).toHaveBeenCalledOnce();
  await f.service.tick();
  expect(f.connect).toHaveBeenCalledOnce();
  expect(f.end).toHaveBeenCalledOnce();
  f.admission.mockReturnValue(true);
  await f.service.tick();
  expect(f.connect).toHaveBeenCalledTimes(2);
  expect(f.service.status).toBe('ready');
});
it.each(['database', 'maintenance'])(
  'S05-T10 %s closes an active review origin before any database recovery',
  async (failure) => {
    const f = fixture(true);
    await f.service.tick();
    const binding: CosBinding = {
      scopeId: 'scope',
      agentGroupId: 'group',
      messagingGroupId: 'mg',
      sessionId: 'main',
      provider: 'codex',
      instanceId: 'fixture',
      channelId: 'private',
      ownerId: 'owner',
      botId: 'bot',
    };
    const session = {
      id: 'main',
      agent_group_id: 'group',
      messaging_group_id: 'mg',
      agent_provider: 'codex',
      status: 'active',
      thread_id: null,
    } as Session;
    installCosBoundary(binding, f.db);
    ensureConversationSchema(f.db);
    f.db
      .prepare('UPDATE cos_identity_boundaries SET paused=0,ingress_id=?,ingress_at=?')
      .run('owner-event', new Date().toISOString());
    const generation = randomUUID();
    f.db
      .prepare(
        "INSERT INTO cos_conversation_states(scope_id,binding_digest,account_fingerprint,generation,status,updated_at) VALUES(?,?,?,?,'active',?)",
      )
      .run('scope', digest(binding), 'a'.repeat(64), generation, new Date().toISOString());
    expect(
      installReviewOrigin(f.db, binding, session, {
        identity: {
          missionId: 'mission',
          attemptId: randomUUID(),
          submissionId: randomUUID(),
          generation: 1,
          sessionId: 'main',
          contextGeneration: generation,
        },
        lease: { owner: 'host', fence: 1 },
        deadlineAt: new Date(Date.now() + 30000).toISOString(),
      }),
    ).toBe(true);
    f.stop.mockImplementation(() => {
      expect(reviewContext(session, f.db)).toBeNull();
    });
    if (failure === 'database') f.query.mockRejectedValueOnce(Error('fixture partition'));
    else f.admission.mockReturnValue(false);
    await f.service.tick();
    expect(f.stop).toHaveBeenCalledExactlyOnceWith('main');
    expect(reviewContext(session, f.db)).toBeNull();
    expect(f.db.prepare('SELECT count(*) AS n FROM cos_mission_review_origins').get()).toEqual({ n: 1 });
  },
);
