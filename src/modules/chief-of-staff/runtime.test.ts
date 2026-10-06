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
import { getDeliveryAdapter, setDeliveryAdapter } from '../../delivery.js';
import { NativeBriefTasks } from './automation/native-tasks.js';
import Database from 'better-sqlite3';
import { INBOUND_SCHEMA } from '../../db/schema.js';
import { readScheduledLease } from './automation/scheduled-origin.js';
import { installReviewOrigin } from './missions/review-origin.js';
import * as delivery from '../../delivery.js';
import { installCosMissionBoundary, type CosMissionIdentity } from '../../cos-mission-boundary.js';
import { isCosMissionStopped } from '../../cos-mission-stop.js';
import { NativeMandateTasks } from './automation/mandate-native.js';

let runtime: ReturnType<typeof createCosRuntime> | undefined;
it('S11-UI01 the outage-only host acknowledges pause privately without a database or model and does not resend a replay', async () => {
  const db = initTestDb(),
    binding: CosBinding = {
      scopeId: 'offline-scope',
      ownerId: 'owner',
      botId: 'bot',
      instanceId: 'fixture',
      channelId: 'private',
      agentGroupId: 'offline-group',
      messagingGroupId: 'offline-mg',
      sessionId: 'offline-session',
      provider: 'codex',
    };
  const session = {
    id: binding.sessionId,
    agent_group_id: binding.agentGroupId,
    messaging_group_id: binding.messagingGroupId,
    thread_id: null,
    status: 'active',
    agent_provider: 'codex',
  } as Session;
  installCosBoundary(binding, db);
  db.prepare('UPDATE cos_identity_boundaries SET paused=0').run();
  const send = vi.fn().mockResolvedValue('fixture-control-receipt'),
    wake = vi.fn(),
    stop = vi.fn();
  vi.spyOn(delivery, 'getDeliveryAdapter').mockReturnValue({ deliver: send } as unknown as ReturnType<
    typeof getDeliveryAdapter
  >);
  runtime = createCosRuntime({
    db,
    enabled: false,
    facts: async () => ({
      id: 'private',
      type: 'P',
      delete_at: 0,
      members: ['owner', 'bot'],
      activeSubscription: true,
    }),
    session: () => session,
    destination: () => undefined,
    stop,
    wake,
  });
  const event = {
    channelType: 'mattermost',
    platformId: 'mattermost:fixture:private',
    threadId: null,
    message: {
      id: 'owner-offline-pause',
      kind: 'chat' as const,
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ senderId: 'mattermost:owner', text: 'cos pause admission' }),
    },
  };
  await runtime.controller.ingress(binding, event);
  await runtime.controller.ingress(binding, event);
  expect(stop).toHaveBeenCalledWith(binding.sessionId);
  expect(wake).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0].slice(0, 4)).toEqual(['mattermost', 'mattermost:fixture:private', null, 'chat']);
  expect(JSON.parse(send.mock.calls[0][4]).text).toContain('CoS admission paused.');
  expect(send.mock.calls[0][6]).toMatch(/^cos-control-[a-f0-9]{64}$/);
  expect(db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
});
it('S11-UI01 the paused host answers owner status without a model, using fresh database authority and a stable private delivery', async () => {
  const db = initTestDb(),
    binding: CosBinding = {
      scopeId: 'status-scope',
      agentGroupId: 'status-group',
      messagingGroupId: 'status-mg',
      sessionId: 'status-session',
      provider: 'codex',
      instanceId: 'fixture',
      channelId: 'private',
      ownerId: 'owner',
      botId: 'bot',
    };
  const session = {
    id: binding.sessionId,
    agent_group_id: binding.agentGroupId,
    messaging_group_id: binding.messagingGroupId,
    thread_id: null,
    status: 'active',
    agent_provider: 'codex',
  } as Session;
  installCosBoundary(binding, db);
  const status = {
    status: 'ok',
    format: 'cos-operator-status/v1',
    execution_authority: 'inspection_only',
    categories: [{ category: 'missions', states: { running: 1 } }],
    items: [],
    category: null,
  };
  const operatorStatus = vi.fn().mockResolvedValue(status),
    send = vi.fn().mockResolvedValue('fixture-status-receipt'),
    wake = vi.fn();
  vi.spyOn(delivery, 'getDeliveryAdapter').mockReturnValue({ deliver: send } as unknown as ReturnType<
    typeof getDeliveryAdapter
  >);
  runtime = createCosRuntime({
    db,
    enabled: false,
    store: { operatorStatus, pendingOutbox: vi.fn() } as unknown as PriorityStore,
    facts: async () => ({
      id: 'private',
      type: 'P',
      delete_at: 0,
      members: ['owner', 'bot'],
      activeSubscription: true,
    }),
    session: () => session,
    destination: () => undefined,
    stop: vi.fn(),
    wake,
  });
  const event = {
    channelType: 'mattermost',
    platformId: 'mattermost:fixture:private',
    threadId: null,
    message: {
      id: 'owner-status-one',
      kind: 'chat' as const,
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ senderId: 'mattermost:owner', text: 'cos status' }),
    },
  };
  await runtime.controller.ingress(binding, event);
  expect(send).toHaveBeenCalledOnce();
  expect(operatorStatus).toHaveBeenCalledTimes(2);
  expect(wake).not.toHaveBeenCalled();
  expect(send.mock.calls[0].slice(0, 4)).toEqual(['mattermost', 'mattermost:fixture:private', null, 'chat']);
  expect(JSON.parse(send.mock.calls[0][4]).text).toContain('CoS status — admission paused');
  const stableId = send.mock.calls[0][6];
  expect(stableId).toMatch(/^cos-status-[a-f0-9]{64}$/);
  await runtime.controller.ingress(binding, event);
  expect(send).toHaveBeenCalledOnce();
  operatorStatus.mockResolvedValueOnce(status).mockResolvedValueOnce({ status: 'unavailable' });
  await runtime.controller.ingress(binding, { ...event, message: { ...event.message, id: 'owner-status-outage' } });
  expect(JSON.parse(send.mock.calls[1][4]).text).toContain('Status unavailable');
  expect(JSON.parse(send.mock.calls[1][4]).text).not.toContain('running: 1');
  expect(db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
});
afterEach(() => {
  runtime?.dispose();
  closeDb();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('S09 pumps approved actions in the retained main context after the owner trigger expires without waking a model', async () => {
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
  db.prepare('UPDATE cos_identity_boundaries SET paused=0,ingress_id=?,ingress_at=?').run(
    'expired-owner-trigger',
    new Date(Date.now() - 360000).toISOString(),
  );
  ensureConversationSchema(db);
  const generation = randomUUID();
  db.prepare(
    "INSERT INTO cos_conversation_states(scope_id,binding_digest,account_fingerprint,generation,status,updated_at) VALUES(?,?,?,?,'active',?)",
  ).run(binding.scopeId, digest(binding), 'a'.repeat(64), generation, new Date().toISOString());
  const actionId = 'action-' + 'c'.repeat(64),
    wake = vi.fn(),
    send = vi.fn(async () => 'fixture-result-receipt'),
    projectActionNotice = vi.fn();
  vi.spyOn(delivery, 'getDeliveryAdapter').mockReturnValue({ deliver: send } as unknown as ReturnType<
    typeof getDeliveryAdapter
  >);
  const text = 'Calendar block verified. No guests.',
    notice = {
      format: 'cos-action-notification/v1',
      scopeId: 'scope',
      ownerId: 'owner',
      sessionId: 'session',
      agentGroupId: 'group',
      instanceId: 'fixture',
      channelId: 'private',
      actionId,
      intentDigest: 'a'.repeat(64),
      state: 'verified',
      textDigest: digest(text),
    };
  const actions = {
    dependencies: { witness: { consumeNotification: vi.fn(() => true) } },
    runs: {
      recoverWitnesses: vi.fn(async () => ({ status: 'ok', recovered: [], next_offset: null })),
      pending: vi.fn(async () => ({ status: 'ok', action_ids: [actionId], next_after: null })),
    },
    executor: { run: vi.fn(async () => ({ status: 'ok', state: 'verified' })) },
    notifications: {
      pending: vi.fn(async () => ({ status: 'ok', action_ids: [actionId], next_after: null })),
      read: vi.fn(async () => ({ status: 'ok', notice, text })),
    },
  };
  runtime = createCosRuntime({
    db,
    enabled: true,
    store: { actions, pendingOutbox: vi.fn(async () => ({ status: 'ok', items: [] })) } as unknown as PriorityStore,
    facts: async () => ({
      id: 'private',
      type: 'P',
      delete_at: 0,
      members: ['owner', 'bot'],
      activeSubscription: true,
    }),
    session: () => session,
    destination: () => undefined,
    stop: vi.fn(),
    wake,
    projectActionNotice,
  });
  await runtime.pump(binding);
  expect(actions.executor.run).toHaveBeenCalledTimes(1);
  const [context, , permit] = actions.executor.run.mock.calls[0] as unknown as [
    Record<string, unknown>,
    string,
    { local(): boolean; admitted(): Promise<boolean>; signal: AbortSignal },
  ];
  expect(context).toMatchObject({
    scopeId: 'scope',
    sessionId: 'session',
    generation,
    ingressId: 'expired-owner-trigger',
  });
  expect(context.origin).toBeUndefined();
  expect(wake).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(
    'mattermost',
    'mattermost:fixture:private',
    null,
    'chat',
    JSON.stringify({ text }),
    undefined,
    expect.stringMatching(/^cos-action-[a-f0-9]{64}$/),
  );
  expect(projectActionNotice).toHaveBeenCalledTimes(1);
  expect(permit.local()).toBe(true);
  db.prepare('UPDATE cos_identity_boundaries SET paused=1').run();
  expect(permit.local()).toBe(false);
  expect(await permit.admitted()).toBe(false);
  await runtime.pump(binding);
  expect(actions.executor.run).toHaveBeenCalledTimes(1);
  runtime.dispose();
  expect(permit.signal.aborted).toBe(true);
});
it('S08 uses the existing host pump for mandate clocks and keeps the main session paused after an emergency stop', async () => {
  const db = initTestDb(),
    inbound = new Database(':memory:');
  inbound.exec(INBOUND_SCHEMA);
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
  db.prepare('UPDATE cos_identity_boundaries SET paused=0').run();
  const order: string[] = [];
  const mandates = {
    headsForHost: vi.fn(async () => {
      order.push('mandates');
      return { status: 'ok', heads: [], next_after: null };
    }),
    bindNative: vi.fn(),
    evaluate: vi.fn(),
  };
  const wake = vi.fn();
  runtime = createCosRuntime({
    db,
    enabled: true,
    store: {
      mandates,
      pendingOutbox: vi.fn(async () => {
        order.push('outbox');
        return { status: 'ok', items: [] };
      }),
    } as unknown as PriorityStore,
    facts: async () => ({
      id: 'private',
      type: 'P',
      delete_at: 0,
      members: ['owner', 'bot'],
      activeSubscription: true,
    }),
    session: () => session,
    destination: () => undefined,
    stop: vi.fn(),
    wake,
    withMandateTasks: (_session, operation) => operation(new NativeMandateTasks(inbound)),
  });
  try {
    await runtime.pump(binding);
    expect(order).toEqual(['outbox', 'mandates']);
    expect(wake).not.toHaveBeenCalled();
    db.prepare('UPDATE cos_identity_boundaries SET paused=1').run();
    await runtime.pump(binding);
    expect(mandates.headsForHost).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
  } finally {
    inbound.close();
  }
});
it.each([false, true])('S06-T06 runtime cancels the entire team with never-allocated proof %s', async (unallocated) => {
  const db = initTestDb(),
    teamId = 'team-' + 'a'.repeat(64);
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
  db.prepare('UPDATE cos_identity_boundaries SET paused=0,ingress_id=?,ingress_at=?').run(
    'owner-cancel',
    new Date().toISOString(),
  );
  const child: CosMissionIdentity = {
    scopeId: 'scope',
    missionId: 'child-mission',
    attemptId: 'attempt',
    generation: 1,
    agentGroupId: 'worker',
    sessionId: 'worker-session',
    provider: 'codex',
  };
  if (!unallocated) installCosMissionBoundary(child, db);
  let present = true;
  const missionExecution = {
    unallocated: vi.fn(() => unallocated),
    running: vi.fn(() => present),
    stop: vi.fn(async (identity: CosMissionIdentity) => {
      expect(identity).toEqual(child);
      expect(isCosMissionStopped(child, db)).toBe(true);
      present = false;
    }),
  };
  const teamRuns = {
    cancel: vi.fn(async () => ({ status: 'ok', state: 'cancelling', identities: [child] })),
    confirmCancellation: vi.fn(async () => ({ status: 'ok', team_id: teamId, state: 'cancelled' })),
  };
  const missionRuns = {
    confirmStopped: vi.fn(async () => ({ status: 'ok' })),
    cancel: vi.fn(),
    confirmUnallocatedCancellation: vi.fn(async () => {
      expect(isCosMissionStopped(child, db)).toBe(true);
      return { status: 'ok', never_allocated: true };
    }),
  };
  const register = vi.spyOn(delivery, 'registerDeliveryAction').mockImplementation(() => {});
  let ready = false;
  runtime = createCosRuntime({
    db,
    enabled: true,
    admission: () => ready,
    store: { teamRuns, missionRuns } as unknown as PriorityStore,
    missionExecution,
    facts: async () => ({
      id: 'private',
      type: 'P',
      delete_at: 0,
      members: ['owner', 'bot'],
      activeSubscription: true,
    }),
    session: () => session,
    destination: () => undefined,
    stop: vi.fn(),
    wake: vi.fn(),
  });
  const handler = register.mock.calls.find(([action]) => action === 'cos_rpc')![1],
    requestId = randomUUID();
  expect(runtime.controller.localContext(session)).toBeNull();
  ready = true;
  await handler(
    {
      action: 'cos_rpc',
      delivery_id: randomUUID(),
      request: {
        protocol: 'cos-rpc/v1',
        request_id: requestId,
        method: 'cos_team_cancel',
        params: { team_id: teamId },
      },
    },
    session,
    db,
  );
  expect(teamRuns.cancel).toHaveBeenCalledWith(
    expect.objectContaining({ ownerId: 'owner', ingressId: 'owner-cancel' }),
    teamId,
  );
  expect(missionExecution.stop).toHaveBeenCalledTimes(unallocated ? 0 : 1);
  expect(missionRuns.confirmStopped).toHaveBeenCalledTimes(unallocated ? 0 : 1);
  if (unallocated)
    expect(missionRuns.confirmUnallocatedCancellation).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'owner', ingressId: 'owner-cancel' }),
      child,
    );
  else expect(missionRuns.confirmStopped).toHaveBeenCalledWith(child);
  expect(teamRuns.confirmCancellation).toHaveBeenCalledTimes(1);
  expect(missionRuns.cancel).not.toHaveBeenCalled();
  const saved = JSON.parse(
    (db.prepare('SELECT response FROM cos_rpc_responses WHERE request_id=?').get(requestId) as { response: string })
      .response,
  );
  expect(saved).toMatchObject({ status: 'ok', result: { state: 'cancelled' } });
  expect(JSON.stringify(saved)).not.toContain('worker-session');
});
it('S05 delivers an approved mission notification after owner ingress expires without renewing model authority', async () => {
  const db = initTestDb(),
    generation = randomUUID();
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
    'old-owner-event',
    new Date(Date.now() - 600000).toISOString(),
  );
  db.prepare(
    "INSERT INTO cos_conversation_states(scope_id,binding_digest,account_fingerprint,generation,status,updated_at) VALUES(?,?,?,?,'active',?)",
  ).run(binding.scopeId, digest(binding), 'a'.repeat(64), generation, new Date().toISOString());
  const notifications = {
    pending: vi.fn().mockResolvedValue({ status: 'ok', review_ids: ['review'] }),
    begin: vi.fn().mockResolvedValue({ status: 'ok', notification_id: 'mission-review-review' }),
    read: vi.fn().mockResolvedValue({ status: 'ok', text: 'Reviewed result' }),
    finish: vi.fn().mockResolvedValue({ status: 'ok', state: 'delivered' }),
  };
  const facts = vi.fn(async () => ({
    id: 'private',
    type: 'P',
    delete_at: 0,
    members: ['owner', 'bot'],
    activeSubscription: true,
  }));
  const deliver = vi.fn().mockResolvedValue('verified-post');
  const previousAdapter = getDeliveryAdapter();
  setDeliveryAdapter({ deliver });
  runtime = createCosRuntime({
    db,
    enabled: true,
    store: {
      pendingOutbox: vi.fn().mockResolvedValue({ status: 'ok', items: [] }),
      missionNotifications: notifications,
    } as unknown as PriorityStore,
    session: () => session,
    destination: () => undefined,
    facts,
    stop: vi.fn(),
    wake: vi.fn(),
  });
  try {
    expect(runtime.controller.localContext(session)).toBeNull();
    await runtime.pump(binding);
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      'mattermost',
      'mattermost:fixture:private',
      null,
      'chat',
      JSON.stringify({ text: 'Reviewed result' }),
      undefined,
      'mission-review-review',
    );
    expect(runtime.controller.localContext(session)).toBeNull();
    expect(notifications.read).toHaveBeenCalledWith(
      expect.objectContaining({ generation, ingressId: 'old-owner-event' }),
      'review',
      expect.any(String),
    );
    deliver.mockClear();
    // Pause and private membership remain delivery gates regardless of age.
    db.prepare('UPDATE cos_identity_boundaries SET paused=1').run();
    await runtime.pump(binding);
    expect(deliver).not.toHaveBeenCalled();
    db.prepare('UPDATE cos_identity_boundaries SET paused=0').run();
    facts.mockResolvedValue({
      id: 'private',
      type: 'P',
      delete_at: 0,
      members: ['owner', 'bot', 'foreign'],
      activeSubscription: true,
    });
    await runtime.pump(binding);
    expect(deliver).not.toHaveBeenCalled();
    facts.mockResolvedValue({
      id: 'private',
      type: 'P',
      delete_at: 0,
      members: ['owner', 'bot'],
      activeSubscription: true,
    });
    expect(
      installReviewOrigin(db, binding, session, {
        identity: {
          missionId: 'mission',
          submissionId: randomUUID(),
          attemptId: randomUUID(),
          generation: 1,
          sessionId: session.id,
          contextGeneration: generation,
        },
        lease: { owner: 'host', fence: 1 },
        deadlineAt: new Date(Date.now() + 30000).toISOString(),
      }),
    ).toBe(true);
    await runtime.pump(binding);
    expect(deliver).not.toHaveBeenCalled();
    // Even an interrupted/malformed origin retains its closed fence.
    db.prepare("UPDATE cos_mission_review_origins SET grant_json='invalid',interrupted=1").run();
    await runtime.pump(binding);
    expect(deliver).not.toHaveBeenCalled();
    db.prepare('DELETE FROM cos_mission_review_origins').run();
    notifications.read.mockImplementation(async () => {
      db.prepare('UPDATE cos_conversation_states SET generation=?').run(randomUUID());
      return { status: 'ok', text: 'Must not be sent from the old context' };
    });
    await runtime.pump(binding);
    expect(deliver).not.toHaveBeenCalled();
  } finally {
    setDeliveryAdapter(previousAdapter ?? { deliver: async () => undefined, isAvailable: () => false });
  }
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
  const reviewArtifacts = { authorizePublication: vi.fn().mockResolvedValue({ status: 'denied' }) };
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
      reviewArtifacts,
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
  reviewArtifacts.authorizePublication.mockResolvedValue({ status: 'ok' });
  expect(await permitCosOutbound(session, message)).toBe(true);
  expect(reviewArtifacts.authorizePublication).toHaveBeenCalledWith(
    expect.objectContaining({ scopeId: 'scope', sessionId: 'session', ingressId: 'ingress' }),
    'Previously prepared source answer',
  );
  briefArtifacts.authorizePublication.mockResolvedValue({ status: 'unavailable' });
  expect(await permitCosOutbound(session, message)).toBe(false);
  briefArtifacts.authorizePublication.mockResolvedValue({ status: 'denied' });
  reviewArtifacts.authorizePublication.mockResolvedValue({ status: 'denied' });
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

it.each(['existing', 'due', 'refresh', 'review-fence', 'review-corrupt', 'proactive-unavailable', 'proactive-denied'])(
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
    if (mode.startsWith('review-')) {
      expect(
        installReviewOrigin(db, binding, session, {
          identity: {
            missionId: 'mission',
            submissionId: randomUUID(),
            attemptId: randomUUID(),
            generation: 1,
            sessionId: session.id,
            contextGeneration: generation,
          },
          lease: { owner: 'review-host', fence: 1 },
          deadlineAt: new Date(Date.now() + 30000).toISOString(),
        }),
      ).toBe(true);
      if (mode === 'review-corrupt') db.prepare("UPDATE cos_mission_review_origins SET grant_json='invalid'").run();
    }
    const run = {
      id: lease.runId,
      generation: 1,
      lease_owner: 'host',
      state: mode === 'existing' ? 'prepared' : 'queued',
      schedule_id: 'schedule',
      schedule_version: 1,
      intended_at: new Date().toISOString(),
      limits: { refresh_seconds: mode === 'refresh' ? 20 : 0 },
      deadline_at: lease.deadlineAt,
    };
    const reference = {
      artifact_id: 'a'.repeat(64) + '-' + 'b'.repeat(64),
      output_digest: digest('Checked scheduled brief'),
      context_generation: generation,
      provider: 'codex',
    };
    const refreshPlan = {
      version: 1 as const,
      provider: 'codex',
      generation: 1,
      started_at: new Date().toISOString(),
      deadline_at: lease.deadlineAt,
      state: 'running',
      truncated: false,
      unavailable: 0,
      targets: [
        {
          binding_id: 'calendar',
          binding_version: 1,
          calendar_id: 'selected',
          snapshot_id: randomUUID(),
          window: { timeMin: new Date().toISOString(), timeMax: lease.deadlineAt, timeZone: 'UTC' },
          state: 'pending',
        },
      ],
    };
    const calendar = { refresh: vi.fn().mockResolvedValue({ result: { status: 'ok' } }) };
    const renewBriefContext = vi.fn((_binding, request) => {
      expect(request.expectedGeneration).toBe(generation);
      expect(calendar.refresh).not.toHaveBeenCalled();
      const next = randomUUID();
      db.prepare('UPDATE cos_conversation_states SET generation=?').run(next);
      reference.context_generation = next;
      return { generation: next };
    });
    const briefs = {
      beginRefresh: vi.fn().mockImplementation(async () => ({
        status: 'ok',
        refresh: { ...refreshPlan, state: mode === 'refresh' ? refreshPlan.state : 'not_requested' },
        remaining_ms: 20000,
      })),
      recordRefreshTarget: vi.fn().mockResolvedValue({ status: 'ok' }),
      finishRefresh: vi.fn().mockImplementation(async () => {
        refreshPlan.state = 'complete';
        return { status: 'ok', refresh: refreshPlan };
      }),
      reserveDue: vi.fn(async () => ({ status: 'ok', run: { ...run } })),
      claim: vi.fn(async (_c, _id, host) => {
        run.state = 'dispatched';
        run.lease_owner = host;
        return { status: 'ok', generation: 1, deadline_at: lease.deadlineAt };
      }),
      inspect: vi.fn(async () => ({ status: 'ok', run: { ...run }, notification: { state: 'queued' } })),
      authorize: vi.fn().mockResolvedValue({ status: 'ok' }),
      cancel: vi.fn().mockResolvedValue({ status: 'ok' }),
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
    const proactive = {
      scheduledBatch: vi.fn(async (context) => {
        expect(wake).not.toHaveBeenCalled();
        expect(context.generation).toBe(reference.context_generation);
        expect(context.ingressId).toBe(`brief:${run.id}:1`);
        expect(context.origin).toEqual({ kind: 'schedule', runId: run.id, generation: 1 });
        return {
          status: mode === 'proactive-unavailable' ? 'unavailable' : mode === 'proactive-denied' ? 'denied' : 'ok',
          candidates: [],
        };
      }),
    };
    try {
      runtime = createCosRuntime({
        db,
        enabled: true,
        store: {
          briefs,
          calendar,
          knowledge,
          briefArtifacts,
          proactive,
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
        launcher: { ready: () => true, prepare: vi.fn(), renewBriefContext },
      });
      await runtime.pump(binding);
      if (mode.startsWith('proactive-')) {
        expect(proactive.scheduledBatch).toHaveBeenCalledOnce();
        expect(wake).not.toHaveBeenCalled();
        expect(inbound.prepare('SELECT * FROM messages_in').all()).toHaveLength(0);
        return;
      }
      if (mode.startsWith('review-')) {
        expect(briefs.reserveDue).not.toHaveBeenCalled();
        expect(wake).not.toHaveBeenCalled();
        expect(renewBriefContext).not.toHaveBeenCalled();
        expect(calendar.refresh).not.toHaveBeenCalled();
        expect(deliver).not.toHaveBeenCalled();
        return;
      }
      if (mode !== 'existing') {
        expect(briefs.reserveDue).toHaveBeenCalledOnce();
        expect(wake).toHaveBeenCalledOnce();
        expect(proactive.scheduledBatch).toHaveBeenCalledOnce();
        expect(renewBriefContext).toHaveBeenCalledTimes(mode === 'refresh' ? 1 : 0);
        expect(calendar.refresh).toHaveBeenCalledTimes(mode === 'refresh' ? 1 : 0);
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
  const proactive = { scheduledBatch: vi.fn().mockResolvedValue({ status: 'ok' }) };
  let authorize!: TurnAuthorization;
  runtime = createCosRuntime({
    db,
    enabled: true,
    store: {
      briefs,
      knowledge,
      proactive,
      context: vi.fn().mockResolvedValue({ status: 'ok' }),
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
  expect(await authorize()).toBe(`brief:${lease.runId}:1`);
  expect(knowledge.contextReady).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session', generation }));
  expect(proactive.scheduledBatch).toHaveBeenCalledWith(
    expect.objectContaining({ generation, origin: { kind: 'schedule', runId: lease.runId, generation: 1 } }),
  );
  proactive.scheduledBatch.mockResolvedValue({ status: 'unavailable' });
  expect(await authorize()).toBeNull();
  expect(await authorize.reserve!('outage-before-model')).toBe(false);
  expect(briefs.reserveCall).not.toHaveBeenCalled();
  proactive.scheduledBatch.mockResolvedValue({ status: 'ok' });
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
