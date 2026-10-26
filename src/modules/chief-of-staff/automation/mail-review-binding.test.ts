import { expect, it } from 'vitest';
import { validMailReviewBinding, type MailReviewBinding } from './mail-review-binding.js';

const binding = (): MailReviewBinding => ({
  format: 'cos-mail-review-binding/v1',
  provider: 'google',
  readerBindingId: '11111111-1111-4111-8111-111111111111',
  writerBindingId: '22222222-2222-4222-8222-222222222222',
  writerVersion: 1,
  writerDigest: 'a'.repeat(64),
  writerConsentRef: 'b'.repeat(64),
  nativeBindingDigest: 'c'.repeat(64),
  mailboxDigest: 'd'.repeat(64),
  contextGeneration: '33333333-3333-4333-8333-333333333333',
  morningScheduleId: '44444444-4444-4444-8444-444444444444',
  afternoonScheduleId: '55555555-5555-4555-8555-555555555555',
  timeZone: 'Australia/Sydney',
  maxCandidateThreads: 10,
  maxModelAttempts: 3,
  maxDraftsPerDay: 5,
});

it('binds two reviews to the existing reader, writer consent and retained main context', () => {
  expect(validMailReviewBinding(binding())).toBe(true);
});
it.each([
  { format: 'cos-mail-review-binding/v2' },
  { provider: 'other' },
  { readerBindingId: 'unsafe' },
  { writerBindingId: 'unsafe' },
  { writerVersion: 0 },
  { writerVersion: 1.5 },
  { writerDigest: '' },
  { writerConsentRef: '' },
  { nativeBindingDigest: '' },
  { mailboxDigest: '' },
  { contextGeneration: 'new-conversation' },
  { morningScheduleId: 'unsafe' },
  { afternoonScheduleId: '44444444-4444-4444-8444-444444444444' },
  { maxCandidateThreads: 11 },
  { maxModelAttempts: 4 },
  { maxDraftsPerDay: 6 },
  { timeZone: 'UTC' },
  { permissionScopes: ['https://www.googleapis.com/auth/gmail.send'] },
  { sendEnabled: true },
  { endpoint: 'https://unrelated.invalid' },
  { refreshToken: 'PRIVATE_FIXTURE_CANARY' },
])('rejects broader or unverified review authority: %j', (patch) => {
  expect(validMailReviewBinding({ ...binding(), ...patch })).toBe(false);
});
it('does not accept a partial or non-object policy', () => {
  const partial: Partial<MailReviewBinding> = binding();
  delete partial.writerConsentRef;
  for (const value of [null, [], true, partial]) expect(validMailReviewBinding(value)).toBe(false);
});
