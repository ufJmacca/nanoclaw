import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureCosBoundarySchema, installCosBoundary, type CosBinding } from '../../../cos-boundary.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../../../db/schema.js';
import { createConversationState } from '../bridge/conversation-state.js';
import { recoverConversation } from './conversation-recovery.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) close();
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-recovery-'));
  const db = new Database(':memory:'),
    inbound = new Database(':memory:'),
    outbound = new Database(':memory:');
  cleanups.push(() => {
    db.close();
    inbound.close();
    outbound.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  ensureCosBoundarySchema(db);
  inbound.exec(INBOUND_SCHEMA);
  outbound.exec(OUTBOUND_SCHEMA);
  const binding: CosBinding = {
    scopeId: 'scope',
    ownerId: 'owner',
    botId: 'bot',
    instanceId: 'instance',
    channelId: 'channel',
    agentGroupId: 'group',
    messagingGroupId: 'messages',
    sessionId: 'session',
    provider: 'codex',
  };
  installCosBoundary(binding, db);
  const accountFingerprint = 'a'.repeat(64),
    contexts = createConversationState(root, db);
  const old = contexts.prepare(binding, accountFingerprint);
  fs.writeFileSync(path.join(old.directory, 'history'), 'old discussion');
  inbound.exec(
    "INSERT INTO messages_in(id,kind,timestamp,content) VALUES('old-input','chat','fixture','old private prompt'); INSERT INTO messages_in(id,kind,timestamp,status,content) VALUES('completed','chat','fixture','completed','completed prompt');",
  );
  outbound.exec(
    "INSERT INTO messages_out(id,kind,timestamp,content) VALUES('unsent','chat','fixture','old answer'); INSERT INTO processing_ack VALUES('old-input','processing','fixture'); INSERT INTO session_state VALUES('ordinary','ordinary continuation','fixture');",
  );
  db.prepare('INSERT INTO cos_ingress_receipts(scope_id,ingress_id,received_at,projected) VALUES(?,?,?,0)').run(
    'scope',
    'old-ingress',
    'fixture',
  );
  const request = {
    root,
    db,
    inbound,
    outbound,
    binding,
    accountFingerprint,
    expectedGeneration: old.generation,
    recoveryId: randomUUID(),
    assertAuthority: vi.fn(),
    backup: vi.fn(async () => {}),
  };
  return { ...request, request, contexts, old };
}
it('starts a clean generation, preserves history and message bytes, and quarantines pending work without unpausing', async () => {
  const f = fixture();
  const result = await recoverConversation(f.request);
  expect(result.generation).not.toBe(f.old.generation);
  expect(f.contexts.current(f.binding, f.accountFingerprint, f.old.generation)).toBe(false);
  expect(f.contexts.current(f.binding, f.accountFingerprint, result.generation)).toBe(true);
  expect(fs.readdirSync(path.join(f.root, 'conversations', result.generation))).toEqual([]);
  expect(fs.readFileSync(path.join(f.old.directory, 'history'), 'utf8')).toBe('old discussion');
  expect(f.inbound.prepare("SELECT status,trigger,content FROM messages_in WHERE id='old-input'").get()).toEqual({
    status: 'failed',
    trigger: 0,
    content: 'old private prompt',
  });
  expect(f.inbound.prepare("SELECT status FROM messages_in WHERE id='completed'").get()).toEqual({
    status: 'completed',
  });
  expect(f.inbound.prepare("SELECT status FROM delivered WHERE message_out_id='unsent'").get()).toEqual({
    status: 'quarantined_context_recovery',
  });
  expect(f.outbound.prepare("SELECT content FROM messages_out WHERE id='unsent'").get()).toEqual({
    content: 'old answer',
  });
  expect(f.outbound.prepare("SELECT value FROM session_state WHERE key='ordinary'").get()).toEqual({
    value: 'ordinary continuation',
  });
  expect(f.db.prepare('SELECT paused,ingress_id FROM cos_identity_boundaries').get()).toEqual({
    paused: 1,
    ingress_id: null,
  });
  expect(f.db.prepare('SELECT projected FROM cos_ingress_receipts').get()).toEqual({ projected: 1 });
  expect(f.backup).toHaveBeenCalledOnce();
  expect(result.quarantined).toEqual({ inbound: 1, outbound: 1 });
});
it('reconciles a completed request without resetting new context or quarantining later arrivals', async () => {
  const f = fixture(),
    first = await recoverConversation(f.request);
  fs.writeFileSync(path.join(f.root, 'conversations', first.generation, 'history'), 'new discussion');
  f.inbound.exec(
    "INSERT INTO messages_in(id,kind,timestamp,content) VALUES('new-input','chat','fixture','new prompt')",
  );
  await expect(recoverConversation({ ...f.request })).resolves.toEqual(first);
  expect(f.inbound.prepare("SELECT status FROM messages_in WHERE id='new-input'").get()).toEqual({ status: 'pending' });
  expect(f.backup).toHaveBeenCalledOnce();
  await expect(recoverConversation({ ...f.request, accountFingerprint: 'b'.repeat(64) })).rejects.toThrow();
});
it.each(['unpaused', 'stale-generation', 'authority'])('refuses %s before backup or queue mutation', async (kind) => {
  const f = fixture();
  if (kind === 'unpaused') f.db.exec('UPDATE cos_identity_boundaries SET paused=0');
  if (kind === 'stale-generation') f.request.expectedGeneration = randomUUID();
  if (kind === 'authority')
    f.assertAuthority.mockImplementation(() => {
      throw new Error('authority lost');
    });
  await expect(recoverConversation(f.request)).rejects.toThrow();
  expect(f.backup).not.toHaveBeenCalled();
  expect(f.inbound.prepare("SELECT status FROM messages_in WHERE id='old-input'").get()).toEqual({ status: 'pending' });
});
it('retains a closed context on backup failure and resumes the same recovery identity after reconstruction', async () => {
  const f = fixture();
  f.backup.mockRejectedValueOnce(new Error('backup unavailable'));
  await expect(recoverConversation(f.request)).rejects.toThrow('backup unavailable');
  expect(f.contexts.current(f.binding, f.accountFingerprint, f.old.generation)).toBe(false);
  expect(f.inbound.prepare("SELECT status FROM messages_in WHERE id='old-input'").get()).toEqual({ status: 'pending' });
  const recovered = await recoverConversation({ ...f.request });
  expect(f.contexts.current(f.binding, f.accountFingerprint, recovered.generation)).toBe(true);
});
it('can explicitly recover missing history without silently recreating the missing generation', async () => {
  const f = fixture();
  fs.rmSync(f.old.directory, { recursive: true });
  f.contexts.invalidate(f.binding.scopeId, 'operator_recovery');
  const result = await recoverConversation(f.request);
  expect(fs.existsSync(f.old.directory)).toBe(false);
  expect(f.contexts.current(f.binding, f.accountFingerprint, result.generation)).toBe(true);
});
it('resumes after queue commit without re-quarantining arrivals and keeps the chosen generation', async () => {
  const f = fixture();
  f.assertAuthority.mockImplementation(() => {
    if (
      f.inbound.prepare("SELECT 1 FROM sqlite_master WHERE name='cos_context_recovery_receipts'").get() &&
      f.inbound.prepare('SELECT 1 FROM cos_context_recovery_receipts').get()
    )
      throw new Error('lease lost');
  });
  await expect(recoverConversation(f.request)).rejects.toThrow('lease lost');
  const row = f.db.prepare('SELECT generation,status FROM cos_conversation_states').get() as {
    generation: string;
    status: string;
  };
  expect(row.status).toBe('preparing');
  f.assertAuthority.mockImplementation(() => {});
  f.inbound.exec("INSERT INTO messages_in(id,kind,timestamp,content) VALUES('later','chat','fixture','later prompt')");
  const result = await recoverConversation(f.request);
  expect(result.generation).toBe(row.generation);
  expect(result.quarantined).toEqual({ inbound: 1, outbound: 1 });
  expect(f.inbound.prepare("SELECT status FROM messages_in WHERE id='later'").get()).toEqual({ status: 'pending' });
});
it('reconciles a lost completion receipt without replaying recovery, but never reopens subsequently revoked context', async () => {
  const f = fixture(),
    rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).endsWith(f.recoveryId + '.json') && JSON.parse(fs.readFileSync(from, 'utf8')).phase === 'complete')
      throw new Error('lost completion receipt');
    return rename(from, to);
  });
  await expect(recoverConversation(f.request)).rejects.toThrow('lost completion receipt');
  vi.restoreAllMocks();
  const generation = (f.db.prepare('SELECT generation FROM cos_conversation_states').get() as { generation: string })
    .generation;
  fs.writeFileSync(path.join(f.root, 'conversations', generation, 'history'), 'new history');
  f.inbound.exec("INSERT INTO messages_in(id,kind,timestamp,content) VALUES('later','chat','fixture','later prompt')");
  expect((await recoverConversation(f.request)).generation).toBe(generation);
  expect(f.inbound.prepare("SELECT status FROM messages_in WHERE id='later'").get()).toEqual({ status: 'pending' });
  f.contexts.invalidate(f.binding.scopeId, 'access_changed');
  await expect(recoverConversation(f.request)).rejects.toThrow('context_recovery_superseded');
  expect(f.contexts.current(f.binding, f.accountFingerprint, generation)).toBe(false);
});
