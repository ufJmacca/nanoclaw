import { expect, it } from 'vitest';
import { plainTextReply, verifySavedReply, type ReplySource } from './reply.js';
const correlation = 'a'.repeat(64);
const source = (subject = 'Résumé – a meeting'): ReplySource => ({
  id: 'aa01',
  threadId: 'bb02',
  mailboxEmail: 'owner@example.test',
  headers: [
    { name: 'From', value: 'sender@example.test' },
    { name: 'To', value: 'owner@example.test' },
    { name: 'Message-ID', value: '<source@example.test>' },
    { name: 'Subject', value: subject },
  ],
});
function fixture(subject?: string, text = 'A reply\nSecond line') {
  const reply = plainTextReply(source(subject), text, correlation),
    mime = Buffer.from(reply.raw, 'base64url').toString('utf8');
  const [head, body] = mime.split('\r\n\r\n');
  const headers = head
    .replace(/\r\n[ \t]+/g, ' ')
    .split('\r\n')
    .map((line) => {
      const index = line.indexOf(':');
      return { name: line.slice(0, index), value: line.slice(index + 1).trim() };
    });
  const draft = {
    id: 'r-123456',
    message: {
      id: 'dd04',
      threadId: 'bb02',
      labelIds: ['DRAFT'],
      payload: {
        mimeType: 'text/plain',
        headers,
        body: { size: Buffer.from(body, 'base64').length, data: Buffer.from(body, 'base64').toString('base64url') },
      },
    },
  };
  const expected = { threadId: reply.threadId, correlation, contentDigest: reply.contentDigest };
  const header = (name: string, value: string) => {
    draft.message.payload.headers = draft.message.payload.headers.filter(
      (h) => h.name.toLowerCase() !== name.toLowerCase(),
    );
    draft.message.payload.headers.push({ name, value });
  };
  return { draft, expected, header };
}
it.each([
  'Plain ASCII subject',
  'Résumé – a meeting',
  'A long Unicode subject 🦘 '.repeat(20),
  '=?UTF-8?B?UsOpc3Vtw6k=?=',
  '=?UTF-8?Q?R=C3=A9sum=C3=A9?=',
])('verifies independently fetched plain-text readback for %s', (subject) => {
  const f = fixture(subject);
  expect(verifySavedReply(f.draft, f.expected)).toEqual({ draftId: 'r-123456', messageId: 'dd04' });
});
it('accepts equivalent folding, display names and line endings without exposing the body', () => {
  const f = fixture();
  f.header('From', 'Owner Display <owner@example.test>');
  f.header('To', 'Sender Display <sender@example.test>');
  f.header('Subject', 'Résumé – a meeting');
  f.draft.message.payload.body.data = Buffer.from('A reply\r\nSecond line').toString('base64url');
  const result = verifySavedReply(f.draft, f.expected);
  expect(result).toEqual({ draftId: 'r-123456', messageId: 'dd04' });
  expect(JSON.stringify(result)).not.toContain('A reply');
});
it('preserves an actual leading Unicode BOM character in the authored plaintext', () => {
  const f = fixture('Subject', '\uFEFFHello');
  expect(verifySavedReply(f.draft, f.expected)).toEqual({ draftId: 'r-123456', messageId: 'dd04' });
});
it('verifies a provider-assigned RFC Message-ID using the independent correlation and exact reply content', () => {
  const f = fixture();
  f.header('Message-ID', '<provider-generated@mail.gmail.com>');
  expect(verifySavedReply(f.draft, f.expected)).toEqual({ draftId: 'r-123456', messageId: 'dd04' });
});
it.each([
  ['To', 'other@example.test'],
  ['From', 'other@example.test'],
  ['Subject', 'Human changed subject'],
  ['In-Reply-To', '<other@example.test>'],
  ['References', '<other@example.test>'],
  ['Message-ID', 'malformed-provider-id'],
  ['X-NanoClaw-Correlation', 'b'.repeat(64)],
  ['Cc', 'other@example.test'],
  ['Bcc', 'other@example.test'],
  ['Content-Disposition', 'attachment; filename="extra.txt"'],
  ['Content-Type', 'text/html; charset=UTF-8'],
  ['Reply-To', 'attacker@example.test'],
])('refuses human edits or added routing: %s', (name, value) => {
  const f = fixture();
  f.header(name, value);
  expect(verifySavedReply(f.draft, f.expected)).toBeNull();
});
it('refuses edited plaintext, malformed UTF-8 and misleading body size without echoing private content', () => {
  const f = fixture();
  for (const data of [
    Buffer.from('PRIVATE_CHANGED_BODY').toString('base64url'),
    Buffer.from([0xc0, 0xaf]).toString('base64url'),
    'not/canonical==',
  ]) {
    f.draft.message.payload.body.data = data;
    expect(verifySavedReply(f.draft, f.expected)).toBeNull();
  }
});
it('refuses multipart/attachments, missing/duplicate correlation and a draft that was sent or moved', () => {
  const f = fixture();
  expect(
    verifySavedReply(
      {
        ...f.draft,
        message: {
          ...f.draft.message,
          payload: { ...f.draft.message.payload, parts: [{ mimeType: 'application/pdf' }] },
        },
      },
      f.expected,
    ),
  ).toBeNull();
  expect(
    verifySavedReply(
      {
        ...f.draft,
        message: { ...f.draft.message, payload: { ...f.draft.message.payload, filename: 'attachment.txt' } },
      },
      f.expected,
    ),
  ).toBeNull();
  expect(verifySavedReply({ ...f.draft, message: { ...f.draft.message, threadId: 'cc03' } }, f.expected)).toBeNull();
  for (const labelIds of [[], ['SENT'], ['DRAFT', 'TRASH'], ['DRAFT', 'SPAM']])
    expect(verifySavedReply({ ...f.draft, message: { ...f.draft.message, labelIds } }, f.expected)).toBeNull();
  f.draft.message.payload.headers.push({ name: 'message-id', value: '<duplicate@example.test>' });
  expect(verifySavedReply(f.draft, f.expected)).toBeNull();
});
it('rejects malformed or unsupported encoded subjects before reserving a save', () => {
  for (const subject of [
    '=?UTF-8?B?invalid?=',
    '=?UNKNOWN?B?YWJj?=',
    '=?UTF-8?Q?bad=ZZ?=',
    '=?UTF-8?Q?injected=0D=0ABcc:_other@example.test?=',
  ])
    expect(() => plainTextReply(source(subject), 'A reply', correlation)).toThrow('mail_draft_reply_invalid');
});
