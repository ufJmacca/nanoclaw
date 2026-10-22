import { describe, expect, it } from 'vitest';
import { plainTextReply, replyEnvelope, type ReplySource } from './reply.js';

const correlation = 'a'.repeat(64);
const source = (): ReplySource => ({
  id: '18ab',
  threadId: '27cd',
  mailboxEmail: 'owner@example.test',
  headers: [
    { name: 'From', value: 'Jane Example <Jane.Doe@Example.TEST>' },
    { name: 'To', value: 'Owner <owner@example.test>' },
    { name: 'Subject', value: 'Résumé – quarterly' },
    { name: 'Message-ID', value: '<source-1@example.test>' },
    { name: 'References', value: '<earlier@example.test> <parent@example.test>' },
    { name: 'Cc', value: 'another@example.test' },
  ],
});
const replace = (name: string, value: string) => {
  const input = source();
  input.headers = input.headers.filter((h) => h.name.toLowerCase() !== name.toLowerCase());
  input.headers.push({ name, value });
  return input;
};

describe('G05 bound plain-text reply envelope', () => {
  it('uses one validated Reply-To without copying other recipients', () => {
    const input = source();
    input.headers.push({ name: 'Reply-To', value: '"Support, Team" <reply@example.test>' });
    expect(replyEnvelope(input)).toEqual({
      threadId: '27cd',
      sender: 'owner@example.test',
      recipient: 'reply@example.test',
      subject: 'Résumé – quarterly',
      inReplyTo: '<source-1@example.test>',
      references: ['<earlier@example.test>', '<parent@example.test>', '<source-1@example.test>'],
    });
  });
  it('falls back to From and preserves the recipient local part', () => {
    expect(replyEnvelope(source()).recipient).toBe('Jane.Doe@example.test');
  });
  it('follows up an owner-sent message only to its single original recipient', () => {
    const input = replace('From', 'Owner <owner@example.test>');
    input.headers = input.headers.filter((h) => h.name !== 'To');
    input.headers.push({ name: 'To', value: 'Customer <customer@example.test>' });
    expect(replyEnvelope(input).recipient).toBe('customer@example.test');
  });
  it('retains the exact subject and does not duplicate the current RFC message ID', () => {
    const input = replace('References', '<earlier@example.test> <source-1@example.test>');
    expect(replyEnvelope(input).references).toEqual(['<earlier@example.test>', '<source-1@example.test>']);
    expect(replyEnvelope(input).subject).toBe('Résumé – quarterly');
  });
  it.each([
    ['From', 'Jane <jane@example.test>\r\nBcc: attacker@example.test'],
    ['Reply-To', 'one@example.test, two@example.test'],
    ['Reply-To', 'Group: one@example.test;'],
    ['Reply-To', 'Name <first@example.test>, Other <second@example.test>'],
    ['Reply-To', 'bad..local@example.test'],
    ['Message-ID', 'not-an-rfc-message-id'],
    ['Message-ID', '<one@example.test> <two@example.test>'],
    ['References', '<valid@example.test> unparsed-words'],
    ['Subject', 'subject\nTo: attacker@example.test'],
    ['Subject', 'x'.repeat(2049)],
  ])('rejects unsafe or ambiguous %s header %j', (name, value) => {
    expect(() => replyEnvelope(replace(name, value))).toThrow('mail_draft_reply_invalid');
  });
  it.each(['From', 'To', 'Subject', 'Message-ID', 'Reply-To', 'References'])(
    'rejects duplicate %s headers regardless of case',
    (name) => {
      const input = source();
      if (name === 'Reply-To') input.headers.push({ name, value: 'one@example.test' });
      input.headers.push({ name: name.toLowerCase(), value: 'duplicate@example.test' });
      expect(() => replyEnvelope(input)).toThrow('mail_draft_reply_invalid');
    },
  );
  it('rejects missing message identity, self-replies, multiple sent recipients and oversized references', () => {
    const missing = source();
    missing.headers = missing.headers.filter((h) => h.name !== 'Message-ID');
    expect(() => replyEnvelope(missing)).toThrow('mail_draft_reply_invalid');
    expect(() => replyEnvelope(replace('From', 'owner@example.test'))).toThrow('mail_draft_reply_invalid');
    const sent = replace('From', 'owner@example.test');
    sent.headers = sent.headers.filter((h) => h.name !== 'To');
    sent.headers.push({ name: 'To', value: 'one@example.test, two@example.test' });
    expect(() => replyEnvelope(sent)).toThrow('mail_draft_reply_invalid');
    expect(() =>
      replyEnvelope(replace('References', Array.from({ length: 33 }, (_, i) => `<${i}@example.test>`).join(' '))),
    ).toThrow('mail_draft_reply_invalid');
  });
  it('refuses provider path injection and extra routing fields', () => {
    expect(() => replyEnvelope({ ...source(), threadId: '../send' })).toThrow('mail_draft_reply_invalid');
    expect(() => replyEnvelope({ ...source(), to: 'attacker@example.test' } as ReplySource)).toThrow(
      'mail_draft_reply_invalid',
    );
  });
  it('encodes one MIME text part with the validated recipient and exact thread identity', () => {
    const body = 'Thanks.\nBcc: attacker@example.test\nContent-Type: text/html\n<b>literal text</b>';
    const result = plainTextReply(source(), body, correlation);
    const mime = Buffer.from(result.raw, 'base64url').toString('utf8');
    const [headers, encoded] = mime.split('\r\n\r\n');
    expect(result.threadId).toBe('27cd');
    expect(headers).toContain('To: Jane.Doe@example.test\r\n');
    expect(headers).toContain('From: owner@example.test\r\n');
    expect(headers).toContain('In-Reply-To: <source-1@example.test>');
    expect(headers).toContain('References: <earlier@example.test> <parent@example.test> <source-1@example.test>');
    expect(headers).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(headers).toContain('Content-Transfer-Encoding: base64');
    expect(headers).not.toMatch(/^(Cc|Bcc|Content-Disposition):/m);
    expect(Buffer.from(encoded.replaceAll('\r\n', ''), 'base64').toString('utf8')).toBe(body.replaceAll('\n', '\r\n'));
    const subject = /Subject: =\?UTF-8\?B\?(.+)\?=/.exec(headers);
    expect(Buffer.from(subject![1], 'base64').toString('utf8')).toBe('Résumé – quarterly');
  });
  it('uses the same opaque correlation and MIME identity across retries without authorising another submission', () => {
    const a = plainTextReply(source(), 'A reply', correlation);
    expect(plainTextReply(source(), 'A reply', correlation)).toEqual(a);
    expect(a.correlationMessageId).toBe(`<cos-draft-${correlation}@nanoclaw.invalid>`);
    expect(Buffer.from(a.raw, 'base64url').toString('utf8')).toContain(`Message-ID: ${a.correlationMessageId}`);
  });
  it.each(['', ' \n ', '\u0000secret', 'é'.repeat(8193)])(
    'rejects empty, control-containing or oversized body',
    (body) => {
      expect(() => plainTextReply(source(), body, correlation)).toThrow('mail_draft_reply_invalid');
    },
  );
  it('rejects correlation injection', () => {
    expect(() => plainTextReply(source(), 'A reply', 'bad\r\nTo: attacker@example.test')).toThrow(
      'mail_draft_reply_invalid',
    );
  });
  it.each(['\ud800', '\udc00'])('rejects an unpaired surrogate in a source header', (value) => {
    expect(() => replyEnvelope(replace('Subject', value))).toThrow('mail_draft_reply_invalid');
  });
  it.each(['\ud800', '\udc00'])('rejects an unpaired surrogate in reply text', (value) => {
    expect(() => plainTextReply(source(), 'Reply ' + value, correlation)).toThrow('mail_draft_reply_invalid');
  });
  it('folds long Unicode subjects without splitting UTF-8 characters or changing the subject', () => {
    const subject = '😀é'.repeat(100);
    const value = plainTextReply(replace('Subject', subject), 'A reply', correlation);
    const headers = Buffer.from(value.raw, 'base64url').toString('utf8').split('\r\n\r\n')[0];
    const encoded = /Subject: (.*(?:\r\n .*)*)/.exec(headers)![1];
    const words = [...encoded.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)];
    expect(
      words.map((w) => new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(w[1], 'base64'))).join(''),
    ).toBe(subject);
    expect(headers.split('\r\n').every((line) => Buffer.byteLength(line) <= 998)).toBe(true);
  });
  it('folds long References while retaining every validated message ID', () => {
    const references = Array.from({ length: 20 }, (_, i) => `<${i}-${'x'.repeat(170)}@example.test>`);
    const value = plainTextReply(replace('References', references.join(' ')), 'A reply', correlation);
    const headers = Buffer.from(value.raw, 'base64url').toString('utf8').split('\r\n\r\n')[0];
    expect(headers.replaceAll('\r\n ', ' ')).toContain(
      'References: ' + [...references, '<source-1@example.test>'].join(' '),
    );
    expect(headers.split('\r\n').every((line) => Buffer.byteLength(line) <= 998)).toBe(true);
  });
});
