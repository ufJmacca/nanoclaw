import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { backupConversations, verifyConversationBackup } from './conversation-backup.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-history-backup-'));
  roots.push(root);
  const source = path.join(root, 'conversations'),
    receipt = path.join(root, 'receipt');
  fs.mkdirSync(source, { mode: 0o700 });
  fs.mkdirSync(receipt, { mode: 0o700 });
  const generation = path.join(source, '11111111-1111-4111-8111-111111111111');
  fs.mkdirSync(generation, { mode: 0o700 });
  fs.mkdirSync(path.join(generation, 'sessions'));
  fs.writeFileSync(path.join(generation, 'sessions/history.jsonl'), 'synthetic conversation\n');
  fs.writeFileSync(path.join(generation, 'state.sqlite-wal'), 'synthetic quiesced WAL');
  fs.writeFileSync(path.join(generation, 'auth.json'), 'ACCESS_CANARY');
  fs.writeFileSync(path.join(generation, '.auth-interrupted'), 'ACCESS_CANARY');
  return { root, source, receipt, generation };
}
it('preserves all generations and WAL bytes privately, without credentials or touching live history', async () => {
  const f = fixture();
  const result = await backupConversations(f.source, f.receipt);
  const copied = path.join(f.receipt, 'conversation-backup/history', path.basename(f.generation));
  expect(fs.readFileSync(path.join(copied, 'sessions/history.jsonl'), 'utf8')).toBe('synthetic conversation\n');
  expect(fs.readFileSync(path.join(copied, 'state.sqlite-wal'), 'utf8')).toBe('synthetic quiesced WAL');
  expect(fs.existsSync(path.join(copied, 'auth.json'))).toBe(false);
  expect(fs.existsSync(path.join(copied, '.auth-interrupted'))).toBe(false);
  expect(fs.statSync(path.join(copied, 'sessions')).mode & 0o777).toBe(0o700);
  expect(fs.statSync(path.join(copied, 'sessions/history.jsonl')).mode & 0o777).toBe(0o600);
  fs.appendFileSync(path.join(f.generation, 'sessions/history.jsonl'), 'later conversation\n');
  await expect(backupConversations(f.source, f.receipt)).resolves.toEqual(result);
  await expect(verifyConversationBackup(f.source, f.receipt)).resolves.toEqual(result);
  expect(fs.readFileSync(path.join(f.generation, 'auth.json'), 'utf8')).toBe('ACCESS_CANARY');
  fs.appendFileSync(path.join(copied, 'sessions/history.jsonl'), 'corrupt');
  await expect(verifyConversationBackup(f.source, f.receipt)).rejects.toThrow('conversation_backup_conflict');
});
it('records absence before first native activation and does not overwrite that baseline on retry', async () => {
  const f = fixture();
  fs.rmSync(f.source, { recursive: true });
  const result = await backupConversations(f.source, f.receipt);
  expect(result.present).toBe(false);
  fs.mkdirSync(f.source, { mode: 0o700 });
  await expect(backupConversations(f.source, f.receipt)).resolves.toEqual(result);
  await expect(verifyConversationBackup(path.join(f.root, 'different'), f.receipt)).rejects.toThrow();
});
it.each(['symlink', 'hardlink', 'writable-directory', 'invalid-generation'])(
  'refuses unsafe history: %s',
  async (kind) => {
    const f = fixture();
    if (kind === 'symlink') fs.symlinkSync(f.receipt, path.join(f.generation, 'escape'));
    if (kind === 'hardlink')
      fs.linkSync(path.join(f.generation, 'auth.json'), path.join(f.generation, 'credential-alias'));
    if (kind === 'writable-directory') fs.chmodSync(path.join(f.generation, 'sessions'), 0o777);
    if (kind === 'invalid-generation') fs.mkdirSync(path.join(f.source, 'foreign'));
    await expect(backupConversations(f.source, f.receipt)).rejects.toThrow('unsafe_conversation_backup');
    expect(fs.existsSync(path.join(f.receipt, 'conversation-backup'))).toBe(false);
  },
);
it('rejects incomplete or redirected snapshots instead of replacing them', async () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.receipt, 'conversation-backup'), { mode: 0o700 });
  await expect(backupConversations(f.source, f.receipt)).rejects.toThrow();
  fs.rmdirSync(path.join(f.receipt, 'conversation-backup'));
  fs.symlinkSync(f.source, path.join(f.receipt, 'conversation-backup'));
  await expect(backupConversations(f.source, f.receipt)).rejects.toThrow();
});
it('detects added files and refuses credential files injected into a completed backup', async () => {
  const f = fixture();
  await backupConversations(f.source, f.receipt);
  const copied = path.join(f.receipt, 'conversation-backup/history', path.basename(f.generation));
  fs.writeFileSync(path.join(copied, 'auth.json'), 'NEW_CANARY', { mode: 0o600 });
  await expect(verifyConversationBackup(f.source, f.receipt)).rejects.toThrow();
});
