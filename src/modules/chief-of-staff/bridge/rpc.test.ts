import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRpcHandler } from './rpc.js';
import { digest } from '../domain/contracts.js';
import type { PriorityStore } from '../store/priorities.js';
import type { Session } from '../../../types.js';
import type { KnowledgeStore } from '../knowledge/store.js';
import { TEAM_DEFAULT_LIMITS } from '../contracts/team-protocol.js';
import { MISSION_DEFAULT_LIMITS } from '../contracts/mission-protocol.js';
const databases: Database.Database[] = [];
const request = {
  protocol: 'cos-rpc/v1',
  request_id: '11111111-1111-4111-8111-111111111111',
  method: 'cos_context_get',
  params: { view: 'today' },
};
function fixture(allowed = true) {
  const db = new Database(':memory:');
  databases.push(db);
  const context = {
    scopeId: 'fixture',
    ownerId: 'owner',
    sessionId: 'session',
    agentGroupId: 'group',
    ingressId: 'verified',
  };
  const store = {
    context: vi.fn().mockResolvedValue({ status: 'ok', records: [{ id: 'approved-record' }] }),
    propose: vi.fn(),
    readWork: vi.fn(),
    status: vi.fn(),
    requestMission: vi.fn().mockResolvedValue({
      status: 'ok',
      mission_id: 'mission',
      proposal_id: 'proposal',
      confirmation_token: 'PRIVATE_APPROVAL',
    }),
    missionRuns: { inspect: vi.fn().mockResolvedValue({ status: 'ok', mission: { id: 'mission', state: 'running' } }) },
    requestTeam: vi.fn().mockResolvedValue({
      status: 'ok',
      team_id: 'team-' + 'a'.repeat(64),
      confirmation_token: 'PRIVATE_TEAM_APPROVAL',
    }),
    teamRuns: { inspect: vi.fn().mockResolvedValue({ status: 'ok', team: { state: 'running' } }) },
  };
  const resolveContext = vi.fn().mockResolvedValue(allowed ? context : null);
  const handler = createRpcHandler({ resolveContext, store: store as unknown as PriorityStore });
  return { db, handler, store, resolveContext };
}
it('S06-T01/T06 coordinator team tools preserve owner scope and hide approval and native identities', async () => {
  const f = fixture(),
    team_id = 'team-' + 'a'.repeat(64);
  const sources = [{ source_id: 'note', revision_id: 'revision' }],
    acceptance_criteria = [{ id: 'cost', description: 'Compare costs.' }];
  const step = (step_id: string, template_id: string, depends_on: string[] = []) => ({
    step_id,
    template_id,
    template_version: 1,
    depends_on,
    input_artifact_refs: depends_on.map((step_id) => ({ step_id, result_schema: 'cos-research-result/v1' })),
    sources,
    required: true,
    acceptance_criteria,
    result_schema: template_id === 'team-reviewer' ? 'cos-team-review/v1' : 'cos-research-result/v1',
    max_rework_count: 0,
    limits: { ...MISSION_DEFAULT_LIMITS },
  });
  const teamRequest = {
    question: 'Compare technical and operational costs.',
    goal_id: null,
    project_id: null,
    sources,
    acceptance_criteria,
    limits: { ...TEAM_DEFAULT_LIMITS },
    partial_policy: 'block',
    steps: [
      step('technical', 'team-technical-analyst'),
      step('operations', 'team-operational-analyst'),
      step('writer', 'team-writer', ['technical', 'operations']),
      step('review', 'team-reviewer', ['writer']),
    ],
  };
  const cancelTeam = vi
    .fn()
    .mockResolvedValue({ status: 'ok', state: 'cancelling', identities: [{ sessionId: 'PRIVATE_NATIVE_ID' }] });
  const handler = createRpcHandler({
    resolveContext: f.resolveContext,
    store: f.store as unknown as PriorityStore,
    cancelTeam,
  });
  for (const [method, params] of [
    ['cos_team_request', { request: teamRequest }],
    ['cos_team_get', { team_id }],
    ['cos_team_cancel', { team_id }],
  ] as const)
    await handler(
      {
        action: 'cos_rpc',
        delivery_id: '22222222-2222-4222-8222-222222222222',
        request: { ...request, method, params },
      },
      {} as Session,
      f.db,
    );
  expect(f.store.requestTeam).toHaveBeenCalledWith(
    expect.objectContaining({ ownerId: 'owner' }),
    request.request_id,
    teamRequest,
  );
  expect(f.store.teamRuns.inspect).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session' }), team_id);
  expect(cancelTeam).toHaveBeenCalledWith(expect.objectContaining({ scopeId: 'fixture' }), team_id);
  expect(JSON.stringify(f.db.prepare('SELECT response FROM cos_rpc_responses').all())).not.toMatch(
    /PRIVATE_TEAM_APPROVAL|PRIVATE_NATIVE_ID/,
  );
});
it.each(['schedule', 'mission_review'] as const)(
  'S06-T05 automatic %s context cannot use owner team controls',
  async (kind) => {
    const f = fixture(),
      cancelTeam = vi.fn(),
      reserveTool = vi.fn(async () => ({ status: 'ok' as const }));
    f.resolveContext.mockResolvedValue({
      scopeId: 'fixture',
      ownerId: 'owner',
      sessionId: 'session',
      agentGroupId: 'group',
      origin: { kind, runId: 'run', generation: 1 },
      ingressId: 'automatic',
    });
    const handler = createRpcHandler({
      resolveContext: f.resolveContext,
      store: f.store as unknown as PriorityStore,
      cancelTeam,
      reserveTool,
    });
    for (const method of ['cos_team_get', 'cos_team_cancel'])
      await handler(
        {
          action: 'cos_rpc',
          delivery_id: '22222222-2222-4222-8222-222222222222',
          request: { ...request, method, params: { team_id: 'team-' + 'a'.repeat(64) } },
        },
        {} as Session,
        f.db,
      );
    expect(f.store.teamRuns.inspect).not.toHaveBeenCalled();
    expect(cancelTeam).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT count(*) AS n FROM cos_rpc_responses').get()).toEqual({ n: 2 });
    for (const row of f.db.prepare('SELECT response FROM cos_rpc_responses').all() as { response: string }[])
      expect(JSON.parse(row.response).status).toBe('denied');
  },
);
it('S05 routes coordinator mission controls through owner context and keeps approvals out of model results', async () => {
  const f = fixture();
  const cancelMission = vi.fn().mockResolvedValue({ status: 'ok', state: 'cancelling' });
  const handler = createRpcHandler({
    resolveContext: f.resolveContext,
    store: f.store as unknown as PriorityStore,
    cancelMission,
  });
  const limits = {
    max_attempts: 2,
    max_turns: 4,
    max_tool_calls: 24,
    max_concurrent_workers: 1,
    wall_seconds: 600,
    context_bytes: 32768,
    result_bytes: 8192,
  };
  const mission = {
    question: 'Compare notes',
    goal_id: null,
    project_id: null,
    sources: [{ source_id: 'note', revision_id: 'revision' }],
    acceptance_criteria: [{ id: 'comparison', description: 'Compare costs.' }],
    limits,
  };
  for (const [method, params] of [
    ['cos_mission_request', { request: mission }],
    ['cos_mission_get', { mission_id: 'mission' }],
    ['cos_mission_cancel', { mission_id: 'mission' }],
  ] as const)
    await handler(
      {
        action: 'cos_rpc',
        delivery_id: '22222222-2222-4222-8222-222222222222',
        request: { ...request, method, params },
      },
      {} as Session,
      f.db,
    );
  expect(f.store.requestMission).toHaveBeenCalledWith(
    expect.objectContaining({ scopeId: 'fixture', ownerId: 'owner' }),
    request.request_id,
    mission,
  );
  expect(f.store.missionRuns.inspect).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'session' }),
    'mission',
  );
  expect(cancelMission).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'owner' }), 'mission');
  expect(JSON.stringify(f.db.prepare('SELECT response FROM cos_rpc_responses').all())).not.toContain(
    'PRIVATE_APPROVAL',
  );
});
it('S05 scheduled runs cannot request or cancel owner missions and absent stop integration denies cancellation', async () => {
  const f = fixture();
  const cancelMission = vi.fn().mockResolvedValue({ status: 'ok' });
  f.resolveContext.mockResolvedValue({
    scopeId: 'fixture',
    ownerId: 'owner',
    sessionId: 'session',
    agentGroupId: 'group',
    ingressId: 'scheduled',
    origin: { kind: 'schedule', runId: 'run', generation: 1 },
  });
  const handler = createRpcHandler({
    resolveContext: f.resolveContext,
    store: f.store as unknown as PriorityStore,
    cancelMission,
    reserveTool: async () => ({ status: 'ok' }),
  });
  const content = {
    action: 'cos_rpc',
    delivery_id: '22222222-2222-4222-8222-222222222222',
    request: { ...request, method: 'cos_mission_cancel', params: { mission_id: 'mission' } },
  };
  await handler(content, {} as Session, f.db);
  expect(cancelMission).not.toHaveBeenCalled();
  expect(
    JSON.parse((f.db.prepare('SELECT response FROM cos_rpc_responses').get() as { response: string }).response).status,
  ).toBe('denied');
  f.resolveContext.mockResolvedValue({
    scopeId: 'fixture',
    ownerId: 'owner',
    sessionId: 'session',
    agentGroupId: 'group',
    ingressId: 'owner',
  });
  await f.handler(content, {} as Session, f.db);
  expect(
    JSON.parse((f.db.prepare('SELECT response FROM cos_rpc_responses').get() as { response: string }).response).status,
  ).toBe('denied');
});
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('S01 host-owned SQLite RPC response bridge', () => {
  it('mirrors the authorised result separately from chat using the actual session', async () => {
    const { db, handler, store, resolveContext } = fixture();
    const session = { id: 'session', agent_group_id: 'group' } as Session;
    await handler({ action: 'cos_rpc', delivery_id: '22222222-2222-4222-8222-222222222222', request }, session, db);
    const row = db
      .prepare('SELECT response FROM cos_rpc_responses WHERE request_id=? AND payload_hash=?')
      .get(request.request_id, digest(request)) as { response: string };
    expect(row).toBeDefined();
    expect(JSON.parse(row.response)).toMatchObject({
      protocol: 'cos-rpc/v1',
      status: 'ok',
      result: { records: [{ id: 'approved-record' }] },
    });
    expect(resolveContext).toHaveBeenCalledWith(session, db);
    expect(store.context).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='messages_in'").get()).toBeUndefined();
  });
  it('denies unbound sessions without querying private state', async () => {
    const { db, handler, store } = fixture(false);
    await handler(
      { action: 'cos_rpc', delivery_id: '22222222-2222-4222-8222-222222222222', request },
      {} as Session,
      db,
    );
    const row = db.prepare('SELECT response FROM cos_rpc_responses').get() as { response: string };
    expect(row).toBeDefined();
    expect(JSON.parse(row.response).status).toBe('denied');
    expect(store.context).not.toHaveBeenCalled();
  });
  it('rejects caller-supplied identity before resolving authority', async () => {
    const { db, handler, resolveContext } = fixture();
    await handler(
      {
        action: 'cos_rpc',
        delivery_id: '22222222-2222-4222-8222-222222222222',
        request: { ...request, ownerId: 'forged' },
      },
      {} as Session,
      db,
    );
    expect(resolveContext).not.toHaveBeenCalled();
  });
  it('revalidates current authority on every read instead of returning stale private responses', async () => {
    const { db, handler, store, resolveContext } = fixture();
    await handler(
      { action: 'cos_rpc', delivery_id: '22222222-2222-4222-8222-222222222222', request },
      {} as Session,
      db,
    );
    resolveContext.mockResolvedValue(null);
    await handler(
      { action: 'cos_rpc', delivery_id: '22222222-2222-4222-8222-222222222222', request },
      {} as Session,
      db,
    );
    const row = db.prepare('SELECT response FROM cos_rpc_responses').get() as { response: string };
    expect(row).toBeDefined();
    expect(JSON.parse(row.response).status).toBe('denied');
    expect(store.context).toHaveBeenCalledTimes(1);
  });
});
describe('S02 knowledge RPC host authority', () => {
  it('S04 routes work proposals and historical reads with host-derived identity and withholds replies after revocation', async () => {
    const { db, store } = fixture();
    const context = {
      scopeId: 'fixture',
      ownerId: 'owner',
      sessionId: 'session',
      agentGroupId: 'group',
      ingressId: 'verified',
    };
    const retained = { ...context, provider: 'codex', generation: '33333333-3333-4333-8333-333333333333' };
    const knowledge = { contextReady: vi.fn().mockResolvedValue({ status: 'ok' }) };
    const handler = createRpcHandler({
      resolveContext: async () => context,
      store: store as unknown as PriorityStore,
      knowledge: knowledge as unknown as KnowledgeStore,
      resolveKnowledgeContext: async () => retained,
    });
    const change = {
      kind: 'commitment',
      title: 'WorkRPCFixtureCanary',
      description: '',
      reason: 'Owner suggestion',
      state: 'confirmed',
      project_id: null,
      due: null,
      defer_until: null,
      evidence: [],
      expected_version: 0,
    };
    store.propose.mockResolvedValue({ status: 'ok', change, confirmation_token: 'HOST_ONLY_TOKEN' });
    store.readWork.mockResolvedValue({ status: 'ok', item: { title: 'WorkRPCFixtureCanary', version: 2 } });
    const call = async (method: string, params: unknown) => {
      await handler(
        {
          action: 'cos_rpc',
          delivery_id: '22222222-2222-4222-8222-222222222222',
          request: { ...request, method, params },
        },
        {} as Session,
        db,
      );
      return JSON.parse(
        (db.prepare('SELECT response FROM cos_rpc_responses ORDER BY rowid DESC LIMIT 1').get() as { response: string })
          .response,
      );
    };
    expect(await call('cos_work_change_propose', { change })).toMatchObject({ status: 'ok' });
    expect(store.propose).toHaveBeenCalledWith(context, request.request_id, change, retained);
    expect(JSON.stringify(await call('cos_work_read', { record_id: 'work-1', version: 2 }))).toContain(
      'WorkRPCFixtureCanary',
    );
    expect(store.readWork).toHaveBeenCalledWith(context, { record_id: 'work-1', version: 2 }, retained);
    const schedule = {
      kind: 'brief_schedule',
      title: 'Morning brief',
      reason: 'Owner requested weekdays',
      expected_version: 0,
      policy: {
        state: 'active',
        time_zone: 'Australia/Sydney',
        local_time: '09:00',
        weekdays: [1, 2, 3, 4, 5],
        quiet_hours: null,
        snooze_until: null,
      },
      limits: { max_turns: 2, max_tool_calls: 12, deadline_seconds: 120, refresh_seconds: 20 },
    };
    expect(await call('cos_brief_schedule_propose', { change: schedule })).toMatchObject({ status: 'ok' });
    expect(store.propose).toHaveBeenLastCalledWith(context, request.request_id, schedule);
    knowledge.contextReady.mockResolvedValueOnce({ status: 'ok' }).mockResolvedValue({ status: 'denied' });
    const denied = await call('cos_work_read', { record_id: 'work-1' });
    expect(denied.status).toBe('denied');
    expect(JSON.stringify(denied)).not.toContain('WorkRPCFixtureCanary');
  });
  it('S03 uses host context for calendar reads and includes bounded calendar coverage with priorities', async () => {
    const { db, store } = fixture(),
      context = {
        scopeId: 'fixture',
        ownerId: 'owner',
        sessionId: 'session',
        agentGroupId: 'group',
        ingressId: 'verified',
      };
    const retained = { ...context, provider: 'codex', generation: '33333333-3333-4333-8333-333333333333' };
    const knowledge = { contextReady: vi.fn().mockResolvedValue({ status: 'ok' }) };
    const calendarView = {
      read: vi.fn().mockResolvedValue({ status: 'ok', items: [{ summary: 'CalendarRPCFixtureCanary' }] }),
      coverage: vi.fn().mockResolvedValue({ status: 'ok', items: [], coverage: 'not_connected' }),
    };
    const handler = createRpcHandler({
      resolveContext: async () => context,
      store: { ...store, calendarView } as unknown as PriorityStore,
      knowledge: knowledge as unknown as KnowledgeStore,
      resolveKnowledgeContext: async () => retained,
    });
    const params = {
      binding_id: request.request_id,
      calendar_id: 'selected',
      time_min: '2026-10-01T00:00:00Z',
      time_max: '2026-10-02T00:00:00Z',
    };
    const content = {
      action: 'cos_rpc',
      delivery_id: '22222222-2222-4222-8222-222222222222',
      request: { ...request, method: 'cos_calendar_read', params },
    };
    await handler(content, {} as Session, db);
    const response = () =>
      JSON.parse(
        (
          db.prepare('SELECT response FROM cos_rpc_responses ORDER BY rowid DESC LIMIT 1').get() as {
            response: string;
          }
        ).response,
      );
    expect(response()).toMatchObject({ status: 'ok', result: { items: [{ summary: 'CalendarRPCFixtureCanary' }] } });
    expect(calendarView.read).toHaveBeenCalledWith(retained, params);
    knowledge.contextReady.mockResolvedValueOnce({ status: 'ok' }).mockResolvedValue({ status: 'denied' });
    await handler(content, {} as Session, db);
    expect(response().status).toBe('denied');
    expect(JSON.stringify(response())).not.toContain('CalendarRPCFixtureCanary');
    knowledge.contextReady.mockResolvedValue({ status: 'ok' });
    await handler({ ...content, request }, {} as Session, db);
    expect(response()).toMatchObject({ status: 'ok', result: { calendar: { coverage: 'not_connected' } } });
    expect(calendarView.coverage).toHaveBeenCalledWith(retained, 0);
  });
  it.each(['cos_answer_prepare', 'cos_answer_get'])(
    'routes %s with host context and suppresses output when the generation changes',
    async (method) => {
      const { db, store } = fixture();
      const context = {
        scopeId: 'fixture',
        ownerId: 'owner',
        sessionId: 'session',
        agentGroupId: 'group',
        ingressId: 'verified',
      };
      const knowledgeContext = { ...context, provider: 'codex', generation: '33333333-3333-4333-8333-333333333333' };
      const artifactId = 'a'.repeat(64) + '-' + 'b'.repeat(64);
      const draft = { kind: 'answer', coverage: 'insufficient', claims: [] };
      const knowledge = {
        contextReady: vi.fn().mockResolvedValue({ status: 'ok' }),
        answers: {
          prepare: vi.fn().mockResolvedValue({ status: 'ok', artifact_id: artifactId, text: 'private answer canary' }),
          get: vi.fn().mockResolvedValue({ status: 'ok', artifact_id: artifactId, text: 'private answer canary' }),
        },
      };
      const resolveKnowledgeContext = vi.fn().mockResolvedValue(knowledgeContext);
      const handler = createRpcHandler({
        resolveContext: async () => context,
        store: store as unknown as PriorityStore,
        knowledge: knowledge as unknown as KnowledgeStore,
        resolveKnowledgeContext,
      });
      const content = {
        action: 'cos_rpc',
        delivery_id: '22222222-2222-4222-8222-222222222222',
        request: {
          ...request,
          method,
          params: method === 'cos_answer_prepare' ? { draft } : { artifact_id: artifactId },
        },
      };
      const response = () =>
        JSON.parse((db.prepare('SELECT response FROM cos_rpc_responses').get() as { response: string }).response);
      await handler(content, {} as Session, db);
      expect(response()).toMatchObject({ status: 'ok', result: { text: 'private answer canary' } });
      expect(db.prepare('SELECT scope_id,session_id,generation FROM cos_rpc_contexts').get()).toEqual({
        scope_id: context.scopeId,
        session_id: context.sessionId,
        generation: knowledgeContext.generation,
      });
      if (method === 'cos_answer_prepare')
        expect(knowledge.answers.prepare).toHaveBeenCalledWith(knowledgeContext, request.request_id, draft);
      else expect(knowledge.answers.get).toHaveBeenCalledWith(knowledgeContext, artifactId);
      expect(store.propose).not.toHaveBeenCalled();
      resolveKnowledgeContext
        .mockResolvedValueOnce(knowledgeContext)
        .mockResolvedValue({ ...knowledgeContext, generation: '44444444-4444-4444-8444-444444444444' });
      await handler(content, {} as Session, db);
      expect(response().status).toBe('denied');
      expect(JSON.stringify(response())).not.toContain('private answer canary');
    },
  );
  it('derives provider and generation on the host, and rejects a prepared response after revocation', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const context = {
      scopeId: 'fixture',
      ownerId: 'owner',
      sessionId: 'session',
      agentGroupId: 'group',
      ingressId: 'verified',
    };
    const knowledge = {
      search: vi.fn().mockResolvedValue({ status: 'ok', items: [{ text: 'private canary' }] }),
      contextReady: vi.fn().mockResolvedValue({ status: 'ok' }),
    };
    const resolveKnowledgeContext = vi
      .fn()
      .mockResolvedValue({ ...context, provider: 'codex', generation: '33333333-3333-4333-8333-333333333333' });
    const handler = createRpcHandler({
      resolveContext: async () => context,
      store: {} as PriorityStore,
      knowledge: knowledge as unknown as KnowledgeStore,
      resolveKnowledgeContext,
    });
    const query = { ...request, method: 'cos_knowledge_search', params: { query: 'Pilot Alpha', limit: 2 } };
    const content = { action: 'cos_rpc', delivery_id: '22222222-2222-4222-8222-222222222222', request: query };
    await handler(content, { id: 'session' } as Session, db);
    expect(
      JSON.parse((db.prepare('SELECT response FROM cos_rpc_responses').get() as { response: string }).response),
    ).toMatchObject({ status: 'ok', result: { items: [{ text: 'private canary' }] } });
    expect(knowledge.search).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeId: 'fixture',
        provider: 'codex',
        generation: '33333333-3333-4333-8333-333333333333',
      }),
      expect.objectContaining({ query: 'Pilot Alpha', limit: 2 }),
    );
    knowledge.contextReady.mockResolvedValueOnce({ status: 'ok' }).mockResolvedValue({ status: 'denied' });
    await handler(content, { id: 'session' } as Session, db);
    const denied = (db.prepare('SELECT response FROM cos_rpc_responses').get() as { response: string }).response;
    expect(JSON.parse(denied).status).toBe('denied');
    expect(denied).not.toContain('private canary');
  });
});

it('S04 gates every scheduled tool dispatch on durable budget authority, including ambiguous reservations', async () => {
  const f = fixture(),
    delivery_id = '22222222-2222-4222-8222-222222222222';
  const context = {
    scopeId: 'fixture',
    ownerId: 'owner',
    sessionId: 'session',
    agentGroupId: 'group',
    ingressId: 'scheduled',
    origin: { kind: 'schedule' as const, runId: 'a'.repeat(64), generation: 1 },
  };
  f.resolveContext.mockResolvedValue(context);
  const reserveTool = vi.fn().mockResolvedValue({ status: 'pending' });
  const handler = createRpcHandler({
    resolveContext: f.resolveContext,
    store: f.store as unknown as PriorityStore,
    reserveTool,
  });
  const call = async () => {
    await handler({ action: 'cos_rpc', request, delivery_id }, {} as Session, f.db);
    return JSON.parse((f.db.prepare('SELECT response FROM cos_rpc_responses').get() as { response: string }).response);
  };
  expect((await call()).status).toBe('pending');
  expect(f.store.context).not.toHaveBeenCalled();
  expect(reserveTool).toHaveBeenCalledWith(context, expect.stringMatching(/^rpc-[a-f0-9]{64}$/));
  reserveTool.mockResolvedValue({ status: 'ok' });
  expect((await call()).status).toBe('ok');
  expect(f.store.context).toHaveBeenCalledOnce();
  reserveTool.mockResolvedValue({ status: 'denied' });
  expect((await call()).status).toBe('denied');
  expect(f.store.context).toHaveBeenCalledOnce();
  reserveTool.mockImplementation(async () => {
    f.resolveContext.mockResolvedValue(null);
    return { status: 'ok' };
  });
  expect((await call()).status).toBe('denied');
  expect(f.store.context).toHaveBeenCalledOnce();
  f.resolveContext.mockResolvedValue(context);
  const noHook = createRpcHandler({ resolveContext: f.resolveContext, store: f.store as unknown as PriorityStore });
  await noHook({ action: 'cos_rpc', request, delivery_id }, {} as Session, f.db);
  expect(f.store.context).toHaveBeenCalledOnce();
});

it.each(['ok', 'pending', 'denied'])(
  'S04 scheduled brief RPC attaches its checked artifact only after %s persistence',
  async (status) => {
    const f = fixture();
    const context = {
      scopeId: 'fixture',
      ownerId: 'owner',
      sessionId: 'session',
      agentGroupId: 'group',
      ingressId: 'verified',
      origin: { kind: 'schedule' as const, runId: 'run', generation: 2 },
    };
    const retained = { ...context, provider: 'codex', generation: '33333333-3333-4333-8333-333333333333' };
    const artifact = 'a'.repeat(64) + '-' + 'b'.repeat(64);
    const briefs = { prepare: vi.fn().mockResolvedValue({ status }) };
    const briefArtifacts = {
      prepare: vi.fn().mockResolvedValue({ status: 'ok', artifact_id: artifact, text: 'Checked brief' }),
    };
    f.resolveContext.mockResolvedValue(context);
    const handler = createRpcHandler({
      resolveContext: f.resolveContext,
      store: { ...f.store, briefs, briefArtifacts } as unknown as PriorityStore,
      reserveTool: async () => ({ status: 'ok' }),
      knowledge: { contextReady: vi.fn().mockResolvedValue({ status: 'ok' }) } as unknown as KnowledgeStore,
      resolveKnowledgeContext: async () => retained,
    });
    await handler(
      {
        action: 'cos_rpc',
        delivery_id: '22222222-2222-4222-8222-222222222222',
        request: { ...request, method: 'cos_brief_request', params: { time_zone: 'UTC' } },
      },
      {} as Session,
      f.db,
    );
    expect(briefs.prepare).toHaveBeenCalledExactlyOnceWith(context, 'run', 2, {
      artifact_id: artifact,
      output_digest: digest('Checked brief'),
      context_generation: retained.generation,
      provider: 'codex',
    });
    const response = JSON.parse(
      (f.db.prepare('SELECT response FROM cos_rpc_responses').get() as { response: string }).response,
    );
    expect(response.status).toBe(status);
    if (status !== 'ok') expect(JSON.stringify(response)).not.toContain('Checked brief');
  },
);

it('S04 brief RPC uses host context and suppresses a prepared response after authority changes', async () => {
  const f = fixture();
  const context = {
      scopeId: 'fixture',
      ownerId: 'owner',
      sessionId: 'session',
      agentGroupId: 'group',
      ingressId: 'verified',
    },
    retained = { ...context, provider: 'codex', generation: '33333333-3333-4333-8333-333333333333' };
  const artifact = 'a'.repeat(64) + '-' + 'b'.repeat(64),
    briefArtifacts = {
      prepare: vi.fn().mockResolvedValue({ status: 'ok', artifact_id: artifact, text: 'Checked brief canary' }),
      readHistory: vi.fn().mockResolvedValue({ status: 'ok', artifact_id: artifact, text: 'Saved brief canary' }),
    };
  const handler = createRpcHandler({
    resolveContext: f.resolveContext,
    store: { ...f.store, briefArtifacts } as unknown as PriorityStore,
    knowledge: { contextReady: vi.fn().mockResolvedValue({ status: 'ok' }) } as unknown as KnowledgeStore,
    resolveKnowledgeContext: async () => retained,
  });
  const call = async (params: Record<string, unknown>) => {
    await handler(
      {
        action: 'cos_rpc',
        delivery_id: '22222222-2222-4222-8222-222222222222',
        request: { ...request, method: 'cos_brief_request', params },
      },
      {} as Session,
      f.db,
    );
    return JSON.parse(
      (f.db.prepare('SELECT response FROM cos_rpc_responses ORDER BY rowid DESC LIMIT 1').get() as { response: string })
        .response,
    );
  };
  expect((await call({ time_zone: 'Australia/Sydney' })).status).toBe('ok');
  expect(briefArtifacts.prepare).toHaveBeenCalledWith(retained, request.request_id, 'Australia/Sydney');
  expect((await call({ artifact_id: artifact })).status).toBe('ok');
  expect(briefArtifacts.readHistory).toHaveBeenCalledWith(retained, artifact);
  briefArtifacts.prepare.mockImplementation(async () => {
    f.resolveContext.mockResolvedValue(null);
    return { status: 'ok', text: 'Must not disclose' };
  });
  const denied = await call({ time_zone: 'UTC' });
  expect(denied.status).toBe('denied');
  expect(JSON.stringify(denied)).not.toContain('Must not disclose');
});
