import { describe, it, expect, vi, afterEach } from 'vitest';
import { initTestDb, closeDb } from '../../db/connection.js';
import { ensureCosBoundarySchema, installCosBoundary, type CosBinding } from '../../cos-boundary.js';
import { CosService, type SpecialistLifecycle } from './service.js';
import type { PriorityStore } from './store/priorities.js';
import { randomUUID } from 'node:crypto';
import { digest } from './domain/contracts.js';
import { ensureConversationSchema } from './bridge/conversation-state.js';
import { installReviewOrigin, reviewContext } from './missions/review-origin.js';
import type { Session } from '../../types.js';
import { installCosMissionBoundary, type CosMissionIdentity } from '../../cos-mission-boundary.js';
import { isCosMissionStopped } from '../../cos-mission-stop.js';
import { log } from '../../log.js';
const services: CosService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  closeDb();
});
function fixture(enabled: boolean, specialists?: (store: PriorityStore) => SpecialistLifecycle) {
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
  const session = vi.fn((_id: string): Session | undefined => undefined);
  const service = new CosService({
    db,
    enabled,
    connect,
    facts: vi.fn(),
    session,
    destination: () => undefined,
    stop,
    admission,
    wake: vi.fn().mockResolvedValue(undefined),
    specialists,
  });
  services.push(service);
  return { db, service, connect, end, query, admission, stop, session, store };
}
it('G04 retires actual mail work and pinned credentials before releasing the shared pool', async () => {
  const f = fixture(true);
  let release!: () => void;
  const close = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  Object.assign(f.store, { mail: { close } });
  await f.service.tick();
  f.admission.mockReturnValue(false);
  const retiring = f.service.tick();
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(f.end).not.toHaveBeenCalled();
  release();
  await retiring;
  expect(f.end).toHaveBeenCalledOnce();
});
it('G05 drains draft work before closing its shared reader and database pool', async () => {
  const f = fixture(true);
  let release!: () => void;
  const draftClose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    ),
    mailClose = vi.fn(async () => {});
  Object.assign(f.store, { mailDraftHost: { close: draftClose }, mail: { close: mailClose } });
  await f.service.tick();
  f.admission.mockReturnValue(false);
  const retiring = f.service.tick();
  await vi.waitFor(() => expect(draftClose).toHaveBeenCalledOnce());
  expect(mailClose).not.toHaveBeenCalled();
  expect(f.end).not.toHaveBeenCalled();
  release();
  await retiring;
  expect(mailClose).toHaveBeenCalledOnce();
  expect(f.end).toHaveBeenCalledOnce();
  expect(draftClose.mock.invocationCallOrder[0]).toBeLessThan(mailClose.mock.invocationCallOrder[0]);
  expect(mailClose.mock.invocationCallOrder[0]).toBeLessThan(f.end.mock.invocationCallOrder[0]);
});
it('G05 cannot open a replacement reader or pool while draft retirement is uncertain', async () => {
  const f = fixture(true),
    draftClose = vi.fn(async () => {}),
    mailClose = vi.fn(async () => {});
  Object.assign(f.store, { mailDraftHost: { close: draftClose }, mail: { close: mailClose } });
  await f.service.tick();
  draftClose.mockRejectedValue(Error('PRIVATE_DRAFT_RETIREMENT'));
  f.admission.mockReturnValue(false);
  await f.service.tick();
  f.admission.mockReturnValue(true);
  await f.service.tick();
  expect(f.connect).toHaveBeenCalledOnce();
  expect(mailClose).not.toHaveBeenCalled();
  expect(f.end).not.toHaveBeenCalled();
  draftClose.mockResolvedValue();
  await f.service.tick();
  expect(f.connect).toHaveBeenCalledTimes(2);
});
it('G04 retains uncertain mail retirement and never opens a replacement owner over it', async () => {
  const f = fixture(true),
    close = vi.fn(async () => {});
  Object.assign(f.store, { mail: { close } });
  await f.service.tick();
  close.mockRejectedValue(Error('mail_host_retirement_unavailable'));
  f.admission.mockReturnValue(false);
  await f.service.tick();
  f.admission.mockReturnValue(true);
  await f.service.tick();
  expect(f.connect).toHaveBeenCalledOnce();
  expect(f.end).not.toHaveBeenCalled();
  close.mockResolvedValue();
  await f.service.tick();
  expect(f.connect).toHaveBeenCalledTimes(2);
});
function specialist() {
  return { pump: vi.fn(async (_binding: CosBinding) => {}), fenceLocal: vi.fn(), close: vi.fn(async () => {}) };
}
it('reports the failing readiness stage without private errors and deduplicates unchanged failures', async () => {
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
  try {
    const f = fixture(true);
    f.query.mockRejectedValueOnce(Error('PRIVATE_DATABASE_CREDENTIAL_AND_MESSAGE'));
    await f.service.tick();
    expect(f.service.healthStatus()).toMatchObject({ component_phase: 'database_health', admission: 'closed' });
    expect(warn).toHaveBeenCalledWith('CoS readiness check failed', {
      phase: 'database_health',
      readiness: 'UNAVAILABLE',
      reason: 'unreachable',
    });
    f.query.mockRejectedValueOnce(Error('DIFFERENT_PRIVATE_ERROR'));
    await f.service.tick();
    const readinessWarnings = () => warn.mock.calls.filter(([message]) => message === 'CoS readiness check failed');
    expect(readinessWarnings()).toHaveLength(1);
    await f.service.tick();
    expect(f.service.healthStatus()).toMatchObject({ component_phase: 'ready' });
    f.query.mockRejectedValueOnce(Error('PRIVATE_ERROR_AFTER_RECOVERY'));
    await f.service.tick();
    expect(readinessWarnings()).toHaveLength(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE');
  } finally {
    warn.mockRestore();
  }
});
it('distinguishes specialist startup failure from database health without invoking workers', async () => {
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
  try {
    const lifecycle = { ...specialist(), recover: vi.fn().mockRejectedValue(Error('PRIVATE_SPECIALIST_STATE')) };
    const f = fixture(true, () => lifecycle);
    await f.service.tick();
    expect(f.service.healthStatus()).toMatchObject({ component_phase: 'specialist_recovery', admission: 'closed' });
    expect(warn).toHaveBeenCalledWith('CoS readiness check failed', {
      phase: 'specialist_recovery',
      readiness: 'UNAVAILABLE',
      reason: 'unreachable',
    });
    expect(lifecycle.pump).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE');
  } finally {
    warn.mockRestore();
  }
});
it('reports a main-pump fault with a fixed reason and closes admission before cleanup', async () => {
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
  try {
    const f = fixture(true);
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
    installCosBoundary(binding, f.db);
    await f.service.tick();
    vi.spyOn(f.service.runtime, 'pump').mockRejectedValueOnce(TypeError('PRIVATE_PATH_AND_PROMPT'));
    await f.service.tick();
    expect(f.service.healthStatus()).toMatchObject({ component_phase: 'main_pump', admission: 'closed' });
    expect(warn).toHaveBeenCalledWith('CoS readiness check failed', {
      phase: 'main_pump',
      readiness: 'UNAVAILABLE',
      reason: 'host_type_error',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE');
  } finally {
    warn.mockRestore();
  }
});
it('S11-T02/T07 actual main execution stays closed during startup health and after database failure', async () => {
  const f = fixture(true);
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
  f.db
    .prepare('UPDATE cos_identity_boundaries SET paused=0,ingress_id=?,ingress_at=?')
    .run('owner-event', new Date().toISOString());
  f.session.mockReturnValue(session);
  vi.mocked(f.service.dependencies.facts).mockResolvedValue({
    id: 'private',
    type: 'P',
    delete_at: 0,
    members: ['owner', 'bot'],
    activeSubscription: true,
  });
  let release!: () => void;
  f.query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ rows: [{ version: 1 }] });
      }),
  );
  const starting = f.service.tick();
  await vi.waitFor(() => expect(release).toBeDefined());
  try {
    expect(f.service.healthStatus().admission).toBe('closed');
    expect(f.service.runtime.controller.localContext(session)).toBeNull();
  } finally {
    release();
    await starting;
  }
  expect(f.service.runtime.controller.localContext(session)).toMatchObject({ scopeId: 'scope' });
  f.query.mockRejectedValueOnce(Error('PRIVATE_FAILURE'));
  await f.service.tick();
  expect(f.service.healthStatus().admission).toBe('closed');
  expect(f.service.runtime.controller.localContext(session)).toBeNull();
});
it('S11-T09 stale coordinator metadata cannot stop an ordinary native session', async () => {
  const f = fixture(true);
  installCosBoundary(
    {
      scopeId: 'scope',
      agentGroupId: 'owned',
      messagingGroupId: 'owned-mg',
      sessionId: 'main',
      provider: 'codex',
      instanceId: 'fixture',
      channelId: 'private',
      ownerId: 'owner',
      botId: 'bot',
    },
    f.db,
  );
  f.session.mockReturnValue({
    id: 'main',
    agent_group_id: 'ordinary',
    messaging_group_id: 'ordinary-mg',
    agent_provider: 'codex',
    status: 'active',
    thread_id: null,
  } as Session);
  f.connect.mockRejectedValueOnce(Error('fixture unavailable'));
  await f.service.tick();
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT count(*) AS n FROM cos_identity_boundaries').get()).toEqual({ n: 1 });
});
it('S11-T08 host liveness stays distinct from database readiness and incomplete reconciliation', async () => {
  const f = fixture(true);
  f.connect.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_NETWORK'), { code: 'ECONNREFUSED' }));
  await f.service.tick();
  expect(f.service.healthStatus()).toMatchObject({
    host_process_alive: true,
    component_stopped: false,
    admission: 'closed',
    live_activation: 'not_verified',
  });
  expect(JSON.stringify(f.service.healthStatus())).not.toContain('PRIVATE_NETWORK');
  let release!: () => void;
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
  installCosBoundary(binding, f.db);
  // A trusted successful connection is followed by reconciliation before infrastructure readiness.
  const original = f.service.dependencies.specialists;
  f.service.dependencies.specialists = () => ({
    fenceLocal() {},
    async close() {},
    pump: async () => {},
    recover: () =>
      new Promise<void>((r) => {
        release = r;
      }),
  });
  const pending = f.service.tick();
  for (let i = 0; i < 20 && !release; i++) await Promise.resolve();
  expect(f.service.healthStatus()).toMatchObject({
    infrastructure_status: 'reconciling',
    admission: 'closed',
    database_readiness: { state: 'READY' },
  });
  release();
  await pending;
  expect(f.service.healthStatus()).toMatchObject({
    infrastructure_status: 'ready',
    admission: 'eligible_subject_to_scope_authority',
  });
  f.service.dependencies.specialists = original;
});
it('S06-T02/T07 advances specialists before waking the retained main review in the same healthy tick', async () => {
  const worker = specialist(),
    f = fixture(true, () => worker),
    events: string[] = [];
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
  installCosBoundary(binding, f.db);
  worker.pump.mockImplementation(async () => {
    events.push('specialists');
  });
  vi.spyOn(f.service.runtime, 'pump').mockImplementation(async () => {
    events.push('main-review');
  });
  await f.service.tick();
  expect(events).toEqual(['specialists', 'main-review']);
});
it('S05 starts one specialist lifecycle only after successful database health and drains it before releasing the pool', async () => {
  const worker = specialist(),
    create = vi.fn(() => worker),
    f = fixture(true, create);
  f.query.mockRejectedValueOnce(Error('fixture health failure'));
  await f.service.tick();
  expect(create).not.toHaveBeenCalled();
  await f.service.tick();
  await f.service.tick();
  expect(create).toHaveBeenCalledOnce();
  let release!: () => void;
  worker.close.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  f.admission.mockReturnValue(false);
  const draining = f.service.tick();
  await vi.waitFor(() => expect(worker.close).toHaveBeenCalledOnce());
  expect(worker.fenceLocal).toHaveBeenCalled();
  expect(f.end).not.toHaveBeenCalled();
  release();
  await draining;
  expect(f.end).toHaveBeenCalledOnce();
  f.admission.mockReturnValue(true);
  await f.service.tick();
  expect(create).toHaveBeenCalledTimes(2);
});
it('S05 uncertain specialist cleanup cannot be discarded or replaced when database health returns', async () => {
  const worker = specialist(),
    create = vi.fn(() => worker),
    f = fixture(true, create);
  await f.service.tick();
  worker.close.mockRejectedValue(Error('fixture cleanup uncertainty'));
  f.query.mockRejectedValueOnce(Error('fixture health loss'));
  await f.service.tick();
  expect(worker.fenceLocal).toHaveBeenCalled();
  await f.service.tick();
  expect(create).toHaveBeenCalledOnce();
  expect(f.service.status).toBe('unreachable');
  expect(f.end).not.toHaveBeenCalled();
  worker.close.mockResolvedValue();
  await f.service.tick();
  expect(create).toHaveBeenCalledTimes(2);
});
it('S05 shutdown closes specialist admission while a pump is in flight, then waits before pool release', async () => {
  const worker = specialist(),
    create = vi.fn(() => worker),
    f = fixture(true, create);
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
  installCosBoundary(binding, f.db);
  let release!: () => void;
  worker.pump.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const tick = f.service.tick();
  await vi.waitFor(() => expect(worker.pump).toHaveBeenCalledWith(binding));
  const stopping = f.service.stop();
  expect(worker.fenceLocal).toHaveBeenCalled();
  expect(f.end).not.toHaveBeenCalled();
  release();
  await tick;
  await stopping;
  expect(worker.close).toHaveBeenCalledOnce();
  expect(f.end).toHaveBeenCalledOnce();
});
it('S11-PG03 concurrent shutdown callers cannot claim old credential connections are closed before the pool settles', async () => {
  const f = fixture(true);
  await f.service.tick();
  let release!: () => void;
  f.end.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const first = f.service.stop();
  await vi.waitFor(() => expect(f.end).toHaveBeenCalledOnce());
  let secondSettled = false;
  const second = f.service.stop().then(() => {
    secondSettled = true;
  });
  try {
    await new Promise<void>((done) => setImmediate(done));
    expect(secondSettled).toBe(false);
    expect(f.service.healthStatus().admission).toBe('closed');
    await f.service.tick();
    expect(f.connect).toHaveBeenCalledOnce();
  } finally {
    release();
    await first;
    await second;
  }
  expect(f.end).toHaveBeenCalledOnce();
});
it('S11-PG03 an uncertain pool retirement is retained and cannot silently admit replacement credentials', async () => {
  const f = fixture(true);
  await f.service.tick();
  f.end
    .mockRejectedValueOnce(new Error('fixture close uncertainty'))
    .mockRejectedValueOnce(new Error('fixture close uncertainty'));
  try {
    f.admission.mockReturnValue(false);
    await f.service.tick();
    f.admission.mockReturnValue(true);
    await f.service.tick();
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.end).toHaveBeenCalledTimes(2);
    expect(f.service.healthStatus().admission).toBe('closed');
  } finally {
    f.end.mockReset().mockResolvedValue(undefined);
  }
});
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
it.each(['database', 'maintenance', 'initial-connection', 'shutdown'])(
  'S05-PG02 %s durably fences exact specialists before stop without needing PostgreSQL',
  async (failure) => {
    const f = fixture(true);
    const child = (name: string): CosMissionIdentity => ({
      scopeId: 'scope',
      missionId: 'mission-' + name,
      attemptId: 'attempt-' + name,
      generation: 1,
      agentGroupId: 'child-' + name,
      sessionId: 'session-' + name,
      provider: 'codex',
    });
    const first = child('a'),
      second = child('b'),
      malformed = child('corrupt');
    for (const identity of [first, second, malformed]) installCosMissionBoundary(identity, f.db);
    f.db
      .prepare('UPDATE cos_mission_boundaries SET identity=? WHERE attempt_id=?')
      .run('{invalid', malformed.attemptId);
    if (failure !== 'initial-connection') await f.service.tick();
    f.stop.mockImplementation((id) => {
      const identity = [first, second].find((i) => i.sessionId === id)!;
      expect(identity).toBeDefined();
      expect(isCosMissionStopped(identity, f.db)).toBe(true);
      if (id === first.sessionId) throw Error('fixture stop uncertainty');
    });
    if (failure === 'database') f.query.mockRejectedValueOnce(Error('fixture partition'));
    if (failure === 'maintenance') f.admission.mockReturnValue(false);
    if (failure === 'initial-connection') f.connect.mockRejectedValueOnce(Error('fixture unavailable'));
    if (failure === 'shutdown') await f.service.stop();
    else await f.service.tick();
    expect(f.stop.mock.calls.map(([id]) => id)).toEqual([first.sessionId, second.sessionId]);
    expect(isCosMissionStopped(first, f.db)).toBe(true);
    expect(isCosMissionStopped(second, f.db)).toBe(true);
    expect(f.db.prepare('SELECT count(*) AS n FROM cos_mission_boundaries').get()).toEqual({ n: 3 });
  },
);
it('S05-PG02 an inconsistent native session mapping is fenced without stopping a different workspace', async () => {
  const f = fixture(true);
  const identity: CosMissionIdentity = {
    scopeId: 'scope',
    missionId: 'mission',
    attemptId: 'attempt',
    generation: 1,
    agentGroupId: 'owned-child',
    sessionId: 'child-session',
    provider: 'codex',
  };
  installCosMissionBoundary(identity, f.db);
  f.session.mockReturnValue({ id: identity.sessionId, agent_group_id: 'unrelated-workspace' } as Session);
  f.connect.mockRejectedValueOnce(Error('fixture unavailable'));
  await f.service.tick();
  expect(isCosMissionStopped(identity, f.db)).toBe(true);
  expect(f.stop).not.toHaveBeenCalled();
});
