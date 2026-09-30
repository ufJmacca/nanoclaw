/** Host-only ownership receipts live outside worker-writable provider histories. */
import fs from 'node:fs';
import path from 'node:path';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { readPrivate, writeAtomic } from './target-state.js';
export const contextGenerationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type ConversationOwner = {
  version: 1;
  generation: string;
  bindingDigest: string;
  accountFingerprint: string;
  state: 'retained' | 'purged';
};
export function privateConversationDirectory(file: string): void {
  const stat = fs.lstatSync(file);
  if (
    !path.isAbsolute(file) ||
    path.resolve(file) !== file ||
    fs.realpathSync(file) !== file ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('unsafe_conversation_ownership');
}
export function syncConversationDirectory(file: string): void {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function readConversationOwner(root: string, generation: string, binding: CosBinding): ConversationOwner {
  if (!contextGenerationPattern.test(generation)) throw new Error('unsafe_conversation_ownership');
  privateConversationDirectory(root);
  const owners = path.join(root, 'conversation-owners');
  privateConversationDirectory(owners);
  const row = readPrivate<ConversationOwner>(path.join(owners, generation + '.json'));
  if (
    !row ||
    row.version !== 1 ||
    row.generation !== generation ||
    row.bindingDigest !== digest(binding) ||
    !/^[a-f0-9]{64}$/.test(row.accountFingerprint) ||
    !['retained', 'purged'].includes(row.state)
  )
    throw new Error('unsafe_conversation_ownership');
  return row;
}
/** Called only when native identity proves this generation belongs to this binding/account. */
export function rememberConversationOwner(
  root: string,
  binding: CosBinding,
  accountFingerprint: string,
  generation: string,
): void {
  if (!contextGenerationPattern.test(generation) || !/^[a-f0-9]{64}$/.test(accountFingerprint))
    throw new Error('unsafe_conversation_ownership');
  privateConversationDirectory(root);
  privateConversationDirectory(path.join(root, 'conversations'));
  privateConversationDirectory(path.join(root, 'conversations', generation));
  const owners = path.join(root, 'conversation-owners');
  if (!fs.lstatSync(owners, { throwIfNoEntry: false })) {
    fs.mkdirSync(owners, { mode: 0o700 });
    syncConversationDirectory(root);
  }
  privateConversationDirectory(owners);
  const file = path.join(owners, generation + '.json');
  if (fs.lstatSync(file, { throwIfNoEntry: false })) {
    const old = readConversationOwner(root, generation, binding);
    if (old.accountFingerprint !== accountFingerprint || old.state !== 'retained')
      throw new Error('unsafe_conversation_ownership');
  } else
    writeAtomic(owners, generation + '.json', {
      version: 1,
      generation,
      bindingDigest: digest(binding),
      accountFingerprint,
      state: 'retained',
    } satisfies ConversationOwner);
}
