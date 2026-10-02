import { expect, test } from 'bun:test';
import { createMissionToolDispatch, missionDynamicTools } from './codex-mission-tools.js';
import type { MissionWorkerRequest } from '../mcp-tools/generated/mission-worker-protocol.js';

const call = (extra: Record<string, unknown> = {}) => ({
  id: 1,
  method: 'item/tool/call',
  params: {
    threadId: 'child',
    turnId: 'turn',
    callId: 'call',
    tool: 'cos_mission_context_get',
    arguments: {},
    ...extra,
  },
});
test('S05-T03 specialist has only its two fixed tools; caller cannot select identity or use coordinator tools', async () => {
  const calls: MissionWorkerRequest[] = [];
  const dispatch = createMissionToolDispatch(async (request) => {
    calls.push(request);
    return { protocol: 'cos-mission-rpc/v1', request_id: request.request_id, status: 'ok' };
  });
  expect(missionDynamicTools.map((t) => t.name)).toEqual(['cos_mission_context_get', 'cos_result_submit']);
  dispatch.beginTurn('child', 'turn');
  expect((await dispatch.handle(call())).success).toBe(true);
  for (const [i, extra] of [
    { tool: 'cos_context_get' },
    { tool: 'cos_change_propose' },
    { tool: 'send_message' },
    { tool: 'exec_command' },
    { arguments: { scope_id: 'other' } },
    { arguments: { mission_id: 'other' } },
    { arguments: { path: '/private' } },
    { threadId: 'coordinator' },
    { turnId: 'old' },
    { namespace: 'generic' },
  ].entries())
    expect((await dispatch.handle(call({ callId: 'forged-' + i, ...extra }))).success).toBe(false);
  expect(calls).toHaveLength(1);
  const requestId = '11111111-1111-4111-8111-111111111111';
  const result = {
    format: 'cos-research-result/v1',
    outcome: 'blocked',
    claims: [],
    criteria: [{ id: 'tradeoffs', claim_ids: [] }],
    limitations: ['Insufficient evidence.'],
  };
  expect(
    (
      await dispatch.handle(
        call({ callId: 'submit', tool: 'cos_result_submit', arguments: { request_id: requestId, result } }),
      )
    ).success,
  ).toBe(true);
  expect(calls[1]).toMatchObject({ request_id: requestId, method: 'cos_result_submit', params: { result } });
  expect(
    (
      await dispatch.handle(
        call({ callId: 'submit-again', tool: 'cos_result_submit', arguments: { result, approved: true } }),
      )
    ).success,
  ).toBe(false);
  dispatch.close();
});
test('S05 specialist turn fences suppress late host content and repeated physical calls', async () => {
  let complete!: (value: any) => void,
    id = '';
  const dispatch = createMissionToolDispatch((request) => {
    id = request.request_id;
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  dispatch.beginTurn('child', 'turn');
  const pending = dispatch.handle(call());
  expect((await dispatch.handle(call({ callId: 'parallel' }))).success).toBe(false);
  dispatch.endTurn();
  complete({ protocol: 'cos-mission-rpc/v1', request_id: id, status: 'ok', result: 'late-secret' });
  expect(JSON.stringify(await pending)).not.toContain('late-secret');
  expect((await dispatch.handle(call())).success).toBe(false);
  dispatch.close();
});
