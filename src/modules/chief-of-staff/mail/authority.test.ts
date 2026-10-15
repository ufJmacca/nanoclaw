import fs from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ root: '/tmp/cos-mail-authority-' + process.pid, release: vi.fn(() => true) }));
vi.mock('../../../config.js', async () => ({
  ...(await vi.importActual('../../../config.js')),
  DATA_DIR: f.root + '/data',
  GROUPS_DIR: f.root + '/groups',
}));
vi.mock('../../../release-runtime.js', () => ({ releaseMode: f.release, currentRelease: () => ({}) }));
import { initTestDb, getDb, closeDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { subscribeMattermostChannelStrict } from '../../../channels/mattermost-subscription.js';
import { resolveSession } from '../../../session-manager.js';
import { updateSession } from '../../../db/sessions.js';
import { installCosBoundary, type CosBinding } from '../../../cos-boundary.js';
import { createMailAuthorities } from './authority.js';
beforeEach(() => {
  fs.mkdirSync(f.root, { mode: 0o700 });
  runMigrations(initTestDb());
  f.release.mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  fs.rmSync(f.root, { recursive: true, force: true });
});
function fixture() {
  const db = getDb(),
    group = subscribeMattermostChannelStrict({ instanceKey: 'fixture', channelId: 'private' });
  const session = resolveSession(group.agentGroup.id, group.messagingGroup.id, null, 'shared').session;
  updateSession(session.id, { agent_provider: 'codex' });
  const binding: CosBinding = {
    scopeId: 'scope',
    ownerId: 'owner',
    botId: 'bot',
    instanceId: 'fixture',
    channelId: 'private',
    agentGroupId: group.agentGroup.id,
    messagingGroupId: group.messagingGroup.id,
    sessionId: session.id,
    provider: 'codex',
  };
  installCosBoundary(binding, db);
  db.prepare('UPDATE cos_identity_boundaries SET paused=0 WHERE scope_id=?').run(binding.scopeId);
  const context = {
    scopeId: binding.scopeId,
    ownerId: binding.ownerId,
    agentGroupId: binding.agentGroupId,
    sessionId: binding.sessionId,
    provider: binding.provider,
    ingressId: 'host-mail-maintenance',
  };
  const admitted = vi.fn(() => true),
    assertHostAuthority = vi.fn();
  return {
    db,
    binding,
    context,
    admitted,
    assertHostAuthority,
    authority: createMailAuthorities({ db, admitted, assertHostAuthority }),
  };
}
it('admits only the current installed owner scope without requiring any model allowance or sign-in', () => {
  const t = fixture();
  const prepare = t.db.prepare.bind(t.db);
  vi.spyOn(t.db, 'prepare').mockImplementation((sql: string) => {
    if (/cos_model_budget|cos_model_activation/.test(sql)) throw Error('MODEL_AUTHORITY_MUST_NOT_BE_READ');
    return prepare(sql);
  });
  expect(t.authority.poll(t.context)).toBe(true);
  expect(t.authority.retention(t.context)).toBe(true);
  expect(t.assertHostAuthority).toHaveBeenCalled();
});
it('separates provider polling from no-model retention when the owner pauses', () => {
  const t = fixture();
  t.db.prepare('UPDATE cos_identity_boundaries SET paused=1 WHERE scope_id=?').run('scope');
  expect(t.authority.poll(t.context)).toBe(false);
  expect(t.authority.retention(t.context)).toBe(true);
});
it('rechecks lease, target admission, release and native identity on every call', () => {
  const t = fixture();
  t.admitted.mockReturnValue(false);
  expect(t.authority.poll(t.context)).toBe(false);
  expect(t.authority.retention(t.context)).toBe(false);
  t.admitted.mockReturnValue(true);
  t.assertHostAuthority.mockImplementation(() => {
    throw Error('PRIVATE_LEASE_LOSS');
  });
  expect(t.authority.retention(t.context)).toBe(false);
  t.assertHostAuthority.mockReset();
  f.release.mockReturnValue(false);
  expect(t.authority.poll(t.context)).toBe(false);
  f.release.mockReturnValue(true);
  for (const changed of [
    { scopeId: 'foreign' },
    { ownerId: 'foreign' },
    { agentGroupId: 'foreign' },
    { sessionId: 'foreign' },
    { provider: 'claude' },
    { origin: { kind: 'schedule' } },
  ])
    expect(t.authority.retention({ ...t.context, ...changed } as typeof t.context)).toBe(false);
  updateSession(t.binding.sessionId, { status: 'closed' });
  expect(t.authority.poll(t.context)).toBe(false);
  expect(t.authority.retention(t.context)).toBe(true);
});
