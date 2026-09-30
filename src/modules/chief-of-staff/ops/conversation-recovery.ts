/** Explicit host recovery only. Caller holds the target lock, quiescent maintenance
 * and exact host execution lease, with current private-channel membership verified.
 * Old history and authority are never imported into the fresh generation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { readPrivate, writeAtomic } from './target-state.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Counts = { inbound: number; outbound: number };
type Record = {
  version: 1;
  requestDigest: string;
  generation: string;
  phase: 'prepared' | 'quarantined' | 'complete';
  quarantined?: Counts;
};
type ContextRow = { generation: string; binding_digest: string; account_fingerprint: string; status: string };
function privateDirectory(directory: string) {
  const stat = fs.lstatSync(directory);
  if (
    !path.isAbsolute(directory) ||
    !stat.isDirectory() ||
    fs.realpathSync(directory) !== directory ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('unsafe_context_recovery');
}
function syncDirectory(directory: string) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export async function recoverConversation(options: {
  root: string;
  db: Database.Database;
  inbound: Database.Database;
  outbound: Database.Database;
  binding: CosBinding;
  accountFingerprint: string;
  expectedGeneration: string;
  recoveryId: string;
  assertAuthority(): void;
  /** Idempotent protected backup under this recovery ID, before any queue or history transition. */
  backup(): Promise<void>;
}) {
  const o = options;
  if (
    !uuid.test(o.recoveryId) ||
    !uuid.test(o.expectedGeneration) ||
    !/^[a-f0-9]{64}$/.test(o.accountFingerprint) ||
    o.binding.provider !== 'codex'
  )
    throw new Error('invalid_context_recovery');
  const bindingDigest = digest(o.binding);
  const guard = () => {
    o.assertAuthority();
    const boundary = o.db
      .prepare('SELECT binding,paused FROM cos_identity_boundaries WHERE scope_id=?')
      .get(o.binding.scopeId) as { binding: string; paused: number } | undefined;
    if (!boundary || boundary.paused !== 1 || digest(JSON.parse(boundary.binding)) !== bindingDigest)
      throw new Error('context_recovery_requires_paused_binding');
  };
  const read = () => {
    const value = o.db.prepare('SELECT * FROM cos_conversation_states WHERE scope_id=?').get(o.binding.scopeId) as
      | ContextRow
      | undefined;
    if (!value) throw new Error('context_recovery_requires_existing_generation');
    return value;
  };
  guard();
  privateDirectory(o.root);
  const journal = path.join(o.root, 'context-recoveries');
  if (!fs.lstatSync(journal, { throwIfNoEntry: false })) {
    fs.mkdirSync(journal, { mode: 0o700 });
    syncDirectory(o.root);
  }
  privateDirectory(journal);
  const name = o.recoveryId + '.json';
  const requestDigest = digest({
    binding: o.binding,
    accountFingerprint: o.accountFingerprint,
    expectedGeneration: o.expectedGeneration,
    recoveryId: o.recoveryId,
  });
  let record: Record;
  if (fs.lstatSync(path.join(journal, name), { throwIfNoEntry: false })) {
    record = readPrivate<Record>(path.join(journal, name));
    if (
      record.version !== 1 ||
      record.requestDigest !== requestDigest ||
      !uuid.test(record.generation) ||
      record.generation === o.expectedGeneration ||
      !['prepared', 'quarantined', 'complete'].includes(record.phase)
    )
      throw new Error('context_recovery_conflict');
  } else {
    if (read().generation !== o.expectedGeneration) throw new Error('context_recovery_stale_generation');
    record = { version: 1, requestDigest, generation: randomUUID(), phase: 'prepared' };
    // Fence first. Interruption before the journal write remains explicitly recoverable,
    // while old consent and queued work can no longer acquire this conversation.
    o.db
      .prepare(
        "UPDATE cos_conversation_states SET status='invalidated',reason='operator_recovery',updated_at=? WHERE scope_id=?",
      )
      .run(new Date().toISOString(), o.binding.scopeId);
    writeAtomic(journal, name, record);
  }
  const complete = () => ({
    status: 'recovered_paused' as const,
    generation: record.generation,
    quarantined: record.quarantined!,
  });
  const current = read();
  if (
    record.phase !== 'prepared' &&
    (!record.quarantined ||
      !Number.isSafeInteger(record.quarantined.inbound) ||
      record.quarantined.inbound < 0 ||
      !Number.isSafeInteger(record.quarantined.outbound) ||
      record.quarantined.outbound < 0)
  )
    throw new Error('context_recovery_conflict');
  if (current.generation === record.generation && current.status === 'active' && record.phase !== 'prepared') {
    if (current.binding_digest !== bindingDigest || current.account_fingerprint !== o.accountFingerprint)
      throw new Error('context_recovery_conflict');
    // Lost acknowledgement after completion must not reset a newer conversation or queue.
    if (record.phase !== 'complete') {
      record = { ...record, phase: 'complete' };
      writeAtomic(journal, name, record);
    }
    return complete();
  }
  if (
    record.phase === 'complete' ||
    (!(current.generation === o.expectedGeneration && current.status === 'invalidated') &&
      !(
        current.generation === record.generation &&
        current.status === 'preparing' &&
        current.binding_digest === bindingDigest &&
        current.account_fingerprint === o.accountFingerprint
      ))
  )
    throw new Error('context_recovery_superseded');
  if (record.phase === 'prepared') {
    await o.backup();
    guard();
    const root = path.join(o.root, 'conversations');
    if (!fs.lstatSync(root, { throwIfNoEntry: false })) fs.mkdirSync(root, { mode: 0o700 });
    privateDirectory(root);
    const directory = path.join(root, record.generation);
    if (!fs.lstatSync(directory, { throwIfNoEntry: false })) fs.mkdirSync(directory, { mode: 0o700 });
    privateDirectory(directory);
    if (fs.readdirSync(directory).length) throw new Error('context_recovery_not_empty');
    syncDirectory(directory);
    syncDirectory(root);
    syncDirectory(o.root);
    o.db
      .transaction(() => {
        guard();
        const row = read();
        if (
          ![o.expectedGeneration, record.generation].includes(row.generation) ||
          !['invalidated', 'preparing'].includes(row.status)
        )
          throw new Error('context_recovery_superseded');
        o.db
          .prepare(
            "UPDATE cos_conversation_states SET generation=?,binding_digest=?,account_fingerprint=?,status='preparing',reason='operator_recovery',updated_at=? WHERE scope_id=?",
          )
          .run(record.generation, bindingDigest, o.accountFingerprint, new Date().toISOString(), o.binding.scopeId);
        o.db
          .prepare('UPDATE cos_identity_boundaries SET ingress_id=NULL,ingress_at=NULL WHERE scope_id=? AND paused=1')
          .run(o.binding.scopeId);
        o.db.prepare('UPDATE cos_ingress_receipts SET projected=1 WHERE scope_id=?').run(o.binding.scopeId);
      })
      .immediate();
    // Inbound owns both processing eligibility and delivery outcomes. Outbound data is
    // read only: old messages, continuation keys and receipts remain available for audit.
    o.inbound.exec(`CREATE TABLE IF NOT EXISTS cos_context_recovery_receipts (
      recovery_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, inbound_count INTEGER NOT NULL, outbound_count INTEGER NOT NULL)`);
    const counts = o.inbound
      .transaction(() => {
        guard();
        const previous = o.inbound
          .prepare('SELECT * FROM cos_context_recovery_receipts WHERE recovery_id=?')
          .get(o.recoveryId) as { request_digest: string; inbound_count: number; outbound_count: number } | undefined;
        if (previous) {
          if (previous.request_digest !== requestDigest) throw new Error('context_recovery_conflict');
          return { inbound: previous.inbound_count, outbound: previous.outbound_count };
        }
        const inbound = o.inbound
          .prepare("UPDATE messages_in SET status='failed',trigger=0 WHERE status IN ('pending','processing')")
          .run().changes;
        const insert = o.inbound.prepare(
          "INSERT OR IGNORE INTO delivered(message_out_id,platform_message_id,status,delivered_at) VALUES(?,NULL,'quarantined_context_recovery',?)",
        );
        let outbound = 0;
        for (const row of o.outbound.prepare('SELECT id FROM messages_out').iterate() as Iterable<{ id: string }>)
          outbound += insert.run(row.id, new Date().toISOString()).changes;
        o.inbound
          .prepare('INSERT INTO cos_context_recovery_receipts VALUES(?,?,?,?)')
          .run(o.recoveryId, requestDigest, inbound, outbound);
        return { inbound, outbound };
      })
      .immediate();
    record = { ...record, phase: 'quarantined', quarantined: counts };
    writeAtomic(journal, name, record);
  }
  o.db
    .transaction(() => {
      guard();
      const row = read();
      if (
        row.generation !== record.generation ||
        row.status !== 'preparing' ||
        row.binding_digest !== bindingDigest ||
        row.account_fingerprint !== o.accountFingerprint
      )
        throw new Error('context_recovery_superseded');
      privateDirectory(path.join(o.root, 'conversations', record.generation));
      o.db
        .prepare("UPDATE cos_conversation_states SET status='active',reason=NULL,updated_at=? WHERE scope_id=?")
        .run(new Date().toISOString(), o.binding.scopeId);
    })
    .immediate();
  record = { ...record, phase: 'complete' };
  writeAtomic(journal, name, record);
  return complete();
}
