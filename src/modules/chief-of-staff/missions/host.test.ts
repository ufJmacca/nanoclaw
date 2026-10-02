import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ root: '/tmp/cos-mission-host-' + process.pid }));
vi.mock('../../../config.js', async () => ({
  ...(await vi.importActual('../../../config.js')),
  DATA_DIR: fixture.root + '/data',
  GROUPS_DIR: fixture.root + '/groups',
}));
import { initTestDb, getDb, closeDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { subscribeMattermostChannelStrict } from '../../../channels/mattermost-subscription.js';
import { resolveSession, openInboundDb } from '../../../session-manager.js';
import { getSession, updateSession } from '../../../db/sessions.js';
import { installCosBoundary, prepareCosLaunch, permitCosExecution, type CosBinding } from '../../../cos-boundary.js';
import { isCosMissionStopped } from '../../../cos-mission-stop.js';
import type { CosMissionIdentity } from '../../../cos-mission-boundary.js';
import type { DeliveryActionHandler } from '../../../delivery.js';
import type { Result } from '../domain/contracts.js';
import { digest } from '../domain/contracts.js';
import { MISSION_DEFAULT_LIMITS } from '../contracts/mission-protocol.js';
import { RESEARCH_TEMPLATE, sealResearchWorkOrder } from './work-order.js';
import { NativeMissionAllocation } from './native-allocation.js';
import type { MissionRunStore } from './run-store.js';
import { MissionHost } from './host.js';
const hosts: MissionHost[] = [];
beforeEach(() => {
  fs.mkdirSync(fixture.root, { mode: 0o700 });
  fs.mkdirSync(fixture.root + '/target', { mode: 0o700 });
  runMigrations(initTestDb());
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  closeDb();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});
function setup() {
  const db = getDb(),
    root = fixture.root + '/target';
  const native = subscribeMattermostChannelStrict({ instanceKey: 'fixture', channelId: 'private' });
  const main = resolveSession(native.agentGroup.id, native.messagingGroup.id, null, 'shared').session;
  updateSession(main.id, { agent_provider: 'codex' });
  const binding: CosBinding = {
    scopeId: 'scope',
    ownerId: 'owner',
    botId: 'bot',
    instanceId: 'fixture',
    channelId: 'private',
    agentGroupId: main.agent_group_id,
    messagingGroupId: native.messagingGroup.id,
    sessionId: main.id,
    provider: 'codex',
  };
  installCosBoundary(binding, db);
  db.exec('UPDATE cos_identity_boundaries SET paused=0');
  const context = {
    scopeId: binding.scopeId,
    ownerId: binding.ownerId,
    agentGroupId: binding.agentGroupId,
    sessionId: main.id,
    ingressId: 'original-owner-event',
  };
  const authority = {
    bindingDigest: digest(binding),
    delegationDigest: digest('fixture-delegation'),
    contextGeneration: randomUUID(),
    provider: { profile: RESEARCH_TEMPLATE.providerProfile, model: 'fixture', policyDigest: digest('fixture-policy') },
  };
  const identity: CosMissionIdentity = {
    scopeId: 'scope',
    missionId: 'mission-' + randomUUID(),
    attemptId: randomUUID(),
    generation: 1,
    agentGroupId: 'child-' + randomUUID(),
    sessionId: randomUUID(),
    provider: 'codex',
  };
  const order = sealResearchWorkOrder({
    missionId: identity.missionId,
    request: {
      question: 'Compare fixture notes.',
      goal_id: null,
      project_id: null,
      sources: [{ source_id: 'note', revision_id: 'revision' }],
      acceptance_criteria: [{ id: 'tradeoff', description: 'Compare.' }],
      limits: { ...MISSION_DEFAULT_LIMITS },
    },
    origin: {
      ...context,
      bindingDigest: authority.bindingDigest,
      delegationDigest: authority.delegationDigest,
      contextGeneration: authority.contextGeneration,
    },
    related: { goal: null, project: null },
    sources: [
      {
        source_id: 'note',
        revision_id: 'revision',
        source_version: 1,
        revision_digest: digest('canary'),
        title: 'Note',
        status: 'current',
        chunks: [{ ordinal: 0, start_line: 1, end_line: 1, text: 'FIXTURE_CANARY' }],
      },
    ],
    provider: authority.provider,
    reviewedTemplateDigest: digest(RESEARCH_TEMPLATE),
    issuedAt: new Date().toISOString(),
  });
  const input = { identity, order, inputId: 'input-' + randomUUID() },
    lease = { owner: 'fixture-host', fence: 1 };
  const state = { phase: 'queued', present: false, stopped: false, admitted: true };
  const pending = () => ({
    status: 'ok' as const,
    items: ['queued', 'allocating', 'ready'].includes(state.phase) ? [{ identity, context }] : [],
    next_after: null,
  });
  const runs = {
    pendingDispatch: vi.fn(async () => pending()),
    inspectRecovery: vi.fn(async () => ({
      status: 'ok',
      identity,
      context,
      state:
        state.phase === 'submitted'
          ? 'awaiting_review'
          : ['running', 'failed'].includes(state.phase)
            ? state.phase
            : 'queued',
      attempt_state: state.phase,
      current_generation: true,
      admitted: state.admitted,
      stop_confirmed: state.stopped,
    })),
    claimDispatch: vi.fn(async () => ({ status: 'ok', ...input, lease })),
    authorizeDispatch: vi.fn(async () => ({ status: state.phase === 'submitted' ? 'denied' : 'ok' })),
    authorizeWorker: vi.fn(async () => ({ status: 'ok' })),
    markDispatchReady: vi.fn(async () => {
      state.phase = 'ready';
      return { status: 'ok' };
    }),
    beginExecution: vi.fn(async () => {
      state.phase = 'running';
      return { status: 'ok' };
    }),
    renewDispatch: vi.fn(async () => ({ status: state.phase === 'submitted' ? 'denied' : 'ok' })),
    fail: vi.fn(async () => {
      if (state.phase === 'submitted') return { status: 'denied' };
      state.phase = 'failed';
      return { status: 'ok' };
    }),
    confirmStopped: vi.fn(async () => {
      state.stopped = true;
      return { status: 'ok' };
    }),
    readContext: vi.fn(async (): Promise<Result> => ({ status: 'ok', context: { text: 'FIXTURE_CANARY' } })),
    submitResult: vi.fn(async () => ({ status: 'ok' })),
  };
  const launcher = {
    prepare: vi.fn(async () => ({ containerName: 'fixture-child', args: [] })),
    close: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
  const allocation = new NativeMissionAllocation({ root });
  let handler!: DeliveryActionHandler;
  const register = vi.fn((name: string, value: DeliveryActionHandler) => {
    expect(name).toBe('cos_mission_rpc');
    handler = value;
  });
  const options = {
    root,
    db,
    runs: runs as unknown as MissionRunStore,
    authority: vi.fn(() => (state.admitted ? authority : null)),
    admitted: () => true,
    assertHostAuthority: vi.fn(),
    facts: vi.fn(async () => ({
      id: 'private',
      type: 'P',
      delete_at: 0,
      members: ['owner', 'bot'],
      activeSubscription: true,
    })),
    running: vi.fn(() => state.present),
    stop: vi.fn(async () => {
      state.present = false;
    }),
    wake: vi.fn(async (session: Parameters<typeof prepareCosLaunch>[0]) => {
      await prepareCosLaunch(session);
      state.present = true;
      return true;
    }),
  };
  const create = () => {
    const host = new MissionHost(options, { allocation, launcher, register });
    hosts.push(host);
    return host;
  };
  return {
    db,
    binding,
    context,
    identity,
    input,
    state,
    runs,
    launcher,
    allocation,
    options,
    create,
    register,
    handler: () => handler,
  };
}
it('S05 host discovers, allocates and wakes the exact native child, then registers only its worker RPC', async () => {
  const f = setup(),
    host = f.create();
  await host.pump(f.binding);
  const child = getSession(f.identity.sessionId)!;
  expect(f.options.wake).toHaveBeenCalledWith(child);
  expect(f.runs.claimDispatch.mock.calls[0]).toEqual([
    f.context,
    f.identity.attemptId,
    expect.stringMatching(/^mission-host-/),
  ]);
  expect(permitCosExecution(child)).toBe(true);
  expect(child.messaging_group_id).toBeNull();
  const inbox = openInboundDb(child.agent_group_id, child.id);
  const request = {
    protocol: 'cos-mission-rpc/v1',
    request_id: randomUUID(),
    method: 'cos_mission_context_get',
    params: {},
  };
  const message = { action: 'cos_mission_rpc', request, delivery_id: randomUUID() };
  try {
    await f.handler()(message, child, inbox);
    expect(f.runs.readContext).toHaveBeenCalledOnce();
    expect(JSON.parse((inbox.prepare('SELECT response FROM cos_rpc_responses').get() as any).response).status).toBe(
      'ok',
    );
    await host.close();
    await f.handler()(message, child, inbox);
    const response = (inbox.prepare('SELECT response FROM cos_rpc_responses').get() as any).response;
    expect(response).not.toContain('FIXTURE_CANARY');
    expect(JSON.parse(response).status).toBe('denied');
  } finally {
    inbox.close();
  }
});
it('S05 restart resumes a verified absent partial allocation with the same identity and input', async () => {
  const f = setup();
  await f.allocation.prepare(f.input, async () => true);
  f.state.phase = 'allocating';
  const host = f.create();
  await host.pump(f.binding);
  expect(f.options.stop).not.toHaveBeenCalled();
  expect(f.runs.claimDispatch).toHaveBeenCalledOnce();
  expect(f.runs.beginExecution).toHaveBeenCalledOnce();
  expect(f.db.prepare('SELECT count(*) AS n FROM cos_mission_boundaries').get()).toEqual({ n: 1 });
});
it.each(['running', 'submitted'])(
  'S05 restart stops a %s orphan before new dispatch and preserves submitted state',
  async (phase) => {
    const f = setup();
    await f.allocation.prepare(f.input, async () => true);
    f.state.phase = phase;
    f.state.present = true;
    f.state.admitted = false;
    const host = f.create();
    await host.pump(f.binding);
    expect(isCosMissionStopped(f.identity, f.db)).toBe(true);
    expect(f.options.stop).toHaveBeenCalledWith(f.identity);
    expect(f.runs.confirmStopped).toHaveBeenCalledWith(f.identity);
    expect(f.options.wake).not.toHaveBeenCalled();
    expect(f.state.phase).toBe(phase === 'submitted' ? 'submitted' : 'failed');
  },
);
it('S05 uncertain orphan absence blocks dispatch and can be reconciled without reopening its identity', async () => {
  const f = setup();
  await f.allocation.prepare(f.input, async () => true);
  f.state.phase = 'running';
  f.state.present = true;
  f.options.stop.mockImplementation(async () => {});
  const host = f.create();
  await expect(host.pump(f.binding)).rejects.toThrow('mission_recovery_pending');
  expect(f.options.wake).not.toHaveBeenCalled();
  expect(isCosMissionStopped(f.identity, f.db)).toBe(true);
  f.state.present = false;
  await host.pump(f.binding);
  expect(f.runs.confirmStopped).toHaveBeenCalledOnce();
  expect(f.runs.claimDispatch).not.toHaveBeenCalled();
});
it('S05 private membership changes deny discovery without allocating a specialist', async () => {
  const f = setup(),
    host = f.create();
  f.options.facts.mockResolvedValue({
    id: 'private',
    type: 'P',
    delete_at: 0,
    members: ['owner', 'bot', 'outsider'],
    activeSubscription: true,
  });
  await host.pump(f.binding);
  expect(f.runs.pendingDispatch).not.toHaveBeenCalled();
  expect(f.runs.claimDispatch).not.toHaveBeenCalled();
  expect(f.options.wake).not.toHaveBeenCalled();
});
