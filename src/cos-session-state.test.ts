import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
vi.mock('./config.js', async () => ({
  ...(await vi.importActual('./config.js')),
  DATA_DIR: '/tmp/nanoclaw-cos-session-state',
}));
import { initTestDb, closeDb } from './db/connection.js';
import { initSessionFolder, sessionDir, inboundDbPath } from './session-manager.js';
import { installCosBoundary } from './cos-boundary.js';
afterEach(() => {
  closeDb();
  fs.rmSync('/tmp/nanoclaw-cos-session-state', { recursive: true, force: true });
});
describe('S01 approved-context-only session transition', () => {
  it('preserves prior SQLite history and provider files while starting a fresh restricted workspace', () => {
    const db = initTestDb();
    initSessionFolder('group', 'session');
    const legacy = sessionDir('group', 'session');
    const old = new Database(inboundDbPath('group', 'session'));
    old.exec("CREATE TABLE private_history(content TEXT); INSERT INTO private_history VALUES('old private context')");
    old.close();
    fs.mkdirSync(path.join(legacy, 'codex'));
    fs.writeFileSync(path.join(legacy, 'codex', 'history.json'), 'old provider state');
    installCosBoundary(
      {
        scopeId: 'scope',
        agentGroupId: 'group',
        messagingGroupId: 'mg',
        sessionId: 'session',
        ownerId: 'owner',
        botId: 'bot',
        instanceId: 'fixture',
        channelId: 'private',
        provider: 'codex',
      },
      db,
    );
    initSessionFolder('group', 'session');
    expect(sessionDir('group', 'session')).toBe(path.join(legacy, 'cos-v1'));
    const fresh = new Database(inboundDbPath('group', 'session'));
    expect(fresh.prepare("SELECT name FROM sqlite_master WHERE name='private_history'").get()).toBeUndefined();
    fresh.close();
    expect(fs.existsSync(path.join(sessionDir('group', 'session'), 'codex', 'history.json'))).toBe(false);
    expect(fs.readFileSync(path.join(legacy, 'codex', 'history.json'), 'utf8')).toBe('old provider state');
    const preserved = new Database(path.join(legacy, 'inbound.db'));
    expect(preserved.prepare('SELECT content FROM private_history').get()).toEqual({ content: 'old private context' });
    preserved.close();
    // Pausing/removing feature configuration never remounts old private history.
    db.exec('UPDATE cos_identity_boundaries SET paused=1');
    expect(sessionDir('group', 'session')).toBe(path.join(legacy, 'cos-v1'));
  });
});
