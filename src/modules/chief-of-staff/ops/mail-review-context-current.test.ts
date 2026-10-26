import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { ensureConversationSchema } from '../bridge/conversation-state.js';
import { rememberConversationOwner } from './conversation-ownership.js';
import { writeAtomic } from './target-state.js';
import { mailReviewContextCurrent } from './mail-review-context-current.js';
const roots: string[] = [],
  databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-review-context-'));
  roots.push(root);
  const db = new Database(':memory:');
  databases.push(db);
  ensureConversationSchema(db);
  const binding = {
    scopeId: 'scope',
    ownerId: 'owner',
    sessionId: 'session',
    agentGroupId: 'group',
    messagingGroupId: 'messages',
    provider: 'codex',
    instanceId: 'fixture',
    channelId: 'private',
    botId: 'bot',
  } as CosBinding;
  const generation = randomUUID(),
    account = digest('fixture account');
  fs.mkdirSync(path.join(root, 'conversations'), { mode: 0o700 });
  fs.mkdirSync(path.join(root, 'conversations', generation), { mode: 0o700 });
  rememberConversationOwner(root, binding, account, generation);
  db.prepare(
    "INSERT INTO cos_conversation_states(scope_id,binding_digest,account_fingerprint,generation,status,updated_at) VALUES(?,?,?,?,'active',?)",
  ).run(binding.scopeId, digest(binding), account, generation, new Date().toISOString());
  const current = () => mailReviewContextCurrent(db, root, binding, generation, account);
  return { root, db, binding, generation, account, current };
}
it('reads the existing main context and owner without creating a context or changing native history', () => {
  const f = fixture(),
    before = f.db.serialize();
  expect(f.current()).toBe(true);
  expect(f.db.serialize()).toEqual(before);
  expect(mailReviewContextCurrent(f.db, f.root, f.binding, randomUUID(), f.account)).toBe(false);
  expect(mailReviewContextCurrent(f.db, f.root, f.binding, f.generation, digest('other account'))).toBe(false);
});
it.each([
  'invalidated',
  'binding',
  'account',
  'missing-owner',
  'purged-owner',
  'missing-directory',
  'linked-directory',
  'permissive-directory',
])('refuses %s instead of repairing or replacing the main context', (failure) => {
  const f = fixture(),
    directory = path.join(f.root, 'conversations', f.generation),
    owner = path.join(f.root, 'conversation-owners', f.generation + '.json');
  if (failure === 'invalidated') f.db.prepare("UPDATE cos_conversation_states SET status='invalidated'").run();
  if (failure === 'binding')
    f.db.prepare('UPDATE cos_conversation_states SET binding_digest=?').run(digest('other binding'));
  if (failure === 'account')
    f.db.prepare('UPDATE cos_conversation_states SET account_fingerprint=?').run(digest('other account'));
  if (failure === 'missing-owner') fs.unlinkSync(owner);
  if (failure === 'purged-owner')
    writeAtomic(path.dirname(owner), path.basename(owner), {
      ...JSON.parse(fs.readFileSync(owner, 'utf8')),
      state: 'purged',
    });
  if (failure === 'missing-directory') fs.rmdirSync(directory);
  if (failure === 'linked-directory') {
    fs.renameSync(directory, directory + '-old');
    fs.symlinkSync(directory + '-old', directory);
  }
  if (failure === 'permissive-directory') fs.chmodSync(directory, 0o755);
  const before = f.db.serialize();
  expect(f.current()).toBe(false);
  expect(f.db.serialize()).toEqual(before);
  if (failure === 'missing-owner') expect(fs.existsSync(owner)).toBe(false);
  if (failure === 'missing-directory') expect(fs.existsSync(directory)).toBe(false);
});
