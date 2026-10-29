import fs from 'node:fs';
import path from 'node:path';
import { digest, type Context } from '../domain/contracts.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import type { DraftJournal } from '../mail-drafts/journal.js';
import { readTargetDraftOwner } from '../mail-drafts/host-ownership.js';
import { readPrivate } from '../ops/target-state.js';
import { contextGenerationPattern } from '../ops/conversation-ownership.js';
import { validMailReviewBinding, type MailReviewBinding } from './mail-review-binding.js';
import type { MailReviewSelection } from './mail-review-access.js';

export type MailReviewHostProfile = Pick<Context, 'scopeId' | 'ownerId' | 'agentGroupId' | 'sessionId'> & {
  format: 'cos-mail-review-host/v1';
  installationDigest: string;
  journalGeneration: string;
  id: string;
  version: number;
  binding: MailReviewBinding;
};
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function mailReviewProfileName(scopeId: string): string {
  if (typeof scopeId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(scopeId))
    throw Error('mail_review_profile_invalid');
  return 'review-profile-' + digest(scopeId) + '.json';
}
/** References only. SQL policy, actual native identity, source/credential fences and journal checks remain required. */
export function parseMailReviewHostProfile(value: unknown): MailReviewHostProfile {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'agentGroupId,binding,format,id,installationDigest,journalGeneration,ownerId,scopeId,sessionId,version'
  )
    throw Error('mail_review_profile_invalid');
  const p = value as MailReviewHostProfile;
  if (
    p.format !== 'cos-mail-review-host/v1' ||
    !hash(p.installationDigest) ||
    typeof p.journalGeneration !== 'string' ||
    !contextGenerationPattern.test(p.journalGeneration) ||
    typeof p.id !== 'string' ||
    !contextGenerationPattern.test(p.id) ||
    !Number.isSafeInteger(p.version) ||
    p.version < 1 ||
    p.version > 2147483647 ||
    !['scopeId', 'ownerId', 'sessionId', 'agentGroupId'].every(
      (k) =>
        typeof p[k as keyof typeof p] === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(p[k as keyof typeof p] as string),
    ) ||
    !validMailReviewBinding(p.binding) ||
    p.binding.provider !== 'google'
  )
    throw Error('mail_review_profile_invalid');
  return structuredClone(p);
}

/** Runtime read only. An old profile or SQL checkpoint cannot replace the independently owned pin. */
export function readMailReviewHostProfile(
  targetRoot: string,
  installationDigest: string,
  journal: DraftJournal,
  scopeId: string,
): MailReviewHostProfile | null {
  try {
    const name = mailReviewProfileName(scopeId);
    const current = () => {
      const owner = readTargetDraftOwner(targetRoot, installationDigest);
      if (
        journal.root !== path.join(targetRoot, 'mail-drafts/effects') ||
        journal.installationDigest !== installationDigest ||
        journal.generation !== owner.journalGeneration
      )
        throw Error('mail_review_profile_changed');
      journal.assertCurrent();
    };
    current();
    const head = journal.reviewPolicyPin(scopeId);
    if (!head?.enabled) return null;
    const file = path.join(targetRoot, 'mail-drafts', name),
      stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file)
      throw Error('mail_review_profile_changed');
    const profile = parseMailReviewHostProfile(readPrivate(file));
    if (
      profile.installationDigest !== installationDigest ||
      profile.journalGeneration !== journal.generation ||
      profile.scopeId !== scopeId ||
      profile.id !== head.policyId ||
      profile.version !== head.policyVersion ||
      digest(profile) !== head.profileDigest
    )
      throw Error('mail_review_profile_changed');
    current();
    if (digest(journal.reviewPolicyPin(scopeId)) !== digest(head)) throw Error('mail_review_profile_changed');
    return profile;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private policy/journal paths and nested diagnostics never enter runtime output.
    throw Error('mail_review_profile_unavailable');
  }
}

export function mailReviewProfileMatches(
  targetRoot: string,
  installationDigest: string,
  journal: DraftJournal,
  context: KnowledgeContext,
  selection: Omit<MailReviewSelection, 'inputs'>,
): boolean {
  try {
    const p = readMailReviewHostProfile(targetRoot, installationDigest, journal, context.scopeId);
    return (
      !!p &&
      context.provider === 'codex' &&
      p.ownerId === context.ownerId &&
      p.sessionId === context.sessionId &&
      p.agentGroupId === context.agentGroupId &&
      p.binding.contextGeneration === context.generation &&
      p.id === selection.id &&
      p.version === selection.version &&
      digest(p.binding) === selection.digest &&
      digest(p.binding) === digest(selection.body)
    );
    // eslint-disable-next-line no-catch-all/no-catch-all -- Corrupt or missing private ownership metadata cannot grant review access.
  } catch {
    return false;
  }
}
