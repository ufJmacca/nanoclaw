/** Host-owned conversation identity. Native history is durable but never grants authority. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CosBinding } from '../../../cos-boundary.js';
import { rememberConversationOwner } from '../ops/conversation-ownership.js';
import { digest } from '../domain/contracts.js';

type Row = { binding_digest: string; account_fingerprint: string; generation: string; status: string };
function privateDirectory(directory: string) {
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    fs.realpathSync(directory) !== directory ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('cos_context_recovery_required');
}
export function ensureConversationSchema(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS cos_conversation_states (
    scope_id TEXT PRIMARY KEY, binding_digest TEXT NOT NULL, account_fingerprint TEXT NOT NULL,
    generation TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('preparing','active','invalidated')),
    reason TEXT, updated_at TEXT NOT NULL);`);
}
export function createConversationState(targetRoot: string, db: Database.Database) {
  privateDirectory(targetRoot);
  const root = path.join(targetRoot, 'conversations');
  if (!fs.lstatSync(root, { throwIfNoEntry: false })) fs.mkdirSync(root, { mode: 0o700 });
  privateDirectory(root);
  ensureConversationSchema(db);
  const read = (scope: string) =>
    db.prepare('SELECT * FROM cos_conversation_states WHERE scope_id=?').get(scope) as Row | undefined;
  const directoryFor = (generation: string) => {
    if (!/^[0-9a-f-]{36}$/.test(generation)) throw new Error('cos_context_recovery_required');
    return path.join(root, generation);
  };
  const verify = (binding: CosBinding, account: string, row: Row | undefined) => {
    if (
      !row ||
      row.status !== 'active' ||
      row.binding_digest !== digest(binding) ||
      row.account_fingerprint !== account
    )
      throw new Error('cos_context_recovery_required');
    const directory = directoryFor(row.generation);
    privateDirectory(root);
    privateDirectory(directory);
    return { generation: row.generation, directory };
  };
  return {
    prepare(binding: CosBinding, accountFingerprint: string) {
      if (!binding.scopeId || binding.provider !== 'codex' || !/^[0-9a-f]{64}$/.test(accountFingerprint))
        throw new Error('cos_context_recovery_required');
      const previous = read(binding.scopeId);
      if (previous) {
        if (previous.binding_digest !== digest(binding) || previous.account_fingerprint !== accountFingerprint) {
          db.prepare(
            "UPDATE cos_conversation_states SET status='invalidated',reason='access_changed',updated_at=? WHERE scope_id=?",
          ).run(new Date().toISOString(), binding.scopeId);
          throw new Error('cos_context_recovery_required');
        }
        try {
          const context = verify(binding, accountFingerprint, previous);
          rememberConversationOwner(targetRoot, binding, accountFingerprint, context.generation);
          return context;
        } catch (error) {
          db.prepare(
            "UPDATE cos_conversation_states SET status='invalidated',reason=COALESCE(reason,'operator_recovery'),updated_at=? WHERE scope_id=?",
          ).run(new Date().toISOString(), binding.scopeId);
          throw new Error('cos_context_recovery_required', { cause: error });
        }
      }
      privateDirectory(root);
      const generation = randomUUID(),
        directory = directoryFor(generation);
      // Persist intent first. An interrupted or missing filesystem must never be
      // treated as a clean initial binding on the next process start.
      db.prepare(
        "INSERT INTO cos_conversation_states(scope_id,binding_digest,account_fingerprint,generation,status,updated_at) VALUES(?,?,?,?,'preparing',?)",
      ).run(binding.scopeId, digest(binding), accountFingerprint, generation, new Date().toISOString());
      fs.mkdirSync(directory, { mode: 0o700 });
      privateDirectory(directory);
      const descriptor = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try {
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      db.prepare(
        "UPDATE cos_conversation_states SET status='active',updated_at=? WHERE scope_id=? AND generation=? AND status='preparing'",
      ).run(new Date().toISOString(), binding.scopeId, generation);
      rememberConversationOwner(targetRoot, binding, accountFingerprint, generation);
      return verify(binding, accountFingerprint, read(binding.scopeId));
    },
    current(binding: CosBinding, accountFingerprint: string, generation: string) {
      try {
        return verify(binding, accountFingerprint, read(binding.scopeId)).generation === generation;
        // eslint-disable-next-line no-catch-all/no-catch-all -- Any inaccessible or corrupt private state closes admission without revealing paths.
      } catch {
        return false;
      }
    },
    invalidate(scopeId: string, reason: 'access_changed' | 'operator_recovery') {
      db.prepare("UPDATE cos_conversation_states SET status='invalidated',reason=?,updated_at=? WHERE scope_id=?").run(
        reason,
        new Date().toISOString(),
        scopeId,
      );
    },
  };
}
