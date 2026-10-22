import { digest } from '../domain/contracts.js';

/** Trusted host metadata, not a model-selected recipient or permission grant. */
export type ReplySource = {
  id: string;
  threadId: string;
  mailboxEmail: string;
  headers: Array<{ name: string; value: string }>;
};
export type ReplyEnvelope = {
  threadId: string;
  sender: string;
  recipient: string;
  subject: string;
  inReplyTo: string;
  references: string[];
};
const invalid = (): never => {
  throw Error('mail_draft_reply_invalid');
};
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const unsafeHeader = (value: string) =>
  [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return (
      (code < 32 && code !== 9) ||
      (code >= 127 && code <= 159) ||
      (code >= 0xd800 && code <= 0xdfff) ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    );
  });
const unsafeBody = (value: string) =>
  [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return (
      (code < 32 && ![9, 10, 13].includes(code)) || (code >= 127 && code <= 159) || (code >= 0xd800 && code <= 0xdfff)
    );
  });
const providerId = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{1,128}$/.test(x);
const atom = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
function domain(value: string): string {
  if (
    value.length > 253 ||
    !value.split('.').every((part) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part))
  )
    return invalid();
  return value.toLowerCase();
}
function address(value: string): string {
  if (value.length > 254) return invalid();
  const parts = value.split('@');
  if (parts.length !== 2 || !parts[0] || parts[0].length > 64 || !atom.test(parts[0]) || /^\.|\.$|\.\./.test(parts[0]))
    return invalid();
  return parts[0] + '@' + domain(parts[1]);
}
function mailbox(value: string): string {
  const text = value.trim();
  if (text.includes('<') || text.includes('>')) {
    const found = /^(?:(?:"(?:[^"\\]|\\.)*"|[^<>",]*)\s*)?<([^<>]+)>$/.exec(text);
    return found ? address(found[1]) : invalid();
  }
  return address(text);
}
function messageId(value: string): string {
  if (value.length > 254 || !/^<[^<>\s]+>$/.test(value)) return invalid();
  const parts = value.slice(1, -1).split('@');
  if (parts.length !== 2 || !parts[0] || parts[0].length > 190 || !atom.test(parts[0]) || /^\.|\.$|\.\./.test(parts[0]))
    return invalid();
  domain(parts[1]);
  return value;
}
/** Conservative single-mailbox RFC header subset. Ambiguous routing fails closed. */
export function replyEnvelope(source: ReplySource): ReplyEnvelope {
  if (
    !object(source) ||
    Object.keys(source).sort().join(',') !== 'headers,id,mailboxEmail,threadId' ||
    !providerId(source.id) ||
    !providerId(source.threadId) ||
    typeof source.mailboxEmail !== 'string' ||
    !Array.isArray(source.headers) ||
    source.headers.length > 200
  )
    return invalid();
  const sender = address(source.mailboxEmail);
  const headers = new Map<string, string>();
  const unique = new Set(['from', 'to', 'subject', 'message-id', 'reply-to', 'references']);
  for (const h of source.headers) {
    if (
      !object(h) ||
      Object.keys(h).sort().join(',') !== 'name,value' ||
      typeof h.name !== 'string' ||
      !/^[A-Za-z0-9-]{1,128}$/.test(h.name) ||
      typeof h.value !== 'string' ||
      h.value.length > 16384 ||
      unsafeHeader(h.value)
    )
      return invalid();
    const name = h.name.toLowerCase();
    if (headers.has(name) && unique.has(name)) return invalid();
    headers.set(name, h.value.replaceAll('\t', ' ').trim());
  }
  const from = mailbox(headers.get('from') ?? '');
  const recipient =
    from.toLowerCase() === sender.toLowerCase()
      ? mailbox(headers.get('to') ?? '')
      : mailbox(headers.get('reply-to') ?? headers.get('from') ?? '');
  if (recipient.toLowerCase() === sender.toLowerCase()) return invalid();
  const subject = headers.get('subject') ?? '';
  if (subject.length > 2048 || Buffer.byteLength(subject) > 4096) return invalid();
  const inReplyTo = messageId(headers.get('message-id') ?? '');
  const values = headers.get('references')?.split(/ +/).filter(Boolean) ?? [];
  if (values.length > 32) return invalid();
  const references = [...new Set(values.map(messageId))];
  if (!references.includes(inReplyTo)) references.push(inReplyTo);
  if (references.length > 32) return invalid();
  return { threadId: source.threadId, sender, recipient, subject, inReplyTo, references };
}
function subjectHeader(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject) && subject.length <= 900) return subject;
  // Already encoded long headers cannot be re-encoded without changing their meaning.
  if (subject.includes('=?')) return invalid();
  const parts: string[] = [];
  let chunk = '';
  for (const character of subject) {
    if (Buffer.byteLength(chunk + character) > 42) {
      parts.push('=?UTF-8?B?' + Buffer.from(chunk).toString('base64') + '?=');
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) parts.push('=?UTF-8?B?' + Buffer.from(chunk).toString('base64') + '?=');
  return parts.join('\r\n ');
}
function referencesHeader(values: string[]): string {
  let line = 'References:';
  const lines: string[] = [];
  for (const value of values) {
    if (line.length + value.length + 1 > 900) {
      lines.push(line);
      line = '';
    }
    line += ' ' + value;
  }
  lines.push(line);
  return lines.join('\r\n');
}
/** Pure MIME construction; callers still need source, standing-policy and journal admission. */
export function plainTextReply(
  source: ReplySource,
  text: string,
  correlation: string,
): { threadId: string; raw: string; correlationMessageId: string; contentDigest: string } {
  const envelope = replyEnvelope(source);
  if (
    typeof text !== 'string' ||
    text.length > 16384 ||
    Buffer.byteLength(text) > 16384 ||
    !text.trim() ||
    unsafeBody(text) ||
    typeof correlation !== 'string' ||
    !/^[a-f0-9]{64}$/.test(correlation)
  )
    return invalid();
  const normalized = text.replace(/\r\n?/g, '\n').replaceAll('\n', '\r\n');
  if (Buffer.byteLength(normalized) > 16384) return invalid();
  const correlationMessageId = '<cos-draft-' + correlation + '@nanoclaw.invalid>';
  const body =
    Buffer.from(normalized)
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? '';
  const mime = [
    'From: ' + envelope.sender,
    'To: ' + envelope.recipient,
    'Subject: ' + subjectHeader(envelope.subject),
    'Message-ID: ' + correlationMessageId,
    'In-Reply-To: ' + envelope.inReplyTo,
    referencesHeader(envelope.references),
    'X-NanoClaw-Correlation: ' + correlation,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
    '',
  ].join('\r\n');
  const raw = Buffer.from(mime).toString('base64url');
  return {
    threadId: envelope.threadId,
    raw,
    correlationMessageId,
    contentDigest: digest({ format: 'cos-mail-reply-content/v1', envelope, text: normalized }),
  };
}
