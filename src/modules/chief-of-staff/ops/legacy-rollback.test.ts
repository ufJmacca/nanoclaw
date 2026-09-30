import fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../../config.js', async () => ({
  ...(await vi.importActual('../../../config.js')),
  DATA_DIR: '/tmp/nanoclaw-cos-legacy-rollback/data',
  GROUPS_DIR: '/tmp/nanoclaw-cos-legacy-rollback/groups',
}));
import { initTestDb, closeDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { subscribeMattermostChannelStrict } from '../../../channels/mattermost-subscription.js';
import { installCosBoundary } from '../../../cos-boundary.js';
import { fenceLegacyCoordinators } from './legacy-rollback.js';
afterEach(() => {
  closeDb();
  fs.rmSync('/tmp/nanoclaw-cos-legacy-rollback', { recursive: true, force: true });
});
it('closes only bound CoS subscriptions before legacy code can execute them, retaining all identities and rows', () => {
  const db = initTestDb();
  runMigrations(db);
  const cos = subscribeMattermostChannelStrict({ instanceKey: 'fixture', channelId: 'cos' });
  const other = subscribeMattermostChannelStrict({ instanceKey: 'fixture', channelId: 'ordinary' });
  for (const [id, group] of [
    ['cos-session', cos],
    ['other-session', other],
  ] as const)
    db.prepare('INSERT INTO sessions(id,agent_group_id,messaging_group_id,created_at) VALUES(?,?,?,?)').run(
      id,
      group.agentGroup.id,
      group.messagingGroup.id,
      new Date().toISOString(),
    );
  installCosBoundary(
    {
      scopeId: 'scope',
      agentGroupId: cos.agentGroup.id,
      messagingGroupId: cos.messagingGroup.id,
      sessionId: 'cos-session',
      provider: 'codex',
      instanceId: 'fixture',
      channelId: 'cos',
      ownerId: 'owner',
      botId: 'bot',
    },
    db,
  );
  db.exec('UPDATE cos_identity_boundaries SET paused=0');
  expect(fenceLegacyCoordinators(db)).toEqual({ fencedScopes: 1 });
  expect(fenceLegacyCoordinators(db)).toEqual({ fencedScopes: 1 });
  expect(db.prepare('SELECT status FROM sessions WHERE id=?').get('cos-session')).toEqual({ status: 'closed' });
  expect(db.prepare('SELECT status FROM sessions WHERE id=?').get('other-session')).toEqual({ status: 'active' });
  expect(db.prepare('SELECT status FROM mattermost_subscriptions WHERE channel_id=?').get('cos')).toEqual({
    status: 'unsubscribed',
  });
  expect(db.prepare('SELECT status FROM mattermost_subscriptions WHERE channel_id=?').get('ordinary')).toEqual({
    status: 'active',
  });
  expect(db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
  expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 2 });
});
