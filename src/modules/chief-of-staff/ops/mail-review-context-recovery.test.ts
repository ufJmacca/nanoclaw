import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { ensureCosBoundarySchema, installCosBoundary, type CosBinding } from '../../../cos-boundary.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../../../db/schema.js';
import { createConversationState } from '../bridge/conversation-state.js';
import { recoverConversation } from './conversation-recovery.js';
import { mailReviewContextRecoveryCurrent } from './mail-review-context-current.js';
import { writeAtomic } from './target-state.js';
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-review-recovery-'));
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
    instanceId: 'fixture',
    channelId: 'channel',
    agentGroupId: 'group',
    messagingGroupId: 'messages',
    sessionId: 'session',
    provider: 'codex',
  };
  installCosBoundary(binding, db);
  const account = 'a'.repeat(64),
    old = createConversationState(root, db).prepare(binding, account),
    recoveryId = randomUUID();
  fs.writeFileSync(path.join(old.directory, 'history'), 'synthetic old discussion');
  const result = await recoverConversation({
    root,
    db,
    inbound,
    outbound,
    binding,
    accountFingerprint: account,
    expectedGeneration: old.generation,
    recoveryId,
    assertAuthority() {},
    backup: async () => {},
  });
  const file = path.join(root, 'context-recoveries', recoveryId + '.json');
  const check = () => mailReviewContextRecoveryCurrent(db, root, binding, old.generation, result.generation, account);
  return { root, db, binding, account, old, result, file, check };
}
it('requires the actual completed old-to-current native recovery while preserving old history and all current records', async () => {
  const f = await fixture(),
    before = f.db.serialize(),
    receipt = fs.readFileSync(f.file);
  expect(f.check()).toBe(true);
  expect(f.db.serialize()).toEqual(before);
  expect(fs.readFileSync(f.file)).toEqual(receipt);
  expect(fs.readFileSync(path.join(f.old.directory, 'history'), 'utf8')).toBe('synthetic old discussion');
  expect(mailReviewContextRecoveryCurrent(f.db, f.root, f.binding, randomUUID(), f.result.generation, f.account)).toBe(
    false,
  );
  expect(mailReviewContextRecoveryCurrent(f.db, f.root, f.binding, f.old.generation, randomUUID(), f.account)).toBe(
    false,
  );
  expect(
    mailReviewContextRecoveryCurrent(f.db, f.root, f.binding, f.old.generation, f.result.generation, 'b'.repeat(64)),
  ).toBe(false);
});
it.each([
  'missing',
  'quarantined',
  'request',
  'generation',
  'counts',
  'extra',
  'symlink',
  'hardlink',
  'permissive',
  'old-owner',
  'old-history',
  'current-invalidated',
])('withholds review rebind after %s recovery evidence changes', async (failure) => {
  const f = await fixture(),
    value = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  if (failure === 'missing') fs.unlinkSync(f.file);
  if (failure === 'quarantined')
    writeAtomic(path.dirname(f.file), path.basename(f.file), { ...value, phase: 'quarantined' });
  if (failure === 'request')
    writeAtomic(path.dirname(f.file), path.basename(f.file), { ...value, requestDigest: 'b'.repeat(64) });
  if (failure === 'generation')
    writeAtomic(path.dirname(f.file), path.basename(f.file), { ...value, generation: randomUUID() });
  if (failure === 'counts')
    writeAtomic(path.dirname(f.file), path.basename(f.file), { ...value, quarantined: { inbound: -1, outbound: 0 } });
  if (failure === 'extra') writeAtomic(path.dirname(f.file), path.basename(f.file), { ...value, restoredLease: true });
  if (failure === 'symlink') {
    fs.renameSync(f.file, f.file + '.other');
    fs.symlinkSync(f.file + '.other', f.file);
  }
  if (failure === 'hardlink') fs.linkSync(f.file, f.file + '.other');
  if (failure === 'permissive') fs.chmodSync(f.file, 0o644);
  if (failure === 'old-owner') fs.unlinkSync(path.join(f.root, 'conversation-owners', f.old.generation + '.json'));
  if (failure === 'old-history') fs.rmSync(f.old.directory, { recursive: true });
  if (failure === 'current-invalidated') f.db.exec("UPDATE cos_conversation_states SET status='invalidated'");
  const before = f.db.serialize();
  expect(f.check()).toBe(false);
  expect(f.db.serialize()).toEqual(before);
});
