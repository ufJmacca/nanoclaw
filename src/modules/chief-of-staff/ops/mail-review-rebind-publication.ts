import fs from 'node:fs';
import path from 'node:path';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import type { DraftJournal, MailReviewPolicyHead } from '../mail-drafts/journal.js';
import { readTargetDraftOwner } from '../mail-drafts/host-ownership.js';
import {
  mailReviewProfileName,
  parseMailReviewHostProfile,
  readMailReviewHostProfile,
  type MailReviewHostProfile,
} from '../automation/mail-review-profile.js';
import { contextGenerationPattern } from './conversation-ownership.js';
import { calendarAdminDirectory } from './calendar-admin.js';
import { parseMailReviewRebindManifest, planMailReviewRebind } from './mail-review-rebind-plan.js';
import { readPrivate, writeAtomic } from './target-state.js';

type Snapshot = {
  contract: 'cos-mail-review-rebind-request/v1';
  requestId: string;
  bindingDigest: string;
  manifestDigest: string;
  previous: MailReviewHostProfile;
  previousHead: unknown;
};
type Options = {
  targetRoot: string;
  installationDigest: string;
  journal: DraftJournal;
  binding: CosBinding;
  manifest: unknown;
  requestId: string;
  currentGeneration: string;
  /** Actual paused native, fresh source consent, migration role and recovery checks. */
  ready(): Promise<void>;
  assertAuthority(): void;
  writePolicy(
    ready: () => Promise<void>,
    previous: MailReviewHostProfile,
    profile: MailReviewHostProfile,
    previousHead: MailReviewPolicyHead,
  ): Promise<void>;
};
function need(value: unknown): asserts value {
  if (!value) throw Error('mail_review_rebind_publication_unverified');
}
function checkedJson<T>(file: string): T | undefined {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  need(stat.isFile() && stat.nlink === 1 && fs.realpathSync(file) === file);
  return readPrivate<T>(file);
}

/** Metadata-only request recovery. Stored requests never replace fresh owner authority or the independent pin. */
export async function publishReboundMailReview(o: Options): Promise<MailReviewPolicyHead> {
  const data = () => ({
    targetRoot: o.targetRoot,
    installationDigest: o.installationDigest,
    binding: o.binding,
    manifest: o.manifest,
    requestId: o.requestId,
    currentGeneration: o.currentGeneration,
  });
  const original = digest(data()),
    manifest = parseMailReviewRebindManifest(o.manifest),
    profile = manifest.profile,
    binding = structuredClone(o.binding),
    journal = o.journal,
    assertAuthority = o.assertAuthority,
    checkReady = o.ready,
    writePolicy = o.writePolicy;
  need(contextGenerationPattern.test(o.requestId) && binding.provider === 'codex');
  need(profile.installationDigest === o.installationDigest && profile.journalGeneration === journal.generation);
  const owner = () => {
    assertAuthority();
    need(
      o.journal === journal &&
        o.ready === checkReady &&
        o.writePolicy === writePolicy &&
        o.assertAuthority === assertAuthority &&
        digest(data()) === original,
    );
    need(
      journal.root === path.join(o.targetRoot, 'mail-drafts/effects') &&
        journal.installationDigest === o.installationDigest,
    );
    journal.assertCurrent();
    need(readTargetDraftOwner(o.targetRoot, o.installationDigest).journalGeneration === journal.generation);
  };
  owner();
  await checkReady();
  owner();
  const directory = path.join(o.targetRoot, 'mail-drafts'),
    name = mailReviewProfileName(binding.scopeId),
    file = path.join(directory, name);
  const readProfile = () => {
    const value = checkedJson<unknown>(file);
    need(value);
    return parseMailReviewHostProfile(value);
  };
  const requestRoot = calendarAdminDirectory(
      calendarAdminDirectory(o.targetRoot, 'mail-review-policy-admin'),
      o.requestId,
    ),
    requestFile = path.join(requestRoot, 'rebind-request.json');
  const readSnapshot = () => {
    const value = checkedJson<Snapshot>(requestFile);
    if (value === undefined) return null;
    need(
      value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).sort().join(',') === 'bindingDigest,contract,manifestDigest,previous,previousHead,requestId',
    );
    need(
      value.contract === 'cos-mail-review-rebind-request/v1' &&
        value.requestId === o.requestId &&
        value.bindingDigest === digest(binding) &&
        value.manifestDigest === digest(manifest),
    );
    return { ...value, previous: parseMailReviewHostProfile(value.previous) };
  };
  const stored = readSnapshot(),
    snapshot: Snapshot = stored ?? {
      contract: 'cos-mail-review-rebind-request/v1',
      requestId: o.requestId,
      bindingDigest: digest(binding),
      manifestDigest: digest(manifest),
      previous: readProfile(),
      previousHead: journal.reviewPolicyPin(binding.scopeId),
    };
  const plan = planMailReviewRebind({
    binding,
    previous: snapshot.previous,
    manifest,
    previousHead: snapshot.previousHead,
    currentGeneration: o.currentGeneration,
    requestId: o.requestId,
  });
  let expectedFile = digest(readProfile()),
    expectedHead = journal.reviewPolicyPin(binding.scopeId),
    expectedSnapshot = digest(stored);
  const previousHead = snapshot.previousHead as MailReviewPolicyHead;
  need([plan.previousProfileDigest, plan.profileDigest].includes(expectedFile));
  need(digest(expectedHead) === digest(previousHead) || digest(expectedHead) === digest(plan.nextHead));
  need(expectedFile !== plan.profileDigest || digest(expectedHead) === digest(plan.nextHead));
  const guard = () => {
    owner();
    need(digest(readProfile()) === expectedFile && digest(readSnapshot()) === expectedSnapshot);
  };
  const ready = async () => {
    guard();
    need(digest(journal.reviewPolicyPin(binding.scopeId)) === digest(expectedHead));
    await checkReady();
    guard();
    need(digest(journal.reviewPolicyPin(binding.scopeId)) === digest(expectedHead));
  };
  await ready();
  if (!stored) {
    writeAtomic(requestRoot, 'rebind-request.json', snapshot);
    expectedSnapshot = digest(snapshot);
    await ready();
  }
  const request = {
    requestId: o.requestId,
    expectedRevision: plan.expectedRevision,
    enabled: plan.nextHead.enabled,
    pin: {
      scopeId: plan.nextHead.scopeId,
      policyId: plan.nextHead.policyId,
      policyVersion: plan.nextHead.policyVersion,
      profileDigest: plan.nextHead.profileDigest,
    },
  };
  if (digest(expectedHead) === digest(plan.nextHead)) {
    // Existing new state is usable only if this exact request already owns its journal acknowledgement.
    need(digest(journal.publishReviewPolicyPin(request, guard)) === digest(plan.nextHead));
    await ready();
  }
  await writePolicy(ready, structuredClone(snapshot.previous), structuredClone(profile), structuredClone(previousHead));
  await ready();
  const head = journal.publishReviewPolicyPin(request, guard);
  need(digest(head) === digest(plan.nextHead));
  expectedHead = structuredClone(head);
  await ready();
  // An already visible replacement can still lack its directory-sync acknowledgement.
  guard();
  need(digest(journal.reviewPolicyPin(binding.scopeId)) === digest(expectedHead));
  writeAtomic(directory, name, profile);
  expectedFile = plan.profileDigest;
  await ready();
  const current = readMailReviewHostProfile(o.targetRoot, o.installationDigest, journal, binding.scopeId);
  need(head.enabled ? digest(current) === plan.profileDigest : current === null);
  guard();
  need(digest(journal.reviewPolicyPin(binding.scopeId)) === digest(head));
  return structuredClone(head);
}
