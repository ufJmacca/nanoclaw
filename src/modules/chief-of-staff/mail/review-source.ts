import type { MailWindow } from './normalization.js';
import { MailReadError } from './reader.js';

export const MAIL_REVIEW_HEADERS = Object.freeze([
  'From',
  'Reply-To',
  'List-Id',
  'List-Unsubscribe',
  'Precedence',
  'Auto-Submitted',
  'X-Auto-Response-Suppress',
]);
export type MailReviewExclusion = 'bulk_mail' | 'automated_mail' | 'no_reply';
export type FreshMailReviewSource = {
  id: string;
  threadId: string;
  historyId: string;
  internalDate: number;
  observedAt: number;
  excluded: MailReviewExclusion | null;
};
/** Host-only metadata check. It reads no provider body and grants no draft operation. */
export interface MailReviewSourceReader {
  reviewSource(id: string, window: MailWindow): Promise<FreshMailReviewSource>;
}
export const mailReviewNoReply = (address: string) =>
  /(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster)(?:[+.][^@\s<>]*)?@/i.test(address);
export function mailReviewHeaderExclusion(value: unknown): MailReviewExclusion | null {
  if (!Array.isArray(value) || value.length > MAIL_REVIEW_HEADERS.length)
    throw new MailReadError('mail_invalid_response');
  const headers = new Map<string, string>(),
    allowed = new Set(MAIL_REVIEW_HEADERS.map((name) => name.toLowerCase()));
  for (const h of value) {
    if (
      !h ||
      typeof h !== 'object' ||
      Array.isArray(h) ||
      Object.keys(h).sort().join(',') !== 'name,value' ||
      typeof h.name !== 'string' ||
      typeof h.value !== 'string' ||
      h.value.length > 16384 ||
      !h.value.trim() ||
      !allowed.has(h.name.toLowerCase()) ||
      headers.has(h.name.toLowerCase()) ||
      [...h.value].some((char) => {
        const n = char.codePointAt(0)!;
        return (
          (n < 32 && n !== 9) ||
          (n >= 127 && n <= 159) ||
          (n >= 0x2028 && n <= 0x202e) ||
          (n >= 0x2066 && n <= 0x2069) ||
          (n >= 0xd800 && n <= 0xdfff)
        );
      })
    )
      throw new MailReadError('mail_invalid_response');
    headers.set(h.name.toLowerCase(), h.value.trim());
  }
  const from = headers.get('from');
  if (!from) throw new MailReadError('mail_invalid_response');
  if (
    headers.has('list-id') ||
    headers.has('list-unsubscribe') ||
    /^(?:bulk|list|junk)$/i.test(headers.get('precedence') ?? '')
  )
    return 'bulk_mail';
  if (
    (headers.has('auto-submitted') && headers.get('auto-submitted')!.toLowerCase() !== 'no') ||
    (headers.has('x-auto-response-suppress') && headers.get('x-auto-response-suppress')!.toLowerCase() !== 'none')
  )
    return 'automated_mail';
  return mailReviewNoReply(from) || mailReviewNoReply(headers.get('reply-to') ?? '') ? 'no_reply' : null;
}
