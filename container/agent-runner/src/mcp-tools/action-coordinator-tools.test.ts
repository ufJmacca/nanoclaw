import { expect, test } from 'bun:test';
import { cosTools } from './chief-of-staff.js';
import { createCosToolDispatch } from '../providers/codex-cos-tools.js';
const request = {
  kind: 'calendar_block',
  binding_id: '11111111-1111-4111-8111-111111111111',
  calendar_id: 'selected-calendar',
  start: '2026-10-06T09:00:00Z',
  end: '2026-10-06T10:00:00Z',
  time_zone: 'UTC',
  title: 'Pilot Alpha',
  description: '',
  project_id: null,
  mission_id: null,
  attendees: [],
};
test('S09 native coordinator advertises only proposal, status and cancellation action tools', () => {
  expect(cosTools.filter((d) => d.tool.name.startsWith('cos_action_')).map((d) => d.tool.name)).toEqual([
    'cos_action_propose',
    'cos_action_get',
    'cos_action_cancel',
  ]);
});
test('S09 native dispatcher preserves exact action requests and denies authority or generic provider arguments', async () => {
  const calls: any[] = [];
  const dispatch = createCosToolDispatch(async (r) => {
    calls.push(r);
    return { protocol: 'cos-rpc/v1', request_id: r.request_id, status: 'ok' };
  });
  dispatch.beginTurn('thread', 'turn');
  const call = (tool: string, args: unknown, id: string) =>
    dispatch.handle({
      id: 1,
      method: 'item/tool/call',
      params: { threadId: 'thread', turnId: 'turn', callId: id, tool, arguments: args },
    });
  const request_id = '22222222-2222-4222-8222-222222222222';
  expect((await call('cos_action_propose', { request_id, request }, 'propose')).success).toBe(true);
  expect(calls[0]).toMatchObject({ request_id, method: 'cos_action_propose', params: { request } });
  for (const tool of ['cos_action_get', 'cos_action_cancel'])
    expect((await call(tool, { action_id: 'action-' + 'a'.repeat(64) }, tool)).success).toBe(true);
  for (const [i, args] of [
    { request },
    { request_id, request, approved: true },
    { request_id, request: { ...request, attendees: ['guest'] } },
    { request_id, request: { ...request, url: 'https://untrusted.invalid' } },
    { request_id, request, scope_id: 'foreign' },
  ].entries())
    expect((await call('cos_action_propose', args, 'bad-' + i)).success).toBe(false);
  for (const tool of ['cos_action_approve', 'cos_action_execute', 'cos_action_delete', 'cos_action_retry'])
    expect((await call(tool, {}, tool)).success).toBe(false);
  expect(calls).toHaveLength(3);
  dispatch.close();
});
