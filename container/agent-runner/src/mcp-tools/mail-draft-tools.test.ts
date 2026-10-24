import { expect, test } from 'bun:test';
import { cosTools } from './chief-of-staff.js';
import { createCosToolDispatch } from '../providers/codex-cos-tools.js';
test('G05 advertises only draft-create and original-operation status with no recipient, send or mutation overrides', () => {
  const tools = cosTools.filter((definition) => definition.tool.name.startsWith('cos_mail_draft_'));
  expect(tools.map((definition) => definition.tool.name)).toEqual(['cos_mail_draft_create', 'cos_mail_draft_status']);
  expect(tools[0].tool.inputSchema).toMatchObject({
    additionalProperties: false,
    required: ['request_id', 'writer_binding_id', 'source_message_id', 'reply_text'],
  });
  expect(JSON.stringify(tools[0].tool.inputSchema)).not.toContain('recipient');
});
test('G05 native dispatcher preserves a stable create request and denies expanded authority or blind retry tools', async () => {
  const calls: any[] = [],
    dispatch = createCosToolDispatch(async (request) => {
      calls.push(request);
      return { protocol: 'cos-rpc/v1', request_id: request.request_id, status: 'ok' };
    });
  dispatch.beginTurn('thread', 'turn');
  const invoke = (tool: string, args: unknown, callId: string) =>
    dispatch.handle({
      id: 1,
      method: 'item/tool/call',
      params: { threadId: 'thread', turnId: 'turn', callId, tool, arguments: args },
    });
  const args = {
    request_id: '11111111-1111-4111-8111-111111111111',
    writer_binding_id: '22222222-2222-4222-8222-222222222222',
    source_message_id: 'ab01',
    reply_text: 'A harmless fixture reply',
  };
  expect((await invoke('cos_mail_draft_create', args, 'create')).success).toBe(true);
  expect(calls[0]).toMatchObject({
    request_id: args.request_id,
    method: 'cos_mail_draft_create',
    params: { writer_binding_id: args.writer_binding_id, source_message_id: 'ab01', reply_text: args.reply_text },
  });
  expect(calls[0].params).not.toHaveProperty('request_id');
  expect((await invoke('cos_mail_draft_status', { operation_id: 'a'.repeat(64) }, 'status')).success).toBe(true);
  for (const [index, patch] of [
    { to: 'other@example.test' },
    { send: true },
    { attachments: [] },
    { scope_id: 'other' },
    { raw: 'untrusted' },
  ].entries())
    expect((await invoke('cos_mail_draft_create', { ...args, ...patch }, 'bad-' + index)).success).toBe(false);
  for (const tool of ['cos_mail_draft_send', 'cos_mail_draft_update', 'cos_mail_draft_delete', 'cos_mail_draft_retry'])
    expect((await invoke(tool, args, tool)).success).toBe(false);
  expect(calls).toHaveLength(2);
  dispatch.close();
});
