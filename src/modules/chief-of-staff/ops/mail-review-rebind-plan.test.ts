import { test } from 'vitest';
import type { CosBinding } from '../../../cos-boundary.js';
import assert from 'node:assert/strict';
import { digest } from '../domain/contracts.js';
import { planMailReviewRebind } from './mail-review-rebind-plan.js';

function request(x: ReturnType<typeof fixture>) {
  return {
    binding: x.binding,
    previous: x.previous,
    manifest: {
      format: 'cos-mail-review-rebind/v1',
      expectedRevision: x.expectedHead.revision,
      expectedPinDigest: digest(x.expectedHead),
      previousProfileDigest: digest(x.previous),
      profile: x.proposed,
    },
    previousHead: x.actualHead,
    currentGeneration: x.currentGeneration,
    requestId: x.requestId,
  };
}
const planReviewRelink = (x: ReturnType<typeof fixture>) => planMailReviewRebind(request(x));

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
function fixture(enabled = true) {
  const binding: CosBinding = {
    scopeId: 'chief-of-staff',
    ownerId: 'owner',
    sessionId: 'session',
    agentGroupId: 'group',
    messagingGroupId: 'messages',
    provider: 'codex',
    instanceId: 'fixture',
    channelId: 'private',
    botId: 'bot',
  };
  const previous = {
    format: 'cos-mail-review-host/v1',
    installationDigest: digest('installation'),
    journalGeneration: id(1),
    scopeId: binding.scopeId,
    ownerId: binding.ownerId,
    sessionId: binding.sessionId,
    agentGroupId: binding.agentGroupId,
    id: id(2),
    version: 1,
    binding: {
      format: 'cos-mail-review-binding/v1',
      provider: 'google',
      readerBindingId: id(3),
      writerBindingId: id(4),
      writerVersion: 1,
      writerDigest: digest('old-writer'),
      writerConsentRef: digest('old-consent'),
      nativeBindingDigest: digest(binding),
      mailboxDigest: digest('same-mailbox'),
      contextGeneration: id(5),
      morningScheduleId: id(6),
      afternoonScheduleId: id(7),
      timeZone: 'Australia/Sydney',
      maxCandidateThreads: 10,
      maxModelAttempts: 3,
      maxDraftsPerDay: 5,
    },
  };
  const proposed = structuredClone(previous);
  proposed.version = 2;
  Object.assign(proposed.binding, {
    readerBindingId: id(8),
    writerBindingId: id(9),
    writerDigest: digest('new-writer'),
    writerConsentRef: digest('new-consent'),
    contextGeneration: id(10),
  });
  const expectedHead = {
    revision: 1,
    scopeId: previous.scopeId,
    policyId: previous.id,
    policyVersion: 1,
    profileDigest: digest(previous),
    enabled,
  };
  return {
    binding,
    previous,
    proposed,
    expectedHead,
    actualHead: structuredClone(expectedHead),
    currentGeneration: id(10),
    requestId: id(11),
  };
}
for (const enabled of [true, false])
  test(`plans only a fresh-consent revision and preserves independent enabled=${enabled}`, () => {
    const x = fixture(enabled),
      before = structuredClone(x),
      p = planReviewRelink(x);
    assert.deepEqual(x, before);
    assert.equal(p.policyId, x.previous.id);
    assert.equal(p.expectedRevision, 1);
    assert.equal(p.nextHead.revision, 2);
    assert.equal(p.nextHead.policyVersion, 2);
    assert.equal(p.nextHead.enabled, enabled);
    assert.equal(p.profileDigest, digest(x.proposed));
    assert.equal(p.currentGeneration, x.currentGeneration);
    for (const k of [
      'executionGranted',
      'newRuntimeAuthority',
      'newModelAllowance',
      'contextResetAllowed',
      'oldFenceRemovalAllowed',
      'draftJournalResetAllowed',
    ] as const)
      assert.equal(p[k], false);
    assert.equal(p.requiresFreshOwnerReadiness, true);
    assert.equal(p.requiresFreshReaderWriterConsentAndRecovery, true);
  });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Intentionally malformed fixtures test runtime rejection at the owner boundary.
type MalformedFixture = any;
const changes: Record<string, (x: MalformedFixture) => void> = {
  stale_actual_head: (x) => x.actualHead.revision++,
  later_independent_disable: (x) => {
    x.actualHead.revision++;
    x.actualHead.enabled = false;
  },
  missing_head: (x) => (x.actualHead = null),
  wrong_head_profile: (x) => {
    x.expectedHead.profileDigest = digest('other');
    x.actualHead = structuredClone(x.expectedHead);
  },
  changed_native_owner: (x) => (x.binding.ownerId = 'other'),
  changed_scope: (x) => (x.proposed.scopeId = 'other'),
  changed_owner: (x) => (x.proposed.ownerId = 'other'),
  changed_session: (x) => (x.proposed.sessionId = 'other'),
  changed_group: (x) => (x.proposed.agentGroupId = 'other'),
  changed_installation: (x) => (x.proposed.installationDigest = digest('other')),
  changed_independent_journal: (x) => (x.proposed.journalGeneration = id(12)),
  changed_policy_id: (x) => (x.proposed.id = id(12)),
  skipped_policy_version: (x) => (x.proposed.version = 3),
  same_policy_version: (x) => (x.proposed.version = 1),
  changed_morning_schedule: (x) => (x.proposed.binding.morningScheduleId = id(12)),
  changed_afternoon_schedule: (x) => (x.proposed.binding.afternoonScheduleId = id(12)),
  changed_mailbox: (x) => (x.proposed.binding.mailboxDigest = digest('other-mailbox')),
  changed_native_binding: (x) => (x.proposed.binding.nativeBindingDigest = digest('other')),
  repeated_closed_reader: (x) => (x.proposed.binding.readerBindingId = x.previous.binding.readerBindingId),
  repeated_old_writer: (x) => (x.proposed.binding.writerBindingId = x.previous.binding.writerBindingId),
  identical_reader_and_writer: (x) => (x.proposed.binding.writerBindingId = x.proposed.binding.readerBindingId),
  old_consent_digest: (x) => (x.proposed.binding.writerConsentRef = x.previous.binding.writerConsentRef),
  old_writer_digest: (x) => (x.proposed.binding.writerDigest = x.previous.binding.writerDigest),
  nonfresh_writer_version: (x) => (x.proposed.binding.writerVersion = 2),
  unverified_current_generation: (x) => (x.currentGeneration = x.previous.binding.contextGeneration),
  unchanged_old_generation: (x) => {
    x.currentGeneration = x.previous.binding.contextGeneration;
    x.proposed.binding.contextGeneration = x.currentGeneration;
  },
  reused_old_writer_as_reader: (x) => (x.proposed.binding.readerBindingId = x.previous.binding.writerBindingId),
  larger_draft_limit: (x) => (x.proposed.binding.maxDraftsPerDay = 6),
  larger_model_limit: (x) => (x.proposed.binding.maxModelAttempts = 4),
  larger_candidate_limit: (x) => (x.proposed.binding.maxCandidateThreads = 11),
  foreign_time_zone: (x) => (x.proposed.binding.timeZone = 'UTC'),
  invalid_request: (x) => (x.requestId = 'not-a-uuid'),
  unknown_profile_field: (x) => (x.proposed.enabled = true),
  overflow_policy_version: (x) => {
    x.previous.version = 2147483647;
    x.expectedHead.policyVersion = x.previous.version;
    x.expectedHead.profileDigest = digest(x.previous);
    x.actualHead = structuredClone(x.expectedHead);
    x.proposed.version = 2147483648;
  },
};
for (const [name, change] of Object.entries(changes))
  test('denies ' + name, () => {
    const x = fixture();
    change(x);
    assert.throws(() => planReviewRelink(x), /mail_review_rebind_unverified/);
  });
export { fixture };

for (const field of ['format', 'expectedRevision', 'expectedPinDigest', 'previousProfileDigest', 'extra'] as const)
  test('rejects malformed rebind manifest ' + field, () => {
    const value = request(fixture());
    if (field === 'format') value.manifest.format = 'wrong';
    else if (field === 'expectedRevision') value.manifest.expectedRevision = 0;
    else if (field === 'expectedPinDigest') value.manifest.expectedPinDigest = digest('wrong');
    else if (field === 'previousProfileDigest') value.manifest.previousProfileDigest = digest('wrong');
    else Object.assign(value.manifest, { extra: true });
    assert.throws(() => planMailReviewRebind(value), /mail_review_rebind_unverified/);
  });
