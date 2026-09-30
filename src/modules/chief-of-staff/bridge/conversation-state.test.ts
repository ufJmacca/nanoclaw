import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createConversationState } from './conversation-state.js';
import type { CosBinding } from '../../../cos-boundary.js';
let root: string, db: Database.Database;
const binding = {
  scopeId: 'fixture',
  ownerId: 'owner',
  botId: 'bot',
  instanceId: 'instance',
  channelId: 'channel',
  agentGroupId: 'group',
  messagingGroupId: 'messages',
  sessionId: 'session',
  provider: 'codex',
} as CosBinding;
const account = 'a'.repeat(64);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-conversation-'));
  db = new Database(':memory:');
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
it('retains a private CoS-only generation and native history across reconstruction', () => {
  const first = createConversationState(root, db).prepare(binding, account);
  fs.writeFileSync(path.join(first.directory, 'history-marker'), 'owner context');
  const second = createConversationState(root, db).prepare(binding, account);
  expect(second).toEqual(first);
  expect(fs.readFileSync(path.join(second.directory, 'history-marker'), 'utf8')).toBe('owner context');
  expect(fs.statSync(second.directory).mode & 0o777).toBe(0o700);
  expect(createConversationState(root, db).current(binding, account, first.generation)).toBe(true);
});
it.each(['binding', 'account'])('an observed changed %s permanently fences the previous conversation', (kind) => {
  const state = createConversationState(root, db);
  state.prepare(binding, account);
  expect(() =>
    state.prepare(
      kind === 'binding' ? { ...binding, ownerId: 'other' } : binding,
      kind === 'account' ? 'b'.repeat(64) : account,
    ),
  ).toThrow('cos_context_recovery_required');
  expect(() => state.prepare(binding, account)).toThrow('cos_context_recovery_required');
});
it.each(['missing', 'symlink'])('%s provider state never silently creates another context', (kind) => {
  const state = createConversationState(root, db),
    first = state.prepare(binding, account);
  fs.rmdirSync(first.directory);
  if (kind === 'symlink') fs.symlinkSync(root, first.directory);
  expect(() => state.prepare(binding, account)).toThrow('cos_context_recovery_required');
  expect(state.current(binding, account, first.generation)).toBe(false);
  if (kind === 'symlink') fs.unlinkSync(first.directory);
  fs.mkdirSync(first.directory, { mode: 0o700 });
  expect(() => state.prepare(binding, account)).toThrow('cos_context_recovery_required');
});
it('access revocation durably fences the old continuation without deleting history', () => {
  const state = createConversationState(root, db),
    first = state.prepare(binding, account);
  fs.writeFileSync(path.join(first.directory, 'history-marker'), 'revoked context');
  state.invalidate(binding.scopeId, 'access_changed');
  expect(state.current(binding, account, first.generation)).toBe(false);
  expect(() => createConversationState(root, db).prepare(binding, account)).toThrow('cos_context_recovery_required');
  expect(fs.readFileSync(path.join(first.directory, 'history-marker'), 'utf8')).toBe('revoked context');
});
it('a partial initialization stays closed on reconstruction', () => {
  const state = createConversationState(root, db);
  const row = state.prepare(binding, account);
  db.prepare("UPDATE cos_conversation_states SET status='preparing' WHERE scope_id=?").run(binding.scopeId);
  expect(() => state.prepare(binding, account)).toThrow('cos_context_recovery_required');
  expect(fs.existsSync(row.directory)).toBe(true);
});
