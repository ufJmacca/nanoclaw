import { MAIL_MESSAGE_TEXT_BYTES, type MailMessage } from '../mail/normalization.js';
import { MAIL_CAPTURE_MESSAGES, MAIL_CAPTURE_TEXT_BYTES } from '../mail/capture.js';
import type { MailReviewCandidate } from './mail-review-inputs.js';
import { MAIL_REVIEW_LIMITS } from './mail-review-policy.js';

export type MailReviewRecord = Pick<
  MailReviewCandidate,
  'source_id' | 'source_version' | 'revision_id' | 'revision_digest'
> & {
  message: MailMessage;
};
const noReply = /(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster)(?:[+.][^@\s<>]*)?@/i;
const bulkSubject =
  /\b(?:newsletter|digest|changelog|roundup)\b|\b(?:automatic|automated|payment|order|purchase|delivery)\s+(?:confirmation|receipt)\b/i;
const automaticText =
  /\bunsubscribe\b|\bview (?:this (?:email|message) )?in (?:your |a )?browser\b|\b(?:automatically generated|automated (?:receipt|notification)|do not reply to this (?:email|message))\b/i;
const request = /\?|\b(?:please|could you|can you|would you|need your|requesting|requested)\b/i;
const followUp = /\bfollow(?:ing)?[- ]up\b|\bchecking in\b|\bawaiting (?:your |a )?(?:response|reply)\b/i;
const priority = { request: 0, follow_up: 1, attention: 2 };

function currentText(text: string): string {
  return text
    .split(/\n(?:On [^\n]{1,500} wrote:|[-_]{2,}\s*(?:Original Message|Forwarded message)|From:)/i)[0]
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
}
function reason(message: MailMessage): MailReviewCandidate['reason'] | null {
  const labels = new Set(message.labels),
    text = currentText(message.text);
  if (
    (!labels.has('INBOX') && !labels.has('SENT')) ||
    ['SPAM', 'TRASH', 'DRAFT', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'].some((label) =>
      labels.has(label),
    ) ||
    noReply.test(message.from) ||
    bulkSubject.test(message.subject) ||
    automaticText.test(text)
  )
    return null;
  const content = message.subject + '\n' + text;
  if (labels.has('SENT')) return request.test(content) || followUp.test(content) ? 'follow_up' : null;
  if (request.test(content)) return 'request';
  if (followUp.test(content)) return 'follow_up';
  return labels.has('IMPORTANT') || labels.has('UNREAD') ? 'attention' : null;
}

/** Host-only deterministic preselection from the current captured selection. No model, provider call,
 * draft effect or authority is created. Fresh provider metadata must exclude lists/automatic mail again. */
export function planMailReviewCandidates(
  records: readonly MailReviewRecord[],
  blockedThreads: ReadonlySet<string> = new Set(),
): {
  candidates: MailReviewCandidate[];
  excludedThreads: number;
  unexaminedThreads: number;
} {
  if (!Array.isArray(records) || records.length > MAIL_CAPTURE_MESSAGES) throw Error('mail_review_capture_invalid');
  const rows: readonly MailReviewRecord[] = records;
  const latest = new Map<string, MailReviewRecord>(),
    seen = new Set<string>();
  let textBytes = 0;
  for (const row of rows) {
    const message = row?.message;
    if (
      !message ||
      !/^[a-f0-9]{1,128}$/.test(message.id) ||
      !/^[a-f0-9]{1,128}$/.test(message.threadId) ||
      !Number.isSafeInteger(message.internalDate) ||
      message.internalDate < 0 ||
      message.trust !== 'untrusted_mail_evidence' ||
      !Array.isArray(message.labels) ||
      message.labels.some((label) => typeof label !== 'string') ||
      typeof message.from !== 'string' ||
      typeof message.subject !== 'string' ||
      typeof message.text !== 'string' ||
      Buffer.byteLength(message.text, 'utf8') > MAIL_MESSAGE_TEXT_BYTES ||
      seen.has(message.id)
    )
      throw Error('mail_review_capture_invalid');
    textBytes += Buffer.byteLength(message.text, 'utf8');
    if (textBytes > MAIL_CAPTURE_TEXT_BYTES) throw Error('mail_review_capture_invalid');
    seen.add(message.id);
    const previous = latest.get(message.threadId)?.message;
    if (
      !previous ||
      message.internalDate > previous.internalDate ||
      (message.internalDate === previous.internalDate && message.id > previous.id)
    )
      latest.set(message.threadId, row);
  }
  const eligible: MailReviewCandidate[] = [];
  let excludedThreads = 0;
  for (const row of latest.values()) {
    const { message, ...source } = row,
      selectedReason = blockedThreads.has(message.threadId) ? null : reason(message);
    if (!selectedReason) {
      excludedThreads++;
      continue;
    }
    eligible.push({
      ...source,
      thread_id: message.threadId,
      source_message_id: message.id,
      internal_date_ms: message.internalDate,
      subject: message.subject,
      reason: selectedReason,
    });
  }
  eligible.sort(
    (a, b) =>
      priority[a.reason] - priority[b.reason] ||
      b.internal_date_ms - a.internal_date_ms ||
      a.thread_id.localeCompare(b.thread_id, 'en'),
  );
  return {
    candidates: eligible.slice(0, MAIL_REVIEW_LIMITS.candidateThreads),
    excludedThreads,
    unexaminedThreads: Math.max(0, eligible.length - MAIL_REVIEW_LIMITS.candidateThreads),
  };
}
