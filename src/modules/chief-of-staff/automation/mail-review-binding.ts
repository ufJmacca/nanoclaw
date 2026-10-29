import { contextGenerationPattern } from '../ops/conversation-ownership.js';
import { MAIL_REVIEW_LIMITS } from './mail-review-policy.js';

/** References existing consent and identity. This record alone grants no model or provider operation. */
export type MailReviewBinding = {
  format: 'cos-mail-review-binding/v1';
  provider: 'google' | 'fixture';
  readerBindingId: string;
  writerBindingId: string;
  writerVersion: number;
  writerDigest: string;
  writerConsentRef: string;
  nativeBindingDigest: string;
  mailboxDigest: string;
  contextGeneration: string;
  morningScheduleId: string;
  afternoonScheduleId: string;
  timeZone: 'Australia/Sydney';
  maxCandidateThreads: 10;
  maxModelAttempts: 3;
  maxDraftsPerDay: 5;
};

const uuid = (value: unknown): value is string => typeof value === 'string' && contextGenerationPattern.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function validMailReviewBinding(value: unknown): value is MailReviewBinding {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'afternoonScheduleId,contextGeneration,format,mailboxDigest,maxCandidateThreads,maxDraftsPerDay,maxModelAttempts,morningScheduleId,nativeBindingDigest,provider,readerBindingId,timeZone,writerBindingId,writerConsentRef,writerDigest,writerVersion'
  )
    return false;
  const binding = value as MailReviewBinding;
  return (
    binding.format === 'cos-mail-review-binding/v1' &&
    ['google', 'fixture'].includes(binding.provider) &&
    uuid(binding.readerBindingId) &&
    uuid(binding.writerBindingId) &&
    Number.isSafeInteger(binding.writerVersion) &&
    binding.writerVersion > 0 &&
    binding.writerVersion <= 2147483647 &&
    hash(binding.writerDigest) &&
    hash(binding.writerConsentRef) &&
    hash(binding.nativeBindingDigest) &&
    hash(binding.mailboxDigest) &&
    uuid(binding.contextGeneration) &&
    uuid(binding.morningScheduleId) &&
    uuid(binding.afternoonScheduleId) &&
    binding.morningScheduleId !== binding.afternoonScheduleId &&
    binding.timeZone === 'Australia/Sydney' &&
    binding.maxCandidateThreads === MAIL_REVIEW_LIMITS.candidateThreads &&
    binding.maxModelAttempts === MAIL_REVIEW_LIMITS.modelAttempts &&
    binding.maxDraftsPerDay === MAIL_REVIEW_LIMITS.draftsPerLocalDay
  );
}
