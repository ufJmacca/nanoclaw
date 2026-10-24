import fs from 'node:fs';
import path from 'node:path';
import {
  contextGenerationPattern,
  privateConversationDirectory,
  syncConversationDirectory,
} from '../ops/conversation-ownership.js';
import { readPrivate, writeAtomic } from '../ops/target-state.js';
import { DraftJournal, initializeDraftJournal } from './journal.js';
export type DraftHostOwner = {
  format: 'cos-mail-draft-host-owner/v1';
  installationDigest: string;
  journalGeneration: string;
};
export function readTargetDraftOwner(targetRoot: string, installationDigest: string): DraftHostOwner {
  privateConversationDirectory(targetRoot);
  const root = path.join(targetRoot, 'mail-drafts'),
    file = path.join(root, 'owner.json');
  privateConversationDirectory(root);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file) throw Error('unsafe_mail_draft_owner');
  const owner = readPrivate<DraftHostOwner>(file);
  if (
    !owner ||
    Object.keys(owner).sort().join(',') !== 'format,installationDigest,journalGeneration' ||
    owner.format !== 'cos-mail-draft-host-owner/v1' ||
    !/^[a-f0-9]{64}$/.test(installationDigest) ||
    owner.installationDigest !== installationDigest ||
    typeof owner.journalGeneration !== 'string' ||
    !contextGenerationPattern.test(owner.journalGeneration)
  )
    throw Error('unsafe_mail_draft_owner');
  return owner;
}
/** Runtime opens only this installation's independent history. Neither function creates a policy grant. */
export function openTargetDraftJournal(targetRoot: string, installationDigest: string): DraftJournal {
  const owner = readTargetDraftOwner(targetRoot, installationDigest);
  return new DraftJournal(path.join(targetRoot, 'mail-drafts/effects'), installationDigest, owner.journalGeneration);
}
/** Explicit trusted target setup only. A partial/lost existing ownership root stays closed. */
export function initializeTargetDraftJournal(targetRoot: string, installationDigest: string): DraftJournal {
  privateConversationDirectory(targetRoot);
  if (!/^[a-f0-9]{64}$/.test(installationDigest)) throw Error('unsafe_mail_draft_owner');
  const root = path.join(targetRoot, 'mail-drafts');
  if (fs.lstatSync(root, { throwIfNoEntry: false })) return openTargetDraftJournal(targetRoot, installationDigest);
  fs.mkdirSync(root, { mode: 0o700 });
  syncConversationDirectory(targetRoot);
  const journal = initializeDraftJournal(path.join(root, 'effects'), installationDigest);
  writeAtomic(root, 'owner.json', {
    format: 'cos-mail-draft-host-owner/v1',
    installationDigest,
    journalGeneration: journal.generation,
  } satisfies DraftHostOwner);
  return openTargetDraftJournal(targetRoot, installationDigest);
}
