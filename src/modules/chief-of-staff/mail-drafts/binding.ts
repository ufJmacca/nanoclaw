export type MailDraftBinding = {
  format: 'cos-mail-draft-binding/v1';
  provider: 'google' | 'fixture';
  readerBindingId: string;
  mailboxDigest: string;
  writerClientDigest: string;
  readerClientDigest: string;
  credentialReference: string;
  nativeBindingDigest: string;
  journalGeneration: string;
  maxPerDay: 5;
  timeZone: 'Australia/Sydney';
  replyMode: 'plain_text_reply';
  permissionScopes: string[];
  recoveryProofDigest: string;
};
import { contextGenerationPattern } from '../ops/conversation-ownership.js';
import { GOOGLE_MAIL_DRAFT_SCOPE } from './oauth.js';
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && contextGenerationPattern.test(value);
export function validMailDraftBinding(value: unknown): value is MailDraftBinding {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'credentialReference,format,journalGeneration,mailboxDigest,maxPerDay,nativeBindingDigest,permissionScopes,provider,readerBindingId,readerClientDigest,recoveryProofDigest,replyMode,timeZone,writerClientDigest'
  )
    return false;
  const binding = value as MailDraftBinding;
  return (
    binding.format === 'cos-mail-draft-binding/v1' &&
    ['google', 'fixture'].includes(binding.provider) &&
    uuid(binding.readerBindingId) &&
    uuid(binding.credentialReference) &&
    uuid(binding.journalGeneration) &&
    hash(binding.mailboxDigest) &&
    hash(binding.nativeBindingDigest) &&
    hash(binding.recoveryProofDigest) &&
    hash(binding.writerClientDigest) &&
    hash(binding.readerClientDigest) &&
    binding.writerClientDigest !== binding.readerClientDigest &&
    binding.maxPerDay === 5 &&
    binding.timeZone === 'Australia/Sydney' &&
    binding.replyMode === 'plain_text_reply' &&
    Array.isArray(binding.permissionScopes) &&
    binding.permissionScopes.length === 1 &&
    binding.permissionScopes[0] === GOOGLE_MAIL_DRAFT_SCOPE
  );
}
