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
test('native CoS exposes exactly its three fixed tools and dispatches validated RPC', async () => {
  const { dispatch, calls } = fixture();
  expect(cosDynamicTools.map((tool) => tool.name)).toEqual([
    'cos_context_get',
    'cos_change_propose',
    'cos_request_status',
  ]);
  expect((await dispatch.handle(call())).success).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: 'cos_context_get', params: { view: 'today' } });
  expect((await dispatch.handle(call())).success).toBe(false);
  expect(calls).toHaveLength(1);
  dispatch.close();
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
