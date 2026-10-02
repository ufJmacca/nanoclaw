import { expect, test } from 'bun:test';
import { createCosToolDispatch, cosDynamicTools } from './codex-cos-tools.js';
import type { CosRequest } from '../mcp-tools/generated/cos-protocol.js';

const call = (extra: Record<string, unknown> = {}) => ({
  id: 1,
  method: 'item/tool/call',
  params: { threadId: 'thread', turnId: 'turn', callId: 'call', tool: 'cos_context_get', arguments: {}, ...extra },
});
function fixture() {
  const calls: CosRequest[] = [];
  const dispatch = createCosToolDispatch(async (request) => {
    calls.push(request);
    return { protocol: 'cos-rpc/v1', request_id: request.request_id, status: 'ok', result: { records: [] } };
  });
  dispatch.beginTurn('thread', 'turn');
  return { dispatch, calls };
}
test('native CoS exposes only its fixed approved tools and dispatches validated RPC', async () => {
  const { dispatch, calls } = fixture();
  expect(cosDynamicTools.map((tool) => tool.name)).toEqual([
    'cos_context_get',
    'cos_change_propose',
    'cos_request_status',
    'cos_knowledge_search',
    'cos_source_get',
    'cos_source_change_propose',
    'cos_answer_prepare',
    'cos_answer_get',
    'cos_calendar_read',
    'cos_work_change_propose',
    'cos_brief_schedule_propose',
    'cos_work_read',
    'cos_brief_request',
    'cos_mission_request',
    'cos_mission_get',
    'cos_mission_cancel',
    'cos_mission_result_get',
    'cos_mission_review',
  ]);
  expect((await dispatch.handle(call())).success).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: 'cos_context_get', params: { view: 'today' } });
  expect((await dispatch.handle(call())).success).toBe(false);
  expect(calls).toHaveLength(1);
  dispatch.close();
});
test('S05 coordinator review tools require exact result identity and a stable review request ID', async () => {
  const { dispatch, calls } = fixture();
  const submission_id = '11111111-1111-4111-8111-111111111111',
    request_id = '22222222-2222-4222-8222-222222222222';
  const review = {
    mission_id: 'mission',
    submission_id,
    result_digest: 'a'.repeat(64),
    expected_version: 3,
    decision: 'partial',
    criteria: [{ id: 'cost', verdict: 'partial' }],
  };
  expect(
    (
      await dispatch.handle(
        call({ tool: 'cos_mission_result_get', arguments: { mission_id: 'mission', submission_id } }),
      )
    ).success,
  ).toBe(true);
  expect(
    (await dispatch.handle(call({ callId: 'review', tool: 'cos_mission_review', arguments: { request_id, review } })))
      .success,
  ).toBe(true);
  expect(calls[1]).toMatchObject({ method: 'cos_mission_review', request_id, params: { review } });
  expect(
    (await dispatch.handle(call({ callId: 'bad-review', tool: 'cos_mission_review', arguments: { review } }))).success,
  ).toBe(false);
  expect(calls).toHaveLength(2);
});
test('S05 coordinator tools keep stable proposal identity and exclude specialist or template authority', async () => {
  const { dispatch, calls } = fixture();
  const request_id = '11111111-1111-4111-8111-111111111111';
  const request = {
    question: 'Compare alternatives',
    goal_id: null,
    project_id: null,
    sources: [{ source_id: 'note', revision_id: 'revision' }],
    acceptance_criteria: [{ id: 'cost', description: 'Compare costs.' }],
    limits: {
      max_attempts: 2,
      max_turns: 4,
      max_tool_calls: 24,
      max_concurrent_workers: 1,
      wall_seconds: 600,
      context_bytes: 32768,
      result_bytes: 8192,
    },
  };
  expect(
    (await dispatch.handle(call({ tool: 'cos_mission_request', arguments: { request_id, request } }))).success,
  ).toBe(true);
  expect(calls[0]).toMatchObject({ method: 'cos_mission_request', request_id, params: { request } });
  for (const tool of ['cos_mission_get', 'cos_mission_cancel']) {
    expect((await dispatch.handle(call({ callId: tool, tool, arguments: { mission_id: 'mission' } }))).success).toBe(
      true,
    );
    expect(calls.at(-1)).toMatchObject({ method: tool, params: { mission_id: 'mission' } });
  }
  for (const [i, args] of [
    { request },
    { request_id, request, approved: true },
    { request_id, request, provider: 'claude' },
    { request_id, request: { ...request, template_id: 'privileged' } },
  ].entries())
    expect(
      (await dispatch.handle(call({ callId: 'bad-mission-' + i, tool: 'cos_mission_request', arguments: args })))
        .success,
    ).toBe(false);
  expect((await dispatch.handle(call({ callId: 'submit', tool: 'cos_result_submit', arguments: {} }))).success).toBe(
    false,
  );
  expect(calls).toHaveLength(3);
  dispatch.close();
});
test('S02 dispatches answer preparation with a stable request ID and rejects forged authority', async () => {
  const { dispatch, calls } = fixture();
  const requestId = '11111111-1111-4111-8111-111111111111';
  const draft = { kind: 'answer', coverage: 'insufficient', claims: [] };
  const artifactId = 'a'.repeat(64) + '-' + 'b'.repeat(64);
  expect(
    (await dispatch.handle(call({ tool: 'cos_answer_prepare', arguments: { request_id: requestId, draft } }))).success,
  ).toBe(true);
  expect(calls[0]).toMatchObject({ request_id: requestId, method: 'cos_answer_prepare', params: { draft } });
  expect(
    (
      await dispatch.handle(
        call({ callId: 'redisplay', tool: 'cos_answer_get', arguments: { artifact_id: artifactId } }),
      )
    ).success,
  ).toBe(true);
  expect(calls[1]).toMatchObject({ method: 'cos_answer_get', params: { artifact_id: artifactId } });
  for (const [index, args] of [
    { draft, provider: 'claude' },
    { draft, generation: 'forged' },
    { draft, destination: 'foreign' },
    { draft: { ...draft, claims: [{ kind: 'inference', text: 'unsupported', citations: [] }] } },
    { draft, request_id: 'invalid' },
  ].entries())
    expect(
      (await dispatch.handle(call({ callId: 'forged-answer-' + index, tool: 'cos_answer_prepare', arguments: args })))
        .success,
    ).toBe(false);
  expect(calls).toHaveLength(2);
  dispatch.close();
});
test('S03 dispatches bounded calendar reads and paged coverage without accepting account or write authority', async () => {
  const { dispatch, calls } = fixture();
  const args = {
    binding_id: '11111111-1111-4111-8111-111111111111',
    calendar_id: 'selected',
    time_min: '2026-10-01T00:00:00Z',
    time_max: '2026-10-02T00:00:00Z',
    limit: 2,
  };
  expect(
    (await dispatch.handle(call({ callId: 'calendar', tool: 'cos_calendar_read', arguments: args }))).success,
  ).toBe(true);
  expect(calls[0]).toMatchObject({ method: 'cos_calendar_read', params: args });
  expect((await dispatch.handle(call({ callId: 'coverage', arguments: { calendar_offset: 10 } }))).success).toBe(true);
  expect(calls[1]).toMatchObject({ method: 'cos_context_get', params: { view: 'today', calendar_offset: 10 } });
  for (const [i, extra] of [
    { provider: 'claude' },
    { scope_id: 'foreign' },
    { method: 'DELETE' },
    { url: 'https://evil.test' },
    { limit: 6 },
  ].entries())
    expect(
      (
        await dispatch.handle(
          call({ callId: 'denied-' + i, tool: 'cos_calendar_read', arguments: { ...args, ...extra } }),
        )
      ).success,
    ).toBe(false);
  expect(calls).toHaveLength(2);
});
test('S04 native work dispatch preserves proposal identity and rejects authority or ambiguous dispositions', async () => {
  const { dispatch, calls } = fixture();
  const requestId = '11111111-1111-4111-8111-111111111111';
  const change = {
    kind: 'commitment',
    title: 'Pilot',
    description: '',
    reason: 'Owner follow-up',
    state: 'confirmed',
    project_id: null,
    due: null,
    defer_until: null,
    evidence: [],
    expected_version: 0,
  };
  expect(
    (await dispatch.handle(call({ tool: 'cos_work_change_propose', arguments: { request_id: requestId, change } })))
      .success,
  ).toBe(true);
  expect(calls[0]).toMatchObject({ request_id: requestId, method: 'cos_work_change_propose', params: { change } });
  expect(
    (
      await dispatch.handle(
        call({ callId: 'read', tool: 'cos_work_read', arguments: { record_id: 'work-1', version: 2 } }),
      )
    ).success,
  ).toBe(true);
  expect(calls[1]).toMatchObject({ method: 'cos_work_read', params: { record_id: 'work-1', version: 2 } });
  for (const [i, args] of [
    { change, owner_id: 'forged' },
    { change, approved: true },
    { change: { ...change, state: 'completed' } },
    { change, request_id: 7 },
  ].entries())
    expect(
      (await dispatch.handle(call({ callId: 'invalid-' + i, tool: 'cos_work_change_propose', arguments: args })))
        .success,
    ).toBe(false);
  expect(calls).toHaveLength(2);
  dispatch.close();
});
test('S04 native schedule dispatch submits an exact bounded proposal and refuses generic schedule authority', async () => {
  const { dispatch, calls } = fixture();
  const change = {
    kind: 'brief_schedule',
    title: 'Weekday brief',
    reason: 'Owner request',
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
  const requestId = '11111111-1111-4111-8111-111111111111';
  expect(
    (await dispatch.handle(call({ tool: 'cos_brief_schedule_propose', arguments: { request_id: requestId, change } })))
      .success,
  ).toBe(true);
  expect(calls[0]).toMatchObject({ method: 'cos_brief_schedule_propose', request_id: requestId, params: { change } });
  for (const [i, args] of [
    { change, approved: true },
    { change, owner_id: 'forged' },
    { change: { ...change, script: 'arbitrary' } },
    { change: { ...change, limits: { ...change.limits, max_turns: 50 } } },
  ].entries())
    expect(
      (await dispatch.handle(call({ tool: 'cos_brief_schedule_propose', callId: 'denied-' + i, arguments: args })))
        .success,
    ).toBe(false);
  expect(
    (
      await dispatch.handle(
        call({
          tool: 'schedule_task',
          callId: 'generic',
          arguments: { prompt: 'send everything', recurrence: '* * * * *' },
        }),
      )
    ).success,
  ).toBe(false);
  expect(calls).toHaveLength(1);
  dispatch.close();
});
test('S02 dispatches bounded knowledge queries without accepting model authority or direct source mutations', async () => {
  const f = fixture();
  expect(
    (await f.dispatch.handle(call({ tool: 'cos_knowledge_search', arguments: { query: 'Pilot Alpha', limit: 2 } })))
      .success,
  ).toBe(true);
  expect(f.calls[0]).toMatchObject({ method: 'cos_knowledge_search', params: { query: 'Pilot Alpha', limit: 2 } });
  for (const [index, request] of [
    { tool: 'cos_knowledge_search', arguments: { query: 'Pilot', scope_id: 'foreign' } },
    {
      tool: 'cos_source_get',
      arguments: {
        source_id: 'source-a',
        revision_id: '11111111-1111-4111-8111-111111111111',
        ordinal: 0,
        generation: 'forged',
      },
    },
    { tool: 'cos_source_import', arguments: { path: '/private/secret' } },
    { tool: 'cos_source_delete', arguments: { source_id: 'source-a' } },
  ].entries())
    expect((await f.dispatch.handle(call({ ...request, callId: 'forged-' + index }))).success).toBe(false);
  expect(f.calls).toHaveLength(1);
  f.dispatch.close();
});
test('forged tools, extra arguments, foreign turns, namespaces and approval requests never reach the host', async () => {
  for (const request of [
    call({ tool: 'exec_command' }),
    call({ arguments: { destination: 'elsewhere' } }),
    call({ threadId: 'foreign' }),
    call({ turnId: 'old' }),
    call({ namespace: 'nanoclaw' }),
    call({ tool: 'cos_change_propose', arguments: { change: { kind: 'goal' } } }),
    { ...call(), method: 'item/permissions/requestApproval' },
  ]) {
    const { dispatch, calls } = fixture();
    expect((await dispatch.handle(request)).success).toBe(false);
    expect(calls).toEqual([]);
    dispatch.close();
  }
});
test('a proposal retains its supplied request ID for reconciliation', async () => {
  const { dispatch, calls } = fixture();
  const id = '11111111-1111-4111-8111-111111111111';
  const result = await dispatch.handle(
    call({
      tool: 'cos_change_propose',
      arguments: {
        request_id: id,
        change: {
          kind: 'goal',
          title: 'Fixture',
          description: '',
          lifecycle: 'active',
          reason: 'Test',
          expected_version: 0,
        },
      },
    }),
  );
  expect(result.success).toBe(true);
  expect(calls[0].request_id).toBe(id);
  dispatch.close();
});
test('ending a turn cancels pending RPC and excludes late results and further dispatch', async () => {
  let signal: AbortSignal | undefined;
  let finish!: (value: any) => void;
  let requestId = '';
  const dispatch = createCosToolDispatch((request, activeSignal) => {
    requestId = request.request_id;
    signal = activeSignal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  dispatch.beginTurn('thread', 'turn');
  const pending = dispatch.handle(call());
  dispatch.endTurn();
  expect(signal?.aborted).toBe(true);
  finish({ protocol: 'cos-rpc/v1', request_id: requestId, status: 'ok', result: 'private-late-canary' });
  expect(JSON.stringify(await pending)).not.toContain('private-late-canary');
  expect((await dispatch.handle(call())).success).toBe(false);
  dispatch.close();
});
test('concurrent calls and excessive per-turn requests are denied without host work', async () => {
  let finish!: (value: any) => void;
  let calls = 0;
  const dispatch = createCosToolDispatch((request) => {
    calls++;
    return new Promise((resolve) => {
      finish = () => resolve({ protocol: 'cos-rpc/v1', request_id: request.request_id, status: 'ok' });
    });
  });
  dispatch.beginTurn('thread', 'turn');
  const first = dispatch.handle(call());
  expect((await dispatch.handle(call({ callId: 'parallel' }))).success).toBe(false);
  finish(null);
  await first;
  for (let i = 1; i < 32; i++) {
    const pending = dispatch.handle(call({ callId: String(i) }));
    finish(null);
    expect((await pending).success).toBe(true);
  }
  expect((await dispatch.handle(call({ callId: 'over-budget' }))).success).toBe(false);
  expect(calls).toBe(32);
  dispatch.close();
});

test('S04 native brief requests keep stable request IDs and reject extra authority', async () => {
  const { calls, dispatch } = fixture();
  const requestId = '11111111-1111-4111-8111-111111111111';
  expect(
    (
      await dispatch.handle(
        call({ tool: 'cos_brief_request', arguments: { request_id: requestId, time_zone: 'Australia/Sydney' } }),
      )
    ).success,
  ).toBe(true);
  expect(calls[0]).toMatchObject({
    method: 'cos_brief_request',
    request_id: requestId,
    params: { time_zone: 'Australia/Sydney' },
  });
  expect(
    (
      await dispatch.handle(
        call({ tool: 'cos_brief_request', callId: 'forged', arguments: { time_zone: 'UTC', run_id: 'forged' } }),
      )
    ).success,
  ).toBe(false);
  dispatch.close();
});
