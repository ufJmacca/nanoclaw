import path from 'node:path';
import type Database from 'better-sqlite3';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import {
  contextGenerationPattern,
  privateConversationDirectory,
  readConversationOwner,
} from './conversation-ownership.js';

/** Trusted paused setup only. Missing ownership or history is not a request to initialize or renew it. */
export function mailReviewContextCurrent(
  db: Database.Database,
  root: string,
  binding: CosBinding,
  generation: string,
  accountFingerprint: string,
): boolean {
  try {
    if (
      binding.provider !== 'codex' ||
      !contextGenerationPattern.test(generation) ||
      !/^[a-f0-9]{64}$/.test(accountFingerprint)
    )
      return false;
    const read = () =>
      db
        .prepare(
          'SELECT generation,status,binding_digest,account_fingerprint FROM cos_conversation_states WHERE scope_id=?',
        )
        .get(binding.scopeId) as
        | { generation: string; status: string; binding_digest: string; account_fingerprint: string }
        | undefined;
    const row = read();
    if (
      !row ||
      row.status !== 'active' ||
      row.generation !== generation ||
      row.binding_digest !== digest(binding) ||
      row.account_fingerprint !== accountFingerprint
    )
      return false;
    const owner = readConversationOwner(root, generation, binding);
    if (owner.state !== 'retained' || owner.accountFingerprint !== accountFingerprint) return false;
    privateConversationDirectory(path.join(root, 'conversations'));
    privateConversationDirectory(path.join(root, 'conversations', generation));
    return digest(read()) === digest(row) && digest(readConversationOwner(root, generation, binding)) === digest(owner);
    // eslint-disable-next-line no-catch-all/no-catch-all -- Missing or unsafe private ownership closes configuration without exposing paths or repairing history.
  } catch {
    return false;
  }
}
