import { expect, it } from 'bun:test';
import { cosTools } from './chief-of-staff.js';
import { createCosToolDispatch } from '../providers/codex-cos-tools.js';
it('S11 exposes bounded inspection in the native coordinator tool set without account or deployment controls', async () => {
  const tool = cosTools.find((t) => t.tool.name === 'cos_status');
  expect(tool?.tool.inputSchema).toMatchObject({
    additionalProperties: false,
    properties: { category: { type: 'string' }, limit: { maximum: 20 } },
  });
  const calls: any[] = [];
  const dispatch = createCosToolDispatch(async (request) => {
    calls.push(request);
    return { protocol: 'cos-rpc/v1', request_id: request.request_id, status: 'ok' };
  });
  dispatch.beginTurn('thread', 'turn');
  let id = 0;
  const invoke = (arguments_: unknown) =>
    dispatch.handle({
      id: ++id,
      method: 'item/tool/call',
      params: { threadId: 'thread', turnId: 'turn', callId: 'call-' + id, tool: 'cos_status', arguments: arguments_ },
    });
  await invoke({ category: 'missions', limit: 5 });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: 'cos_status', params: { category: 'missions', limit: 5 } });
  await invoke({ scope_id: 'foreign' });
  await invoke({ limit: 21 });
  expect(calls).toHaveLength(1);
  await invoke({ category: 'actions', id: 'action-' + 'a'.repeat(64) });
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({
    method: 'cos_status',
    params: { category: 'actions', id: 'action-' + 'a'.repeat(64) },
  });
});
