import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { parseMailReviewHostProfile, type MailReviewHostProfile } from '../automation/mail-review-profile.js';
import type { MailReviewPolicyHead } from '../mail-drafts/journal.js';

type RebindManifest = {
  format: 'cos-mail-review-rebind/v1';
  expectedRevision: number;
  expectedPinDigest: string;
  previousProfileDigest: string;
  profile: MailReviewHostProfile;
};
type Options = {
  binding: CosBinding;
  previous: unknown;
  manifest: unknown;
  previousHead: unknown;
  currentGeneration: string;
  requestId: string;
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) < 2147483647;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function need(value: unknown): asserts value {
  if (!value) throw Error('mail_review_rebind_unverified');
}

/** Protected owner input only. No timestamp, enable flag, storage root or model budget is accepted. */
export function parseMailReviewRebindManifest(value: unknown): RebindManifest {
  try {
    need(
      object(value) &&
        Object.keys(value).sort().join(',') ===
          'expectedPinDigest,expectedRevision,format,previousProfileDigest,profile',
    );
    need(value.format === 'cos-mail-review-rebind/v1' && positive(value.expectedRevision));
    need(hash(value.expectedPinDigest) && hash(value.previousProfileDigest));
    return {
      format: 'cos-mail-review-rebind/v1',
      expectedRevision: value.expectedRevision,
      expectedPinDigest: value.expectedPinDigest,
      previousProfileDigest: value.previousProfileDigest,
      profile: parseMailReviewHostProfile(value.profile),
    };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private manifest values and nested parsing diagnostics are withheld from owner output.
    throw Error('mail_review_rebind_unverified');
  }
}

/** Pure identity transition. Publication still requires fresh native, consent and recovery checks. */
export function planMailReviewRebind(input: Options) {
  try {
    const { binding, currentGeneration, requestId } = input,
      previous = parseMailReviewHostProfile(input.previous),
      manifest = parseMailReviewRebindManifest(input.manifest),
      proposed = manifest.profile;
    need(binding.provider === 'codex' && uuid(requestId) && uuid(currentGeneration));
    for (const key of ['scopeId', 'ownerId', 'sessionId', 'agentGroupId'] as const)
      need(previous[key] === binding[key]);
    for (const key of [
      'scopeId',
      'ownerId',
      'sessionId',
      'agentGroupId',
      'installationDigest',
      'journalGeneration',
      'id',
    ] as const)
      need(previous[key] === proposed[key]);
    need(positive(previous.version) && proposed.version === previous.version + 1);
    need(manifest.previousProfileDigest === digest(previous));
    need(
      object(input.previousHead) &&
        Object.keys(input.previousHead).sort().join(',') ===
          'enabled,policyId,policyVersion,profileDigest,revision,scopeId',
    );
    const head = input.previousHead;
    need(positive(head.revision) && typeof head.enabled === 'boolean');
    need(head.revision === manifest.expectedRevision && digest(head) === manifest.expectedPinDigest);
    need(
      head.scopeId === previous.scopeId &&
        head.policyId === previous.id &&
        head.policyVersion === previous.version &&
        head.profileDigest === digest(previous),
    );
    const old = previous.binding,
      next = proposed.binding;
    for (const key of [
      'format',
      'provider',
      'nativeBindingDigest',
      'mailboxDigest',
      'morningScheduleId',
      'afternoonScheduleId',
      'timeZone',
      'maxCandidateThreads',
      'maxModelAttempts',
      'maxDraftsPerDay',
    ] as const)
      need(next[key] === old[key]);
    need(old.nativeBindingDigest === digest(binding));
    need(next.contextGeneration === currentGeneration && next.contextGeneration !== old.contextGeneration);
    const priorIds = new Set([old.readerBindingId, old.writerBindingId]);
    need(
      !priorIds.has(next.readerBindingId) &&
        !priorIds.has(next.writerBindingId) &&
        next.readerBindingId !== next.writerBindingId,
    );
    need(
      next.writerVersion === 1 &&
        next.writerDigest !== old.writerDigest &&
        next.writerConsentRef !== old.writerConsentRef,
    );
    const profileDigest = digest(proposed),
      nextHead: MailReviewPolicyHead = {
        scopeId: previous.scopeId,
        policyId: previous.id,
        policyVersion: proposed.version,
        profileDigest,
        revision: head.revision + 1,
        enabled: head.enabled,
      };
    return {
      requestId,
      policyId: previous.id,
      expectedRevision: head.revision,
      previousProfileDigest: digest(previous),
      profileDigest,
      currentGeneration,
      nextHead,
      requiresFreshOwnerReadiness: true,
      requiresFreshReaderWriterConsentAndRecovery: true,
      requiresVerifiedRetainedContextRecovery: true,
      executionGranted: false,
      newRuntimeAuthority: false,
      newModelAllowance: false,
      contextResetAllowed: false,
      oldFenceRemovalAllowed: false,
      draftJournalResetAllowed: false,
    };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Protected policy and journal metadata must not enter public validation errors.
    throw Error('mail_review_rebind_unverified');
  }
}
