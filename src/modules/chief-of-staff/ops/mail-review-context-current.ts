import path from 'node:path';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import {
  contextGenerationPattern,
  privateConversationDirectory,
  readConversationOwner,
} from './conversation-ownership.js';
import { readPrivate } from './target-state.js';

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

/** Read-only predecessor proof, alongside the caller's fresh paused owner lease. A recovery
 * receipt cannot create a context, change history, import a lease or replenish model use. */
export function mailReviewContextRecoveryCurrent(
  db: Database.Database,
  root: string,
  binding: CosBinding,
  previousGeneration: string,
  generation: string,
  accountFingerprint: string,
): boolean {
  try {
    if (
      !contextGenerationPattern.test(previousGeneration) ||
      previousGeneration === generation ||
      !mailReviewContextCurrent(db, root, binding, generation, accountFingerprint)
    )
      return false;
    const oldOwner = readConversationOwner(root, previousGeneration, binding);
    if (oldOwner.state !== 'retained' || oldOwner.accountFingerprint !== accountFingerprint) return false;
    privateConversationDirectory(path.join(root, 'conversations', previousGeneration));
    const directory = path.join(root, 'context-recoveries');
    privateConversationDirectory(directory);
    const names = fs.readdirSync(directory);
    if (!names.length || names.length > 4096) return false;
    const matches: Array<{ file: string; digest: string }> = [];
    for (const name of names) {
      const recoveryId = name.slice(0, -5);
      if (!name.endsWith('.json') || !contextGenerationPattern.test(recoveryId)) return false;
      const file = path.join(directory, name),
        stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file) return false;
      const record = readPrivate<Record<string, unknown>>(file);
      if (!record || record.generation !== generation) continue;
      const counts = record.quarantined as Record<string, unknown> | undefined;
      if (
        Object.keys(record).sort().join(',') !== 'generation,phase,quarantined,requestDigest,version' ||
        record.version !== 1 ||
        record.phase !== 'complete' ||
        record.requestDigest !==
          digest({ binding, accountFingerprint, expectedGeneration: previousGeneration, recoveryId }) ||
        !counts ||
        Object.keys(counts).sort().join(',') !== 'inbound,outbound' ||
        !Number.isSafeInteger(counts.inbound) ||
        Number(counts.inbound) < 0 ||
        !Number.isSafeInteger(counts.outbound) ||
        Number(counts.outbound) < 0
      )
        return false;
      matches.push({ file, digest: digest(record) });
    }
    if (matches.length !== 1) return false;
    return (
      digest(readPrivate(matches[0].file)) === matches[0].digest &&
      digest(readConversationOwner(root, previousGeneration, binding)) === digest(oldOwner) &&
      mailReviewContextCurrent(db, root, binding, generation, accountFingerprint)
    );
    // eslint-disable-next-line no-catch-all/no-catch-all -- Missing or unsafe private recovery evidence closes rebind without exposing diagnostics or repairing history.
  } catch {
    return false;
  }
}
