import fs from 'node:fs';
import path from 'node:path';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import type { DraftJournal, MailReviewPolicyHead } from '../mail-drafts/journal.js';
import { readTargetDraftOwner } from '../mail-drafts/host-ownership.js';
import { contextGenerationPattern } from './conversation-ownership.js';
import { readPrivate, writeAtomic } from './target-state.js';
import {
  mailReviewProfileName,
  parseMailReviewHostProfile,
  readMailReviewHostProfile,
  type MailReviewHostProfile,
} from '../automation/mail-review-profile.js';

type Options = {
  targetRoot: string;
  installationDigest: string;
  journal: DraftJournal;
  binding: CosBinding;
  profile: MailReviewHostProfile;
  requestId: string;
  /** Actual paused native/maintenance, current main generation, credential consent and recovery checks. */
  ready(): Promise<void>;
  assertAuthority(): void;
  /** Trusted migration writer; must use writeMailReviewStandingPolicy and the supplied ready fence. */
  writePolicy(ready: () => Promise<void>): Promise<void>;
};

/** Initial setup only. Missing/partial publication stays closed; replay cannot undo independent disable.
 * Caller owns the real paused administrative leases. This function cannot initialize history or resume CoS. */
export async function publishInitialMailReview(o: Options): Promise<MailReviewPolicyHead> {
  const data = () => ({
    targetRoot: o.targetRoot,
    installationDigest: o.installationDigest,
    binding: o.binding,
    profile: o.profile,
    requestId: o.requestId,
  });
  const original = digest(data()),
    profile = parseMailReviewHostProfile(o.profile),
    binding = structuredClone(o.binding),
    journal = o.journal,
    assertAuthority = o.assertAuthority,
    checkReady = o.ready;
  if (
    !contextGenerationPattern.test(o.requestId) ||
    binding.provider !== 'codex' ||
    profile.version !== 1 ||
    profile.scopeId !== binding.scopeId ||
    profile.ownerId !== binding.ownerId ||
    profile.sessionId !== binding.sessionId ||
    profile.agentGroupId !== binding.agentGroupId ||
    profile.binding.nativeBindingDigest !== digest(binding) ||
    profile.installationDigest !== o.installationDigest ||
    profile.journalGeneration !== journal.generation ||
    journal.installationDigest !== o.installationDigest ||
    journal.root !== path.join(o.targetRoot, 'mail-drafts/effects')
  )
    throw Error('mail_review_configuration_identity_changed');
  const directory = path.join(o.targetRoot, 'mail-drafts'),
    name = mailReviewProfileName(binding.scopeId),
    file = path.join(directory, name);
  const read = () => {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file)
      throw Error('mail_review_configuration_file_changed');
    return parseMailReviewHostProfile(readPrivate(file));
  };
  const existing = read();
  if (existing && digest(existing) !== digest(profile)) throw Error('mail_review_configuration_file_changed');
  let expectedFile = digest(existing),
    expectedHead = journal.reviewPolicyPin(binding.scopeId);
  if (
    expectedHead &&
    (!expectedHead.enabled ||
      expectedHead.revision !== 1 ||
      expectedHead.policyId !== profile.id ||
      expectedHead.policyVersion !== 1 ||
      expectedHead.profileDigest !== digest(profile))
  )
    throw Error('mail_review_configuration_closed');
  const guard = () => {
    assertAuthority();
    if (o.journal !== journal || digest(data()) !== original) throw Error('mail_review_configuration_inputs_changed');
    const owner = readTargetDraftOwner(o.targetRoot, o.installationDigest);
    journal.assertCurrent();
    if (owner.journalGeneration !== journal.generation || digest(read()) !== expectedFile)
      throw Error('mail_review_configuration_file_changed');
  };
  const ready = async () => {
    guard();
    await checkReady();
    guard();
    if (digest(journal.reviewPolicyPin(binding.scopeId)) !== digest(expectedHead))
      throw Error('mail_review_configuration_pin_changed');
  };
  await ready();
  await o.writePolicy(ready);
  await ready();
  // Journal owns this compare-and-swap. Its synchronous checks must not mistake its own new head for a foreign change.
  const head = journal.publishReviewPolicyPin(
    {
      requestId: o.requestId,
      expectedRevision: 0,
      enabled: true,
      pin: {
        scopeId: profile.scopeId,
        policyId: profile.id,
        policyVersion: 1,
        profileDigest: digest(profile),
      },
    },
    guard,
  );
  expectedHead = structuredClone(head);
  await ready();
  if (!existing) {
    writeAtomic(directory, name, profile);
    expectedFile = digest(profile);
  }
  await ready();
  if (
    digest(readMailReviewHostProfile(o.targetRoot, o.installationDigest, journal, binding.scopeId)) !== digest(profile)
  )
    throw Error('mail_review_configuration_readback_changed');
  return structuredClone(head);
}
