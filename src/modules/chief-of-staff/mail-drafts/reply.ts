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
/** Conservative RFC 2047 subset for comparing our emitted UTF-8 words with provider readback. */
function decodedSubject(value: string): string {
  const joined = value.replace(/(\?=)[ \t]+(?==\?)/g, '$1');
  const word = /=\?([^?\s]+)\?([bq])\?([^?\s]+)\?=/gi;
  if (joined.replace(word, '').includes('=?')) return invalid();
  const result = joined.replace(word, (whole: string, charset: string, encoding: string, text: string) => {
    if (whole.length > 75 || !['utf-8', 'us-ascii', 'iso-8859-1'].includes(charset.toLowerCase())) return invalid();
    let bytes: Buffer;
    if (encoding.toLowerCase() === 'b') {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return invalid();
      bytes = Buffer.from(text, 'base64');
      if (bytes.toString('base64') !== text) return invalid();
    } else {
      const parts: number[] = [];
      for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (character === '=') {
          const escaped = text.slice(index + 1, index + 3);
          if (!/^[a-f0-9]{2}$/i.test(escaped)) return invalid();
          parts.push(Number.parseInt(escaped, 16));
          index += 2;
        } else {
          const code = character.charCodeAt(0);
          if (code < 33 || code > 126) return invalid();
          parts.push(character === '_' ? 32 : code);
        }
      }
      bytes = Buffer.from(parts);
    }
    if (charset.toLowerCase() === 'us-ascii' && bytes.some((byte) => byte > 127)) return invalid();
    try {
      return new TextDecoder(charset, { fatal: true }).decode(bytes);
    } catch (error) {
      if (error instanceof TypeError) return invalid();
      throw error;
    }
  });
  if (result.length > 2048 || Buffer.byteLength(result) > 4096 || unsafeHeader(result)) return invalid();
  return result;
}
function replyText(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 16384 ||
    Buffer.byteLength(value) > 16384 ||
    !value.trim() ||
    unsafeBody(value)
  )
    return invalid();
  const normalized = value.replace(/\r\n?/g, '\n').replaceAll('\n', '\r\n');
  if (Buffer.byteLength(normalized) > 16384) return invalid();
  return normalized;
}
function contentDigest(envelope: ReplyEnvelope, text: string): string {
  return digest({
    format: 'cos-mail-reply-content/v1',
    envelope: { ...envelope, subject: decodedSubject(envelope.subject) },
    text: replyText(text),
  });
}
/** Host-only comparison. An unrelated/edited draft yields no content or new creation authority. */
export function verifySavedReply(
  draft: unknown,
  expected: { threadId: string; correlation: string; contentDigest: string },
): { draftId: string; messageId: string } | null {
  try {
    if (
      !object(expected) ||
      Object.keys(expected).sort().join(',') !== 'contentDigest,correlation,threadId' ||
      !providerId(expected.threadId) ||
      !/^[a-f0-9]{64}$/.test(expected.correlation) ||
      !/^[a-f0-9]{64}$/.test(expected.contentDigest) ||
      !object(draft) ||
      typeof draft.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,256}$/.test(draft.id) ||
      !object(draft.message)
    )
      return null;
    const message = draft.message;
    if (
      !providerId(message.id) ||
      message.threadId !== expected.threadId ||
      !Array.isArray(message.labelIds) ||
      message.labelIds.length > 100 ||
      !message.labelIds.includes('DRAFT') ||
      message.labelIds.some((label) => typeof label !== 'string' || ['SENT', 'SPAM', 'TRASH'].includes(label)) ||
      !object(message.payload)
    )
      return null;
    const payload = message.payload;
    if (
      payload.mimeType !== 'text/plain' ||
      (payload.filename !== undefined && payload.filename !== '') ||
      (payload.parts !== undefined && (!Array.isArray(payload.parts) || payload.parts.length !== 0)) ||
      !object(payload.body) ||
      payload.body.attachmentId !== undefined ||
      typeof payload.body.data !== 'string' ||
      payload.body.data.length > 24000 ||
      !/^[a-zA-Z0-9_-]*={0,2}$/.test(payload.body.data) ||
      !Array.isArray(payload.headers) ||
      payload.headers.length > 100
    )
      return null;
    const bytes = Buffer.from(payload.body.data, 'base64url');
    if (
      bytes.length > 16384 ||
      bytes.toString('base64url') !== payload.body.data.replace(/=+$/, '') ||
      (payload.body.size !== undefined && payload.body.size !== bytes.length)
    )
      return null;
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const headers = new Map<string, string>();
    for (const header of payload.headers) {
      if (
        !object(header) ||
        typeof header.name !== 'string' ||
        !/^[A-Za-z0-9-]{1,128}$/.test(header.name) ||
        typeof header.value !== 'string' ||
        header.value.length > 16384
      )
        return null;
      const name = header.name.toLowerCase(),
        value = header.value
          .replace(/\r\n[ \t]+/g, ' ')
          .replaceAll('\t', ' ')
          .trim();
      if (unsafeHeader(value) || ['cc', 'bcc', 'reply-to', 'content-disposition'].includes(name)) return null;
      if (
        headers.has(name) &&
        [
          'from',
          'to',
          'subject',
          'message-id',
          'in-reply-to',
          'references',
          'x-nanoclaw-correlation',
          'content-type',
          'mime-version',
        ].includes(name)
      )
        return null;
      headers.set(name, value);
    }
    if (
      headers.get('x-nanoclaw-correlation') !== expected.correlation ||
      headers.get('mime-version') !== '1.0' ||
      !/^text\/plain(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(headers.get('content-type') ?? '') ||
      !headers.has('subject')
    )
      return null;
    // Gmail can replace the submitted RFC Message-ID even on the first readback.
    // The opaque correlation header and exact envelope/body digest bind our save;
    // the caller separately pins the acknowledged provider draft/message IDs.
    messageId(headers.get('message-id') ?? '');
    const inReplyTo = messageId(headers.get('in-reply-to') ?? ''),
      references = (headers.get('references') ?? '').split(/ +/).filter(Boolean).map(messageId);
    if (!references.includes(inReplyTo) || references.length > 32 || new Set(references).size !== references.length)
      return null;
    const envelope: ReplyEnvelope = {
      threadId: expected.threadId,
      sender: mailbox(headers.get('from') ?? ''),
      recipient: mailbox(headers.get('to') ?? ''),
      subject: headers.get('subject')!,
      inReplyTo,
      references,
    };
    if (contentDigest(envelope, text) !== expected.contentDigest) return null;
    return { draftId: draft.id, messageId: message.id };
  } catch (error) {
    if (error instanceof TypeError || (error instanceof Error && error.message === 'mail_draft_reply_invalid'))
      return null;
    throw error;
  }
}
/** Pure MIME construction; callers still need source, standing-policy and journal admission. */
export function plainTextReply(
  source: ReplySource,
  text: string,
  correlation: string,
): { threadId: string; raw: string; correlationMessageId: string; contentDigest: string } {
  const envelope = replyEnvelope(source);
  if (typeof correlation !== 'string' || !/^[a-f0-9]{64}$/.test(correlation)) return invalid();
  const normalized = replyText(text),
    semanticDigest = contentDigest(envelope, normalized);
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
    contentDigest: semanticDigest,
  };
}
