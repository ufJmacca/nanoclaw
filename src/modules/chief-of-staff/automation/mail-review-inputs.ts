import { contextGenerationPattern } from '../ops/conversation-ownership.js';
import { MAIL_REVIEW_LIMITS } from './mail-review-policy.js';

export type MailReviewCandidate = {
  thread_id: string;
  source_message_id: string;
  source_id: string;
  source_version: number;
  revision_id: string;
  revision_digest: string;
  internal_date_ms: number;
  subject: string;
  reason: 'request' | 'follow_up' | 'attention';
};

/** Frozen selection, not authority to read mail or save a draft. */
export type MailReviewInputs = {
  format: 'cos-mail-review-inputs/v1';
  policy_id: string;
  policy_version: number;
  policy_digest: string;
  context_generation: string;
  reader_binding_id: string;
  writer_binding_id: string;
  capture_id: string;
  captured_at: string;
  last_success_at: string | null;
  coverage: 'stored_selection' | 'incomplete' | 'stale';
  excluded_threads: number;
  unexamined_threads: number;
  candidates: MailReviewCandidate[];
};

function keys(value: unknown, expected: string): value is Record<string, unknown> {
  return (
    !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === expected
  );
}
const uuid = (value: unknown) => typeof value === 'string' && contextGenerationPattern.test(value);
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
function instant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validCandidate(value: unknown, capturedAt: number): value is MailReviewCandidate {
  if (
    !keys(
      value,
      'internal_date_ms,reason,revision_digest,revision_id,source_id,source_message_id,source_version,subject,thread_id',
    )
  )
    return false;
  return (
    typeof value.thread_id === 'string' &&
    /^[a-f0-9]{1,128}$/.test(value.thread_id) &&
    typeof value.source_message_id === 'string' &&
    /^[a-f0-9]{1,128}$/.test(value.source_message_id) &&
    typeof value.source_id === 'string' &&
    /^[a-zA-Z0-9_-]{1,100}$/.test(value.source_id) &&
    integer(value.source_version, 1, 2147483647) &&
    uuid(value.revision_id) &&
    hash(value.revision_digest) &&
    integer(value.internal_date_ms, 0, capturedAt) &&
    typeof value.subject === 'string' &&
    value.subject.length <= 2048 &&
    Buffer.byteLength(value.subject, 'utf8') <= 4096 &&
    // eslint-disable-next-line no-control-regex -- Refuse control and bidi characters in displayed mail subjects.
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value.subject) &&
    typeof value.reason === 'string' &&
    ['request', 'follow_up', 'attention'].includes(value.reason)
  );
}

export function validMailReviewInputs(value: unknown): value is MailReviewInputs {
  if (
    !keys(
      value,
      'candidates,capture_id,captured_at,context_generation,coverage,excluded_threads,format,last_success_at,policy_digest,policy_id,policy_version,reader_binding_id,unexamined_threads,writer_binding_id',
    )
  )
    return false;
  return (
    value.format === 'cos-mail-review-inputs/v1' &&
    uuid(value.policy_id) &&
    integer(value.policy_version, 1, 2147483647) &&
    hash(value.policy_digest) &&
    uuid(value.context_generation) &&
    uuid(value.reader_binding_id) &&
    uuid(value.writer_binding_id) &&
    uuid(value.capture_id) &&
    instant(value.captured_at) &&
    (value.last_success_at === null || instant(value.last_success_at)) &&
    typeof value.coverage === 'string' &&
    ['stored_selection', 'incomplete', 'stale'].includes(value.coverage) &&
    integer(value.excluded_threads, 0, 1000) &&
    integer(value.unexamined_threads, 0, 1000) &&
    Array.isArray(value.candidates) &&
    value.candidates.length <= MAIL_REVIEW_LIMITS.candidateThreads &&
    value.candidates.every((candidate) => validCandidate(candidate, Date.parse(value.captured_at as string))) &&
    new Set(value.candidates.map((candidate) => candidate.thread_id)).size === value.candidates.length
  );
}
