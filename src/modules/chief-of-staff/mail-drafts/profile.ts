import type { Context } from '../domain/contracts.js';
import type { MailDraftBinding } from './binding.js';
import type { DraftJournal } from './journal.js';
import fs from 'node:fs';
import path from 'node:path';
import { readPrivate } from '../ops/target-state.js';
import { contextGenerationPattern } from '../ops/conversation-ownership.js';
import { readTargetDraftOwner } from './host-ownership.js';
import { validMailDraftBinding } from './binding.js';
export type MailDraftHostGrant = Pick<Context, 'scopeId' | 'ownerId' | 'agentGroupId' | 'sessionId'> & {
  id: string;
  version: number;
  backupOperationId: string;
  targetBackupDigest: string;
  writeEnabled: boolean;
  binding: MailDraftBinding;
};
export type MailDraftHostProfile = {
  format: 'cos-mail-draft-host/v1';
  installationDigest: string;
  journalGeneration: string;
  grants: MailDraftHostGrant[];
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function validGrant(value: unknown): value is MailDraftHostGrant {
  return (
    object(value) &&
    Object.keys(value).sort().join(',') ===
      'agentGroupId,backupOperationId,binding,id,ownerId,scopeId,sessionId,targetBackupDigest,version,writeEnabled' &&
    ['scopeId', 'ownerId', 'agentGroupId', 'sessionId'].every(
      (key) => typeof value[key] === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value[key]),
    ) &&
    typeof value.id === 'string' &&
    contextGenerationPattern.test(value.id) &&
    Number.isSafeInteger(value.version) &&
    Number(value.version) > 0 &&
    Number(value.version) <= 2147483647 &&
    typeof value.backupOperationId === 'string' &&
    /^release-[a-zA-Z0-9_-]{1,120}$/.test(value.backupOperationId) &&
    hash(value.targetBackupDigest) &&
    typeof value.writeEnabled === 'boolean' &&
    validMailDraftBinding(value.binding) &&
    value.binding.provider === 'google'
  );
}
/** A shape check only. Current database, native owner and actual recovery proof checks remain mandatory. */
export function parseMailDraftHostGrant(value: unknown): MailDraftHostGrant {
  if (!validGrant(value)) throw Error('invalid_mail_draft_manifest');
  return structuredClone(value);
}
/** Metadata cannot adopt another installation's journal or create missing consent/configuration. */
export function readMailDraftHostProfile(
  targetRoot: string,
  installationDigest: string,
  journal: DraftJournal,
): MailDraftHostProfile {
  try {
    const current = () => {
      const owner = readTargetDraftOwner(targetRoot, installationDigest);
      if (
        journal.root !== path.join(targetRoot, 'mail-drafts/effects') ||
        journal.installationDigest !== installationDigest ||
        journal.generation !== owner.journalGeneration
      )
        throw Error('unsafe_mail_draft_profile');
      journal.assertCurrent();
    };
    current();
    const file = path.join(targetRoot, 'mail-drafts/writer-profile.json'),
      stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file) throw Error('unsafe_mail_draft_profile');
    const profile = readPrivate<unknown>(file);
    if (
      !object(profile) ||
      Object.keys(profile).sort().join(',') !== 'format,grants,installationDigest,journalGeneration' ||
      profile.format !== 'cos-mail-draft-host/v1' ||
      !hash(installationDigest) ||
      profile.installationDigest !== installationDigest ||
      profile.journalGeneration !== journal.generation ||
      !Array.isArray(profile.grants) ||
      profile.grants.length < 1 ||
      profile.grants.length > 10 ||
      !profile.grants.every(validGrant)
    )
      throw Error('unsafe_mail_draft_profile');
    const grants: MailDraftHostGrant[] = profile.grants;
    const enabled = grants
      .filter((grant) => grant.writeEnabled)
      .map((grant) => grant.scopeId + ':' + grant.binding.readerBindingId);
    if (
      grants.some((grant) => grant.binding.journalGeneration !== journal.generation) ||
      new Set(grants.map((grant) => grant.id)).size !== grants.length ||
      new Set(grants.map((grant) => grant.binding.credentialReference)).size !== grants.length ||
      new Set(enabled).size !== enabled.length
    )
      throw Error('unsafe_mail_draft_profile');
    current();
    return profile as MailDraftHostProfile;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private paths, policy metadata and nested ownership diagnostics stay behind a fixed boundary.
    throw Error('mail_draft_profile_unavailable');
  }
}
