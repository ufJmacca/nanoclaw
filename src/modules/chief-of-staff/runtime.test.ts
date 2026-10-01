import { afterEach, expect, it, vi } from 'vitest';
import { initTestDb, closeDb } from '../../db/connection.js';
import {
  installCosBoundary,
  prepareCosLaunch,
  permitCosOutbound,
  type CosBinding,
  type CosLaunch,
} from '../../cos-boundary.js';
import type { Session } from '../../types.js';
import type { PriorityStore } from './store/priorities.js';
import { createCosRuntime } from './runtime.js';
import { randomUUID } from 'node:crypto';
import { ensureConversationSchema } from './bridge/conversation-state.js';
import { installScheduledOrigin } from './automation/scheduled-origin.js';
import type { TurnAuthorization } from './bridge/turn-authorization.js';
import { digest } from './domain/contracts.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { NativeBriefTasks } from './automation/native-tasks.js';
import Database from 'better-sqlite3';
import { INBOUND_SCHEMA } from '../../db/schema.js';
import { readScheduledLease } from './automation/scheduled-origin.js';

let runtime: ReturnType<typeof createCosRuntime> | undefined;
afterEach(() => {
  runtime?.dispose();
  closeDb();
  vi.useRealTimers();
});
it('S02 checks current source authority before native admission and prepared private output', async () => {
  const db = initTestDb();
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
  db.prepare('UPDATE cos_identity_boundaries SET paused=0,ingress_id=?,ingress_at=?').run(
    'ingress',
    new Date().toISOString(),
  );
  db.prepare(
    "INSERT INTO cos_conversation_states(scope_id,binding_digest,account_fingerprint,generation,status,updated_at) VALUES(?,?,?,?,'active',?)",
  ).run(binding.scopeId, digest(binding), 'a'.repeat(64), randomUUID(), new Date().toISOString());
  const briefArtifacts = { authorizePublication: vi.fn().mockResolvedValue({ status: 'denied' }) };
  const knowledge = {
    contextReady: vi.fn().mockResolvedValue({ status: 'ok' }),
    answers: { authorizePublication: vi.fn().mockResolvedValue({ status: 'ok' }) },
  };
  let authorize!: (mode?: 'poll') => Promise<string | null>;
  runtime = createCosRuntime({
    db,
    enabled: true,
    store: {
      context: vi.fn().mockResolvedValue({ status: 'ok' }),
      knowledge,
      briefArtifacts,
    } as unknown as PriorityStore,
    facts: async () => ({
      id: 'private',
      type: 'P',
      delete_at: 0,
      members: ['bot', 'owner'],
      activeSubscription: true,
    }),
    session: () => session,
    destination: () => undefined,
    stop: vi.fn(),
    wake: vi.fn(),
    launcher: {
      ready: () => true,
      prepare: async (_binding, _session, check) => {
        authorize = check;
        return {} as CosLaunch;
      },
    },
  });
  await prepareCosLaunch(session);
  expect(await authorize()).toBe('ingress');
  const message = {
    kind: 'chat',
    channel_type: 'mattermost',
    platform_id: 'mattermost:fixture:private',
    thread_id: 'visual-reply',
    content: JSON.stringify({ text: 'Previously prepared source answer' }),
  };
  expect(await permitCosOutbound(session, message)).toBe(true);
  expect(knowledge.answers.authorizePublication).toHaveBeenCalledWith(
    expect.objectContaining({ scopeId: 'scope', sessionId: 'session', ingressId: 'ingress', provider: 'codex' }),
    'Previously prepared source answer',
  );
  knowledge.answers.authorizePublication.mockResolvedValue({ status: 'denied' });
  expect(
    await permitCosOutbound(session, { ...message, content: JSON.stringify({ text: 'Unprepared private canary' }) }),
  ).toBe(false);
  briefArtifacts.authorizePublication.mockResolvedValue({ status: 'ok' });
  expect(await permitCosOutbound(session, message)).toBe(true);
  expect(briefArtifacts.authorizePublication).toHaveBeenCalledWith(
    expect.objectContaining({ scopeId: 'scope', sessionId: 'session' }),
    'Previously prepared source answer',
  );
  briefArtifacts.authorizePublication.mockResolvedValue({ status: 'denied' });
  knowledge.answers.authorizePublication.mockResolvedValue({ status: 'unavailable' });
  expect(await permitCosOutbound(session, message)).toBe(false);
  knowledge.answers.authorizePublication.mockResolvedValue({ status: 'ok' });
  knowledge.answers.authorizePublication.mockImplementationOnce(async () => {
    db.prepare('UPDATE cos_identity_boundaries SET ingress_id=?').run('new-ingress');
    return { status: 'ok' };
  });
  expect(await permitCosOutbound(session, message)).toBe(false);
  db.prepare('UPDATE cos_identity_boundaries SET ingress_id=?').run('ingress');
  knowledge.contextReady.mockResolvedValue({ status: 'denied' });
  expect(await authorize()).toBeNull();
  expect(await permitCosOutbound(session, message)).toBe(false);
  knowledge.contextReady.mockResolvedValue({ status: 'unavailable' });
  expect(await permitCosOutbound(session, message)).toBe(false);
  knowledge.contextReady.mockImplementation(async () => {
    db.prepare('UPDATE cos_conversation_states SET generation=?').run(randomUUID());
    return { status: 'ok' };
  });
  expect(await permitCosOutbound(session, message)).toBe(false);
  expect(await authorize()).toBeNull();
});
it('keeps egress polling local between bounded remote checks while new admissions stay fresh', async () => {
  vi.useFakeTimers();
  const db = initTestDb();
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
  db.prepare('UPDATE cos_identity_boundaries SET paused=0, ingress_id=?, ingress_at=?').run(
    'ingress',
    new Date().toISOString(),
  );
  const facts = vi.fn(async () => ({
    id: 'private',
    type: 'P',
    delete_at: 0,
    members: ['bot', 'owner'],
    activeSubscription: true,
  }));
  const context = vi.fn(async () => ({ status: 'ok' }));
  let authorize!: (mode?: 'poll') => Promise<string | null>;
  runtime = createCosRuntime({
    db,
    enabled: true,
    store: { context } as unknown as PriorityStore,
    facts,
    session: () => session,
    destination: () => undefined,
    stop: vi.fn(),
    wake: vi.fn(),
    launcher: {
      ready: () => true,
      prepare: async (_binding, _session, check) => {
        authorize = check;
        return {} as CosLaunch;
      },
    },
  });
  await prepareCosLaunch(session);
  expect(await authorize()).toBe('ingress');
  for (let i = 0; i < 120; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    expect(await authorize('poll')).toBe('ingress');
  }
  expect(facts).toHaveBeenCalledTimes(9);
  expect(context).toHaveBeenCalledTimes(9);
  // New admission must not use the cached remote membership, even in the same second.
  facts.mockResolvedValue({
    id: 'private',
    type: 'P',
    delete_at: 0,
    members: ['bot', 'owner', 'stranger'],
    activeSubscription: true,
  });
  expect(await authorize()).toBeNull();
  expect(await authorize('poll')).toBeNull();
  expect(facts).toHaveBeenCalledTimes(10);
});
it('revokes model authorization when emergency pause arrives during the database check', async () => {
  const db = initTestDb();
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
  db.prepare('UPDATE cos_identity_boundaries SET paused=0, ingress_id=?, ingress_at=?').run(
    'ingress',
    new Date().toISOString(),
  );
  let authorization: string | null | undefined;
  const store = {
    context: vi.fn(async () => {
      db.exec('UPDATE cos_identity_boundaries SET paused=1');
      return { status: 'ok' };
    }),
  } as unknown as PriorityStore;
  runtime = createCosRuntime({
    db,
    enabled: true,
    store,
    facts: async () => ({
      id: 'private',
      type: 'P',
      delete_at: 0,
      members: ['bot', 'owner'],
      activeSubscription: true,
    }),
    session: () => session,
    destination: () => undefined,
    stop: vi.fn(),
    wake: vi.fn(),
    launcher: {
      ready: () => true,
      prepare: async (_binding, _session, authorize) => {
        authorization = await authorize();
        return {} as CosLaunch;
      },
    },
  });
  await expect(prepareCosLaunch(session)).rejects.toThrow('restricted_launch_denied');
  expect(store.context).toHaveBeenCalledOnce();
  expect(authorization).toBeNull();
});
it('S02 processes due retention work while paused without admitting ordinary outbox or model work', async () => {
  const db = initTestDb();
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
  const knowledge = {
    pendingInvalidations: vi.fn().mockResolvedValue({ status: 'ok', items: [] }),
    purgeDue: vi.fn().mockResolvedValue({ status: 'ok', processed: 0 }),
  };
  const pendingOutbox = vi.fn(),
    wake = vi.fn();
  runtime = createCosRuntime({
    db,
    enabled: true,
    store: { knowledge, pendingOutbox } as unknown as PriorityStore,
    facts: vi.fn(),
    session: () => session,
    destination: () => undefined,
    stop: vi.fn(),
    wake,
  });
  await runtime.pump(binding);
  expect(knowledge.purgeDue).toHaveBeenCalledWith('scope');
  expect(pendingOutbox).not.toHaveBeenCalled();
  expect(wake).not.toHaveBeenCalled();
  expect(db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
});

it.each(['existing', 'due'])(
  'S04 wires %s scheduled work, checked delivery and retirement into the host pump',
  async (mode) => {
    const db = initTestDb();
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
    db.exec("UPDATE cos_identity_boundaries SET paused=0,ingress_id='owner-before'");
    ensureConversationSchema(db);
    const generation = randomUUID();
    db.prepare(
      "INSERT INTO cos_conversation_states(scope_id,binding_digest,account_fingerprint,generation,status,updated_at) VALUES(?,?,?,?,'active',?)",
    ).run(binding.scopeId, digest(binding), 'a'.repeat(64), generation, new Date().toISOString());
    const lease = {
      runId: 'b'.repeat(64),
      generation: 1,
      hostId: 'host',
      deadlineAt: new Date(Date.now() + 120000).toISOString(),
    };
    if (mode === 'existing') expect(installScheduledOrigin(db, binding, session, lease)).toBe(true);
    const run = {
      id: lease.runId,
      generation: 1,
      lease_owner: 'host',
      state: mode === 'existing' ? 'prepared' : 'queued',
      schedule_id: 'schedule',
      schedule_version: 1,
      intended_at: new Date().toISOString(),
      limits: { refresh_seconds: 0 },
      deadline_at: lease.deadlineAt,
    };
    const reference = {
      artifact_id: 'a'.repeat(64) + '-' + 'b'.repeat(64),
      output_digest: digest('Checked scheduled brief'),
      context_generation: generation,
      provider: 'codex',
    };
    const briefs = {
      reserveDue: vi.fn(async () => ({ status: 'ok', run: { ...run } })),
      claim: vi.fn(async (_c, _id, host) => {
        run.state = 'dispatched';
        run.lease_owner = host;
        return { status: 'ok', generation: 1, deadline_at: lease.deadlineAt };
      }),
      inspect: vi.fn(async () => ({ status: 'ok', run: { ...run }, notification: { state: 'queued' } })),
      authorize: vi.fn().mockResolvedValue({ status: 'ok' }),
      beginDelivery: vi.fn().mockResolvedValue({ status: 'ok', notification_id: 'brief-' + run.id, reference }),
      deliveryCurrent: vi.fn().mockResolvedValue({ status: 'ok' }),
      finishDelivery: vi.fn(async (_c, _r, _g, _a, outcome) => {
        run.state = outcome.state;
        return { status: 'ok', state: outcome.state };
      }),
    };
    const knowledge = {
      contextReady: vi.fn().mockResolvedValue({ status: 'ok' }),
      pendingInvalidations: vi.fn().mockResolvedValue({ status: 'ok', items: [] }),
      purgeDue: vi.fn().mockResolvedValue({ status: 'ok' }),
    };
    const briefArtifacts = {
      get: vi
        .fn()
        .mockResolvedValue({ status: 'ok', artifact_id: reference.artifact_id, text: 'Checked scheduled brief' }),
    };
    const inbound = new Database(':memory:');
    inbound.exec(INBOUND_SCHEMA);
    const tasks = new NativeBriefTasks(inbound);
    if (mode === 'existing') tasks.stage(binding, run);
    const deliver = vi.fn().mockResolvedValue('verified-post');
    setDeliveryAdapter({ deliver });
    const stop = vi.fn(),
      wake = vi.fn();
    try {
      runtime = createCosRuntime({
        db,
        enabled: true,
        store: {
          briefs,
          knowledge,
          briefArtifacts,
          pendingOutbox: vi.fn().mockResolvedValue({ status: 'ok', items: [] }),
        } as unknown as PriorityStore,
        facts: async () => ({
          id: 'private',
          type: 'P',
          delete_at: 0,
          members: ['bot', 'owner'],
          activeSubscription: true,
        }),
        session: () => session,
        destination: () => undefined,
        stop,
        wake,
        running: () => false,
        withBriefTasks: (_session, operation) => operation(tasks),
        launcher: { ready: () => true, prepare: vi.fn() },
      });
      await runtime.pump(binding);
      if (mode === 'due') {
        expect(briefs.reserveDue).toHaveBeenCalledOnce();
        expect(wake).toHaveBeenCalledOnce();
        expect(deliver).not.toHaveBeenCalled();
        expect(tasks.state(binding, run)).toBe('pending');
        run.state = 'prepared';
        await runtime.pump(binding);
      }
      expect(deliver).toHaveBeenCalledExactlyOnceWith(
        'mattermost',
        'mattermost:fixture:private',
        null,
        'chat',
        JSON.stringify({ text: 'Checked scheduled brief' }),
        undefined,
        'brief-' + run.id,
      );
      await runtime.pump(binding);
      expect(deliver).toHaveBeenCalledOnce();
      expect(tasks.state(binding, run)).toBe('completed');
      expect(stop).toHaveBeenCalledWith('session');
      expect(readScheduledLease(db, binding)).toBeNull();
    } finally {
      inbound.close();
    }
  },
);

it('S04 wires shared-context scheduled admission and model budgets while withholding ordinary chat publication', async () => {
  const db = initTestDb();
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
  db.exec('UPDATE cos_identity_boundaries SET paused=0');
  ensureConversationSchema(db);
  const generation = randomUUID();
  db.prepare(
    "INSERT INTO cos_conversation_states(scope_id,binding_digest,account_fingerprint,generation,status,updated_at) VALUES(?,?,?,?,'active',?)",
  ).run(binding.scopeId, digest(binding), 'a'.repeat(64), generation, new Date().toISOString());
  const lease = {
    runId: 'b'.repeat(64),
    generation: 1,
    hostId: 'host',
    deadlineAt: new Date(Date.now() + 120000).toISOString(),
  };
  expect(installScheduledOrigin(db, binding, session, lease)).toBe(true);
  const briefs = {
    authorize: vi.fn().mockResolvedValue({ status: 'ok' }),
    reserveCall: vi.fn().mockResolvedValue({ status: 'ok' }),
  };
  const knowledge = {
    contextReady: vi.fn().mockResolvedValue({ status: 'ok' }),
    answers: { authorizePublication: vi.fn().mockResolvedValue({ status: 'ok' }) },
  };
  let authorize!: TurnAuthorization;
  runtime = createCosRuntime({
    db,
    enabled: true,
    store: { briefs, knowledge, context: vi.fn().mockResolvedValue({ status: 'ok' }) } as unknown as PriorityStore,
    facts: async () => ({
      id: 'private',
      type: 'P',
      delete_at: 0,
      members: ['bot', 'owner'],
      activeSubscription: true,
    }),
    session: () => session,
    destination: () => undefined,
    stop: vi.fn(),
    wake: vi.fn(),
    launcher: {
      ready: () => true,
      prepare: async (_binding, _session, check) => {
        authorize = check;
        return {} as CosLaunch;
      },
    },
  });
  await prepareCosLaunch(session);
  expect(await authorize()).toBe(`brief:${lease.runId}:1`);
  expect(knowledge.contextReady).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session', generation }));
  expect(await authorize.reserve!('attempt')).toBe(true);
  expect(briefs.reserveCall).toHaveBeenCalledWith(
    expect.objectContaining({ origin: { kind: 'schedule', runId: lease.runId, generation: 1 } }),
    lease.runId,
    1,
    'model',
    'attempt',
  );
  briefs.reserveCall.mockResolvedValue({ status: 'pending' });
  expect(await authorize.reserve!('lost')).toBe(false);
  expect(
    await permitCosOutbound(session, {
      kind: 'chat',
      channel_type: 'mattermost',
      platform_id: 'mattermost:fixture:private',
      thread_id: null,
      content: JSON.stringify({ text: 'Untracked scheduled brief' }),
    }),
  ).toBe(false);
  expect(knowledge.answers.authorizePublication).not.toHaveBeenCalled();
  briefs.authorize.mockResolvedValue({ status: 'denied' });
  expect(await authorize()).toBeNull();
});
