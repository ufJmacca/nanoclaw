import { expect, it } from 'vitest';
import { validMailReviewInputs, type MailReviewInputs } from './mail-review-inputs.js';

const inputs = (): MailReviewInputs => ({
  format: 'cos-mail-review-inputs/v1',
  policy_id: '11111111-1111-4111-8111-111111111111',
  policy_version: 1,
  policy_digest: 'a'.repeat(64),
  context_generation: '22222222-2222-4222-8222-222222222222',
  reader_binding_id: '33333333-3333-4333-8333-333333333333',
  writer_binding_id: '44444444-4444-4444-8444-444444444444',
  capture_id: '55555555-5555-4555-8555-555555555555',
  captured_at: '2026-10-26T04:00:00.000Z',
  last_success_at: '2026-10-26T04:00:02.000Z',
  coverage: 'stored_selection',
  excluded_threads: 0,
  unexamined_threads: 0,
  candidates: [
    {
      thread_id: 'aa01',
      source_message_id: 'bb01',
      source_id: 'source',
      source_version: 1,
      revision_id: '66666666-6666-4666-8666-666666666666',
      revision_digest: 'b'.repeat(64),
      internal_date_ms: Date.parse('2026-10-26T03:00:00.000Z'),
      subject: 'Please review the plan',
      reason: 'request',
    },
  ],
});

it('accepts only a bounded, explicitly limited capture tied to the policy and main context', () => {
  expect(validMailReviewInputs(inputs())).toBe(true);
  expect(validMailReviewInputs({ ...inputs(), candidates: [] })).toBe(true);
});
it.each([
  { policy_version: 0 },
  { policy_digest: '' },
  { context_generation: 'new-main' },
  { reader_binding_id: 'unsafe' },
  { writer_binding_id: 'unsafe' },
  { capture_id: 'unsafe' },
  { captured_at: 'tomorrow' },
  { last_success_at: 'unknown' },
  { coverage: 'all_mail_reviewed' },
  { excluded_threads: -1 },
  { unexamined_threads: 1001 },
  { modelAttempts: 100 },
])('rejects malformed or expanded input metadata: %j', (patch) => {
  expect(validMailReviewInputs({ ...inputs(), ...patch })).toBe(false);
});
it('refuses an eleventh candidate thread or a duplicate thread', () => {
  const v = inputs();
  v.candidates = Array.from({ length: 11 }, (_, i) => ({ ...v.candidates[0], thread_id: (i + 1).toString(16) }));
  expect(validMailReviewInputs(v)).toBe(false);
  const duplicate = inputs();
  duplicate.candidates.push({ ...duplicate.candidates[0], source_message_id: 'bb02' });
  expect(validMailReviewInputs(duplicate)).toBe(false);
});
it.each([
  { thread_id: 'unsafe' },
  { source_message_id: 'unsafe' },
  { source_id: '../other' },
  { source_version: 0 },
  { revision_id: 'unsafe' },
  { revision_digest: '' },
  { internal_date_ms: Date.parse('2026-10-26T05:00:00.000Z') },
  { subject: 'Injected\nheader' },
  { reason: 'send_now' },
  { replyTo: 'unrelated@example.test' },
])('rejects an unbound or unsafe candidate: %j', (patch) => {
  const v = inputs();
  v.candidates = [{ ...v.candidates[0], ...patch } as MailReviewInputs['candidates'][number]];
  expect(validMailReviewInputs(v)).toBe(false);
});
