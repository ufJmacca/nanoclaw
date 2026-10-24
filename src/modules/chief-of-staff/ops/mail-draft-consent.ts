import fs from 'node:fs';
import path from 'node:path';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import type { DraftJournal } from '../mail-drafts/journal.js';
import { readTargetDraftOwner } from '../mail-drafts/host-ownership.js';
import {
  validMailDraftCredentialRecoveryIdentity,
  type MailDraftCredentialRecoveryIdentity,
} from '../mail-drafts/credential-recovery.js';
import { contextGenerationPattern, privateConversationDirectory } from './conversation-ownership.js';
import { readPrivate } from './target-state.js';

export type MailDraftAccountConsent = {
  format: 'cos-mail-draft-account-consent/v1';
  installationDigest: string;
  nativeBindingDigest: string;
  journalGeneration: string;
  requestId: string;
  readerConnectionDigest: string;
  selection: MailDraftCredentialRecoveryIdentity;
};
/** Completed owner-link metadata only. This cannot activate credentials or writer policy,
 * replace missing history, or substitute for an actual encrypted recovery proof. */
export function readMailDraftAccountConsent(
  root: string,
  installationDigest: string,
  binding: CosBinding,
  writerBindingId: string,
  journal: DraftJournal,
): MailDraftAccountConsent {
  try {
    const current = () => {
      const owner = readTargetDraftOwner(root, installationDigest);
      if (
        journal.root !== path.join(root, 'mail-drafts/effects') ||
        journal.installationDigest !== installationDigest ||
        journal.generation !== owner.journalGeneration
      )
        throw Error('consent_journal_changed');
      journal.assertCurrent();
    };
    current();
    if (binding.provider !== 'codex' || !contextGenerationPattern.test(writerBindingId))
      throw Error('consent_owner_invalid');
    const parent = path.join(root, 'mail-draft-admin'),
      directory = path.join(parent, writerBindingId),
      file = path.join(directory, 'consent.json');
    privateConversationDirectory(parent);
    privateConversationDirectory(directory);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file) throw Error('consent_file_unsafe');
    const value = readPrivate<MailDraftAccountConsent>(file),
      hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
    if (
      !value ||
      Object.keys(value).sort().join(',') !==
        'format,installationDigest,journalGeneration,nativeBindingDigest,readerConnectionDigest,requestId,selection' ||
      value.format !== 'cos-mail-draft-account-consent/v1' ||
      !hash(installationDigest) ||
      value.installationDigest !== installationDigest ||
      value.nativeBindingDigest !== digest(binding) ||
      value.journalGeneration !== journal.generation ||
      typeof value.requestId !== 'string' ||
      !contextGenerationPattern.test(value.requestId) ||
      !hash(value.readerConnectionDigest) ||
      !validMailDraftCredentialRecoveryIdentity(value.selection) ||
      value.selection.scopeId !== binding.scopeId ||
      value.selection.writerBindingId !== writerBindingId ||
      value.selection.writerReference !== writerBindingId
    )
      throw Error('consent_identity_changed');
    current();
    return structuredClone(value);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private owner paths, account references and journal diagnostics stay behind a fixed boundary.
    throw Error('mail_draft_consent_unavailable');
  }
}
