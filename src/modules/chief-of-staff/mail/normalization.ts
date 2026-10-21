import { Parser } from 'htmlparser2';
import { digest } from '../domain/contracts.js';
export const MAIL_RETENTION_MS = 30 * 86400000;
export const MAIL_MESSAGE_TEXT_BYTES = 65536;
export type MailWindow = { capturedAt: number; since: number };
export type MailMessage = {
  id: string;
  threadId: string;
  historyId: string;
  internalDate: number;
  labels: string[];
  subject: string;
  from: string;
  to: string;
  text: string;
  attachmentsExcluded: number;
  trust: 'untrusted_mail_evidence';
  digest: string;
};
export type NormalizedMail =
  | { status: 'selected'; message: MailMessage }
  | { status: 'excluded'; reason: 'not_selected' | 'outside_window'; deferredUntil?: number }
  | { status: 'unsupported'; reason: 'invalid_message' | 'content_limit' | 'body_unavailable' };

const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const providerId = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{1,128}$/.test(x);
export const mailHistoryId = (x: unknown): x is string => typeof x === 'string' && /^[1-9][0-9]{0,127}$/.test(x);
class UnsupportedMail extends Error {
  constructor(readonly reason: 'invalid_message' | 'content_limit' | 'body_unavailable') {
    super(reason);
  }
}
const fail = (reason: UnsupportedMail['reason']): never => {
  throw new UnsupportedMail(reason);
};
const headerControl = (value: string) =>
  [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return (code < 32 && code !== 9) || (code >= 127 && code <= 159);
  });
function headers(part: Record<string, unknown>): Map<string, string> {
  const result = new Map<string, string>();
  if (part.headers === undefined) return result;
  if (!Array.isArray(part.headers) || part.headers.length > 200) return fail('invalid_message');
  for (const h of part.headers) {
    if (
      !object(h) ||
      typeof h.name !== 'string' ||
      !/^[A-Za-z0-9-]{1,128}$/.test(h.name) ||
      typeof h.value !== 'string' ||
      h.value.length > 16384 ||
      headerControl(h.value)
    )
      return fail('invalid_message');
    const name = h.name.toLowerCase();
    if (result.has(name) && ['subject', 'from', 'to', 'content-type', 'content-disposition'].includes(name))
      return fail('invalid_message');
    result.set(name, h.value.replaceAll('\t', ' ').trim());
  }
  return result;
}
const clean = (x: string) =>
  [...x.replaceAll('\r\n', '\n').replaceAll('\r', '\n')]
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return (
        !(code < 32 && code !== 9 && code !== 10) &&
        !(code >= 127 && code <= 159) &&
        !(code >= 0x202a && code <= 0x202e) &&
        !(code >= 0x2066 && code <= 0x2069)
      );
    })
    .join('');
function htmlText(text: string): string {
  const hidden = new Set([
    'script',
    'style',
    'template',
    'iframe',
    'object',
    'embed',
    'svg',
    'math',
    'head',
    'noscript',
    'form',
  ]);
  const blocks = new Set([
    'p',
    'div',
    'br',
    'li',
    'tr',
    'td',
    'th',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'blockquote',
    'pre',
    'hr',
  ]);
  const stack: boolean[] = [];
  let suppressed = 0,
    parts = 0,
    output = '';
  const append = (value: string) => {
    output += value;
    if (Buffer.byteLength(output) > MAIL_MESSAGE_TEXT_BYTES) fail('content_limit');
  };
  const parser = new Parser(
    {
      onopentag(name) {
        if (++parts > 10000 || stack.length >= 128) fail('content_limit');
        const deny = suppressed > 0 || hidden.has(name);
        stack.push(deny);
        if (deny) suppressed++;
        else if (blocks.has(name)) append('\n');
      },
      ontext(value) {
        if (!suppressed) append(value);
      },
      onclosetag(name) {
        const deny = stack.pop();
        if (deny) suppressed--;
        else if (blocks.has(name)) append('\n');
      },
    },
    { decodeEntities: true, xmlMode: false },
  );
  parser.end(text);
  return clean(output)
    .split('\n')
    .map((line) => line.replace(/[\t \u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function decoded(body: Record<string, unknown>, type: string): string {
  if (body.attachmentId !== undefined) return fail('body_unavailable');
  if (body.data === undefined && body.size === 0) return '';
  if (
    typeof body.data !== 'string' ||
    !/^[A-Za-z0-9_-]*={0,2}$/.test(body.data) ||
    body.data.length > Math.ceil((MAIL_MESSAGE_TEXT_BYTES * 4) / 3) + 4
  ) {
    if (typeof body.data === 'string' && body.data.length > Math.ceil((MAIL_MESSAGE_TEXT_BYTES * 4) / 3) + 4)
      return fail('content_limit');
    return fail('invalid_message');
  }
  const bytes = Buffer.from(body.data, 'base64url');
  try {
    if (bytes.toString('base64url') !== body.data.replace(/=+$/, '')) return fail('invalid_message');
    if (bytes.length > MAIL_MESSAGE_TEXT_BYTES) return fail('content_limit');
    const charset = /;\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(type);
    const encoding = (charset?.[1] ?? charset?.[2] ?? 'utf-8').toLowerCase();
    if (!['utf-8', 'utf8', 'us-ascii', 'iso-8859-1', 'windows-1252'].includes(encoding)) return fail('invalid_message');
    if (encoding === 'us-ascii' && bytes.some((x) => x > 127)) return fail('invalid_message');
    return clean(new TextDecoder(encoding === 'us-ascii' ? 'utf-8' : encoding, { fatal: true }).decode(bytes));
  } finally {
    bytes.fill(0);
  }
}
/** Pure host-side normalization. No URL, attachment or executable interpretation exists here.
 * Labels and dates are checked for each individual message before its body is considered.
 */
export function normalizeMailMessage(input: unknown, window: MailWindow): NormalizedMail {
  try {
    if (
      !Number.isSafeInteger(window?.capturedAt) ||
      window.since !== window.capturedAt - MAIL_RETENTION_MS ||
      !object(input) ||
      !providerId(input.id) ||
      !providerId(input.threadId) ||
      !mailHistoryId(input.historyId) ||
      !Array.isArray(input.labelIds) ||
      input.labelIds.length > 100 ||
      input.labelIds.some((x) => typeof x !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(x))
    )
      return fail('invalid_message');
    const labels = [...new Set(input.labelIds as string[])].sort();
    if (
      labels.some((x) => ['SPAM', 'TRASH', 'DRAFT'].includes(x)) ||
      !labels.some((x) => ['INBOX', 'SENT'].includes(x))
    )
      return { status: 'excluded', reason: 'not_selected' };
    if (
      typeof input.internalDate !== 'string' ||
      !/^\d{1,16}$/.test(input.internalDate) ||
      !Number.isSafeInteger(Number(input.internalDate))
    )
      return fail('invalid_message');
    const internalDate = Number(input.internalDate);
    if (internalDate > window.capturedAt)
      return { status: 'excluded', reason: 'outside_window', deferredUntil: internalDate };
    if (internalDate < window.since) return { status: 'excluded', reason: 'outside_window' };
    if (!object(input.payload)) return fail('invalid_message');
    const top = headers(input.payload);
    let visited = 0,
      attachmentsExcluded = 0;
    const partText = (part: unknown, depth = 0): string => {
      if (++visited > 64 || depth > 12) return fail('content_limit');
      if (
        !object(part) ||
        typeof part.mimeType !== 'string' ||
        part.mimeType.length > 128 ||
        !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(part.mimeType)
      )
        return fail('invalid_message');
      const h = headers(part),
        mime = part.mimeType.toLowerCase();
      if (part.filename !== undefined && (typeof part.filename !== 'string' || part.filename.length > 512))
        return fail('invalid_message');
      if (
        part.filename ||
        /^attachment(?:;|$)/i.test(h.get('content-disposition') ?? '') ||
        mime === 'message/rfc822' ||
        (!mime.startsWith('multipart/') && !['text/plain', 'text/html'].includes(mime))
      ) {
        attachmentsExcluded++;
        return '';
      }
      if (mime.startsWith('multipart/')) {
        if (!Array.isArray(part.parts) || part.parts.length > 64)
          return fail(part.parts && Array.isArray(part.parts) ? 'content_limit' : 'invalid_message');
        if (mime === 'multipart/alternative') {
          // All members are validated even when a plain alternative is preferred.
          const parts = part.parts.map((p) => ({ mime: object(p) ? p.mimeType : null, text: partText(p, depth + 1) }));
          return parts.find((p) => p.mime === 'text/plain' && p.text)?.text ?? parts.find((p) => p.text)?.text ?? '';
        }
        const text = part.parts
          .map((p) => partText(p, depth + 1))
          .filter(Boolean)
          .join('\n');
        if (Buffer.byteLength(text) > MAIL_MESSAGE_TEXT_BYTES) return fail('content_limit');
        return text;
      }
      if (!object(part.body)) return fail('invalid_message');
      const text = decoded(part.body, h.get('content-type') ?? mime);
      return mime === 'text/html' ? htmlText(text) : text;
    };
    const text = partText(input.payload);
    if (Buffer.byteLength(text) > MAIL_MESSAGE_TEXT_BYTES) return fail('content_limit');
    const content = {
      id: input.id,
      threadId: input.threadId,
      historyId: input.historyId,
      internalDate,
      labels,
      subject: top.get('subject') ?? '',
      from: top.get('from') ?? '',
      to: top.get('to') ?? '',
      text,
      attachmentsExcluded,
      trust: 'untrusted_mail_evidence' as const,
    };
    return { status: 'selected', message: { ...content, digest: digest(content) } };
    // eslint-disable-next-line no-catch-all/no-catch-all -- Decoder and parser exceptions may include private mail; this pure adapter exposes only a fixed unsupported classification.
  } catch (error) {
    // Parsing errors can contain message bytes; only the fixed classification leaves this boundary.
    return { status: 'unsupported', reason: error instanceof UnsupportedMail ? error.reason : 'invalid_message' };
  }
}
