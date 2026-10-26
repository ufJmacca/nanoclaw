import { expect, it } from 'vitest';
import type { MailMessage } from '../mail/normalization.js';
import { digest } from '../domain/contracts.js';
import { planMailReviewCandidates, type MailReviewRecord } from './mail-review-candidates.js';

function row(id: string, threadId = id, patch: Partial<MailMessage> = {}): MailReviewRecord {
  const message: MailMessage = {
    id,
    threadId,
    historyId: '1',
    internalDate: 1000,
    labels: ['INBOX'],
    subject: 'Please review the plan',
    from: 'Colleague <colleague@example.test>',
    to: 'owner@example.test',
    text: 'Could you review this plan?',
    attachmentsExcluded: 0,
    trust: 'untrusted_mail_evidence',
    digest: digest(id),
    ...patch,
  };
  return {
    message,
    source_id: 'mail-' + id,
    source_version: 1,
    revision_id: '11111111-1111-4111-8111-111111111111',
    revision_digest: digest('source ' + id),
  };
}

it('chooses one newest relevant message per thread without returning message bodies', () => {
  const result = planMailReviewCandidates([row('a', 'aa'), row('b', 'aa', { internalDate: 2000 }), row('c', 'bb')]);
  expect(result.candidates.map((c) => c.source_message_id)).toEqual(['b', 'c']);
  expect(result.candidates[0]).toMatchObject({ thread_id: 'aa', source_id: 'mail-b', reason: 'request' });
  expect(JSON.stringify(result)).not.toContain('Could you review');
  expect(result.excludedThreads).toBe(0);
  expect(result.unexaminedThreads).toBe(0);
});
it.each([
  { from: 'Do not reply <no-reply@example.test>' },
  { from: 'donotreply@example.test' },
  { from: 'mailer-daemon@example.test' },
  { subject: 'Weekly newsletter' },
  { subject: 'Your payment receipt' },
  { labels: ['INBOX', 'CATEGORY_PROMOTIONS'] },
  { labels: ['SPAM', 'INBOX'] },
  { labels: ['TRASH', 'INBOX'] },
  { labels: ['DRAFT', 'INBOX'] },
  { labels: [] },
  { text: 'Please review this. Unsubscribe from these updates.' },
])('excludes bulk, automatic and out-of-selection mail: %j', (patch) => {
  const result = planMailReviewCandidates([row('a', 'aa', patch)]);
  expect(result.candidates).toEqual([]);
  expect(result.excludedThreads).toBe(1);
});
it('does not fall back to an older request after the latest selected message is an automatic receipt', () => {
  expect(
    planMailReviewCandidates([row('a', 'aa'), row('b', 'aa', { internalDate: 2000, subject: 'Automatic receipt' })])
      .candidates,
  ).toEqual([]);
});
it('prioritizes unanswered requests and follow-ups, then newest relevant attention items', () => {
  const result = planMailReviewCandidates([
    row('a', 'aa', {
      internalDate: 4000,
      subject: 'FYI',
      text: 'Here is the document.',
      labels: ['INBOX', 'IMPORTANT'],
    }),
    row('b', 'bb', { internalDate: 3000, subject: 'Following up', text: 'Following up on our discussion.' }),
    row('c', 'cc', { internalDate: 2000 }),
    row('d', 'dd', { internalDate: 2500 }),
  ]);
  expect(result.candidates.map((c) => [c.thread_id, c.reason])).toEqual([
    ['dd', 'request'],
    ['cc', 'request'],
    ['bb', 'follow_up'],
    ['aa', 'attention'],
  ]);
});
it('uses Sent requests as possible follow-ups but skips ordinary acknowledgements and closed threads', () => {
  const result = planMailReviewCandidates(
    [
      row('a', 'aa', { labels: ['SENT'] }),
      row('b', 'bb', { labels: ['SENT'], subject: 'Re: plan', text: 'Thanks, all done.' }),
      row('c', 'cc'),
    ],
    new Set(['cc']),
  );
  expect(result.candidates.map((c) => [c.thread_id, c.reason])).toEqual([['aa', 'follow_up']]);
  expect(result.excludedThreads).toBe(2);
});
it('caps the run at ten threads and explicitly counts remaining eligible threads', () => {
  const rows = Array.from({ length: 14 }, (_, i) =>
    row((i + 1).toString(16), (i + 1).toString(16), { internalDate: 1000 + i }),
  );
  const result = planMailReviewCandidates(rows);
  expect(result.candidates).toHaveLength(10);
  expect(result.unexaminedThreads).toBe(4);
  expect(result.candidates[0].source_message_id).toBe('e');
  expect(planMailReviewCandidates([...rows].reverse())).toEqual(result);
});
it('returns no candidate when nothing useful changed and refuses an oversized capture', () => {
  expect(
    planMailReviewCandidates([row('a', 'aa', { subject: 'Thanks', text: 'Thank you for the information.' })]),
  ).toEqual({ candidates: [], excludedThreads: 1, unexaminedThreads: 0 });
  expect(() => planMailReviewCandidates(Array.from({ length: 1001 }, () => row('a')))).toThrow(
    'mail_review_capture_invalid',
  );
});
it('does not treat an old quoted request as a new unanswered request', () => {
  expect(
    planMailReviewCandidates([
      row('a', 'aa', {
        labels: ['SENT'],
        subject: 'Re: plan',
        text: 'Thanks, all done.\nOn Monday Colleague wrote:\n> Could you review this plan?',
      }),
    ]).candidates,
  ).toEqual([]);
});
it('refuses oversized UTF-8 messages, total capture text and contradictory duplicate messages', () => {
  expect(() => planMailReviewCandidates([row('a', 'aa', { text: '😀'.repeat(20000) })])).toThrow(
    'mail_review_capture_invalid',
  );
  const text = 'x'.repeat(65536);
  expect(() =>
    planMailReviewCandidates(Array.from({ length: 257 }, (_, i) => row((i + 1).toString(16), undefined, { text }))),
  ).toThrow('mail_review_capture_invalid');
  expect(() => planMailReviewCandidates([row('a'), row('a')])).toThrow('mail_review_capture_invalid');
});
