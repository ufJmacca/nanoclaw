import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
vi.mock('../../../config.js', async () => ({
  ...(await vi.importActual('../../../config.js')),
  DATA_DIR: '/tmp/nanoclaw-cos-binding/data',
  GROUPS_DIR: '/tmp/nanoclaw-cos-binding/groups',
}));
import { initTestDb, closeDb, getDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { subscribeMattermostChannelStrict } from '../../../channels/mattermost-subscription.js';
import { resolveSession, sessionDir } from '../../../session-manager.js';
import { bindCoordinator, type BindingRequest } from './bind.js';
import { getSession } from '../../../db/sessions.js';
const request: BindingRequest = {
  scopeId: 'fixture-scope',
  ownerId: 'owner',
  botId: 'bot',
  instanceId: 'fixture',
  channelId: 'private',
  provider: 'codex',
};
beforeEach(() => runMigrations(initTestDb()));
afterEach(() => {
  closeDb();
  fs.rmSync('/tmp/nanoclaw-cos-binding', { force: true, recursive: true });
});
function fixture() {
  const group = subscribeMattermostChannelStrict({ instanceKey: 'fixture', channelId: 'private' });
  const { session } = resolveSession(group.agentGroup.id, group.messagingGroup.id, null, 'shared');
  const legacy = sessionDir(session.agent_group_id, session.id);
  fs.writeFileSync(legacy + '/prior-state', 'preserve');
  const facts = vi
    .fn()
    .mockResolvedValue({ id: 'private', type: 'P', delete_at: 0, members: ['bot', 'owner'], activeSubscription: true });
  const bindScope = vi.fn().mockResolvedValue({ status: 'ok' });
  return { session, legacy, facts, bindScope };
}
describe('S01 owner-run private coordinator setup', () => {
  it('binds the verified native shared identity and preserves old state behind the fresh root', async () => {
    const f = fixture();
    const binding = await bindCoordinator(request, f);
    expect(binding).toMatchObject({
      sessionId: f.session.id,
      agentGroupId: f.session.agent_group_id,
      ownerId: 'owner',
    });
    expect(fs.readFileSync(f.legacy + '/prior-state', 'utf8')).toBe('preserve');
    expect(sessionDir(f.session.agent_group_id, f.session.id)).toBe(f.legacy + '/cos-v1');
    expect(getSession(f.session.id)?.agent_provider).toBe('codex');
    expect(getDb().prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
    expect(await bindCoordinator(request, f)).toEqual(binding);
  });
  it('rejects multi-user access without changing session state', async () => {
    const f = fixture();
    f.facts.mockResolvedValue({
      id: 'private',
      type: 'P',
      delete_at: 0,
      members: ['bot', 'owner', 'other'],
      activeSubscription: true,
    });
    await expect(bindCoordinator(request, f)).rejects.toThrow();
    expect(f.bindScope).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT count(*) AS count FROM cos_identity_boundaries').get()).toEqual({ count: 0 });
  });
  it('leaves a permanent paused identity when PostgreSQL setup cannot be confirmed', async () => {
    const f = fixture();
    f.bindScope.mockResolvedValue({ status: 'pending' });
    await expect(bindCoordinator(request, f)).rejects.toThrow();
    expect(getDb().prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
    expect(fs.readFileSync(f.legacy + '/prior-state', 'utf8')).toBe('preserve');
  });
  it('refuses another live host or an active coordinator container', async () => {
    const f = fixture();
    getDb().prepare("UPDATE sessions SET container_status='running' WHERE id=?").run(f.session.id);
    await expect(bindCoordinator(request, f)).rejects.toThrow();
    expect(f.bindScope).not.toHaveBeenCalled();
  });
});
