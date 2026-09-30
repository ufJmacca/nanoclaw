import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { CosBinding } from '../../../cos-boundary.js';
import { createConversationState } from '../bridge/conversation-state.js';
import { ensureRpcSchema } from '../bridge/rpc.js';
import { purgeRetiredContexts } from './conversation-purge.js';
const binding = {
  scopeId: 'scope',
  ownerId: 'owner',
  botId: 'bot',
  instanceId: 'instance',
  channelId: 'channel',
  agentGroupId: 'group',
  messagingGroupId: 'messages',
  sessionId: 'session',
  provider: 'codex',
} as CosBinding;
let root: string, db: Database.Database, inbound: Database.Database, generation: string, directory: string;
const check = vi.fn(async () => {}),
  assertAuthority = vi.fn();
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-history-purge-'));
  db = new Database(':memory:');
  inbound = new Database(':memory:');
  ensureRpcSchema(inbound);
  db.exec('CREATE TABLE cos_identity_boundaries(scope_id TEXT PRIMARY KEY,binding TEXT,paused INTEGER)');
  db.prepare('INSERT INTO cos_identity_boundaries VALUES(?,?,1)').run(binding.scopeId, JSON.stringify(binding));
  ({ generation, directory } = createConversationState(root, db).prepare(binding, 'a'.repeat(64)));
  fs.mkdirSync(directory + '/sessions', { mode: 0o700 });
  fs.writeFileSync(directory + '/sessions/history.jsonl', 'DELETED_SOURCE_CANARY', { mode: 0o600 });
  fs.writeFileSync(directory + '/auth.json', 'replaceable generation cache', { mode: 0o600 });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  inbound.close();
  fs.rmSync(root, { recursive: true, force: true });
});
const options = () => ({
  root,
  db,
  inbound,
  binding,
  contexts: [{ sessionId: binding.sessionId, generation }],
  check,
  assertAuthority,
});
function retire() {
  db.prepare('DELETE FROM cos_conversation_states WHERE scope_id=?').run(binding.scopeId);
  return createConversationState(root, db).prepare(binding, 'a'.repeat(64));
}
it('purges only a proved retired generation and preserves current context, native data, master credentials and backups', async () => {
  const current = retire();
  for (const [request, gen] of [
    ['old', generation],
    ['new', current.generation],
  ]) {
    inbound
      .prepare('INSERT INTO cos_rpc_responses VALUES(?,?,?,?,?)')
      .run(request, 'hash', 'delivery', 'SOURCE_RPC_CANARY', 'now');
    inbound
      .prepare('INSERT INTO cos_rpc_contexts VALUES(?,?,?,?,?,?)')
      .run(request, 'hash', 'delivery', binding.scopeId, binding.sessionId, gen);
  }
  inbound
    .prepare('INSERT INTO cos_rpc_responses VALUES(?,?,?,?,?)')
    .run('ordinary', 'hash', 'delivery', 'PRESERVE', 'now');
  for (const name of ['codex-auth', 'context-recovery-backups', 'native-data']) {
    fs.mkdirSync(root + '/' + name, { mode: 0o700 });
    fs.writeFileSync(root + '/' + name + '/keep', 'KEEP', { mode: 0o600 });
  }
  expect(await purgeRetiredContexts(options())).toMatchObject({ status: 'ok', generations: 1 });
  expect(fs.existsSync(directory)).toBe(false);
  expect(fs.existsSync(current.directory)).toBe(true);
  expect(inbound.prepare('SELECT request_id FROM cos_rpc_responses ORDER BY request_id').all()).toEqual([
    { request_id: 'new' },
    { request_id: 'ordinary' },
  ]);
  for (const name of ['codex-auth', 'context-recovery-backups', 'native-data'])
    expect(fs.readFileSync(root + '/' + name + '/keep', 'utf8')).toBe('KEEP');
  expect(await purgeRetiredContexts(options())).toMatchObject({ status: 'ok', generations: 1 });
});
it('keeps active or invalidated current generations until explicit recovery replaces them', async () => {
  expect(await purgeRetiredContexts(options())).toMatchObject({ status: 'pending', code: 'context_recovery_required' });
  createConversationState(root, db).invalidate(binding.scopeId, 'access_changed');
  expect(await purgeRetiredContexts(options())).toMatchObject({ status: 'pending', code: 'context_recovery_required' });
  expect(fs.existsSync(directory + '/sessions/history.jsonl')).toBe(true);
});
it.each(['owner', 'session', 'unpaused', 'unknown'])(
  'refuses %s ownership or authority mismatch before removal',
  async (kind) => {
    retire();
    const o = options();
    if (kind === 'owner') o.binding = { ...binding, ownerId: 'other' };
    if (kind === 'session') o.contexts[0].sessionId = 'foreign';
    if (kind === 'unpaused') db.prepare('UPDATE cos_identity_boundaries SET paused=0').run();
    if (kind === 'unknown') o.contexts[0].generation = randomUUID();
    await expect(purgeRetiredContexts(o)).rejects.toThrow();
    expect(fs.existsSync(directory + '/sessions/history.jsonl')).toBe(true);
  },
);
it.each(['symlink', 'hardlink', 'writable'])('refuses %s history trees before deleting any files', async (kind) => {
  retire();
  if (kind === 'symlink') fs.symlinkSync(root, directory + '/escape');
  if (kind === 'hardlink') fs.linkSync(directory + '/sessions/history.jsonl', root + '/hardlink');
  if (kind === 'writable') fs.chmodSync(directory + '/sessions', 0o777);
  await expect(purgeRetiredContexts(options())).rejects.toThrow('unsafe_conversation_purge');
  expect(fs.existsSync(directory + '/auth.json')).toBe(true);
});
it('reconciles interruption after unlink without recreating history or touching a replacement generation', async () => {
  const current = retire();
  const original = fs.unlinkSync;
  vi.spyOn(fs, 'unlinkSync').mockImplementationOnce((file) => {
    original(file);
    throw new Error('interrupted unlink');
  });
  await expect(purgeRetiredContexts(options())).rejects.toThrow('interrupted unlink');
  vi.restoreAllMocks();
  expect(await purgeRetiredContexts(options())).toMatchObject({ status: 'ok' });
  expect(fs.existsSync(directory)).toBe(false);
  expect(fs.existsSync(current.directory)).toBe(true);
});
it('will not adopt a re-created directory after a completed purge', async () => {
  retire();
  await purgeRetiredContexts(options());
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(directory + '/unrelated', 'KEEP', { mode: 0o600 });
  await expect(purgeRetiredContexts(options())).rejects.toThrow('conversation_purge_conflict');
  expect(fs.readFileSync(directory + '/unrelated', 'utf8')).toBe('KEEP');
});
