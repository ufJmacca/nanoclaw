import { expect, it } from 'vitest';
import fs from 'node:fs';
import { validMailDraftCreateInput, validMailDraftStatusInput } from './mail-draft-protocol.js';
import { validRequest } from './protocol.js';
const create = {
  writer_binding_id: '11111111-1111-4111-8111-111111111111',
  source_message_id: 'ab01',
  reply_text: 'A plain-text reply',
};
const wire = (method: string, params: unknown) => ({
  protocol: 'cos-rpc/v1',
  request_id: '22222222-2222-4222-8222-222222222222',
  method,
  params,
});
it('admits only a bounded source-selected plain-text reply and opaque original-operation status', () => {
  expect(validMailDraftCreateInput(create)).toBe(true);
  expect(validRequest(wire('cos_mail_draft_create', create))).toBe(true);
  expect(validMailDraftStatusInput({ operation_id: 'a'.repeat(64) })).toBe(true);
  expect(validRequest(wire('cos_mail_draft_status', { operation_id: 'a'.repeat(64) }))).toBe(true);
});
it.each([
  { writer_binding_id: 'foreign' },
  { source_message_id: '../send' },
  { reply_text: '' },
  { reply_text: ' ' },
  { reply_text: 'x'.repeat(16385) },
  { reply_text: '🦘'.repeat(5000) },
  { reply_text: 'bad\0text' },
  { reply_text: 'bad\uD800' },
  { to: 'other@example.test' },
  { subject: 'New message' },
  { thread_id: 'other' },
  { attachments: [] },
  { scope_id: 'foreign' },
  { approved: true },
  { send: true },
  { raw: 'untrusted' },
  { url: 'https://attacker.invalid' },
])('rejects expanded or malformed reply authority: %j', (patch) => {
  expect(validMailDraftCreateInput({ ...create, ...patch })).toBe(false);
  expect(validRequest(wire('cos_mail_draft_create', { ...create, ...patch }))).toBe(false);
});
it('refuses unknown send/update/delete/retry methods and expanded status reads', () => {
  for (const method of [
    'cos_mail_send',
    'cos_mail_draft_send',
    'cos_mail_draft_update',
    'cos_mail_draft_delete',
    'cos_mail_draft_retry',
  ])
    expect(validRequest(wire(method, create))).toBe(false);
  for (const params of [
    {},
    { operation_id: 'unsafe' },
    { operation_id: 'a'.repeat(64), scope_id: 'other' },
    { operation_id: 'a'.repeat(64), retry: true },
  ]) {
    expect(validMailDraftStatusInput(params)).toBe(false);
    expect(validRequest(wire('cos_mail_draft_status', params))).toBe(false);
  }
});
it('packages the exact wire validator into the runner without host database or credential dependencies', () => {
  expect(fs.readFileSync('container/agent-runner/src/mcp-tools/generated/mail-draft-protocol.ts', 'utf8')).toBe(
    fs.readFileSync('src/modules/chief-of-staff/contracts/mail-draft-protocol.ts', 'utf8'),
  );
});
