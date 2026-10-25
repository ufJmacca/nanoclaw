import { expect, it } from 'vitest';
import { validMailDraftBinding, type MailDraftBinding } from './binding.js';
import { GOOGLE_MAIL_DRAFT_SCOPE } from './oauth.js';
const binding = (): MailDraftBinding => ({
  format: 'cos-mail-draft-binding/v1',
  provider: 'google',
  readerBindingId: '11111111-1111-4111-8111-111111111111',
  mailboxDigest: 'a'.repeat(64),
  writerClientDigest: 'b'.repeat(64),
  readerClientDigest: 'c'.repeat(64),
  credentialReference: '22222222-2222-4222-8222-222222222222',
  nativeBindingDigest: 'd'.repeat(64),
  journalGeneration: '33333333-3333-4333-8333-333333333333',
  maxPerDay: 5,
  timeZone: 'Australia/Sydney',
  replyMode: 'plain_text_reply',
  permissionScopes: [GOOGLE_MAIL_DRAFT_SCOPE],
  recoveryProofDigest: 'e'.repeat(64),
});
it('defines the exact standing reply-draft policy without per-save approval or broader email operations', () => {
  expect(validMailDraftBinding(binding())).toBe(true);
});
it.each([
  { maxPerDay: 6 },
  { maxPerDay: 0 },
  { timeZone: 'UTC' },
  { replyMode: 'new_message' },
  { provider: 'other' },
  { permissionScopes: ['https://www.googleapis.com/auth/gmail.send'] },
  { permissionScopes: [GOOGLE_MAIL_DRAFT_SCOPE, 'https://www.googleapis.com/auth/gmail.readonly'] },
  { readerClientDigest: 'b'.repeat(64) },
  { credentialReference: 'unsafe' },
  { readerBindingId: 'unsafe' },
  { journalGeneration: 'unsafe' },
  { nativeBindingDigest: 'unsafe' },
  { recoveryProofDigest: '' },
  { sendEnabled: true },
  { recipient: 'other@example.test' },
  { endpoint: 'https://attacker.invalid' },
  { refreshToken: 'PRIVATE_CANARY' },
])('rejects expanded, ambiguous or unverified writer policy: %j', (patch) => {
  expect(validMailDraftBinding({ ...binding(), ...patch })).toBe(false);
});
