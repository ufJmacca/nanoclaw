import type Database from 'better-sqlite3';
import type { CosBinding } from '../../../cos-boundary.js';
/** Service and its workers must already be stopped. Older hosts do not understand the permanent CoS boundary. */
export function fenceLegacyCoordinators(db: Database.Database): { fencedScopes: number } {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cos_identity_boundaries'").get())
    return { fencedScopes: 0 };
  return db
    .transaction(() => {
      const rows = db
        .prepare('SELECT scope_id,agent_group_id,messaging_group_id,session_id,binding FROM cos_identity_boundaries')
        .all() as Array<{
        scope_id: string;
        agent_group_id: string;
        messaging_group_id: string;
        session_id: string;
        binding: string;
      }>;
      for (const row of rows) {
        const binding = JSON.parse(row.binding) as CosBinding;
        if (
          binding.scopeId !== row.scope_id ||
          binding.agentGroupId !== row.agent_group_id ||
          binding.messagingGroupId !== row.messaging_group_id ||
          binding.sessionId !== row.session_id
        )
          throw new Error('legacy_fence_identity_conflict');
        const sessions = db
          .prepare('SELECT id,container_status FROM sessions WHERE agent_group_id=? OR messaging_group_id=?')
          .all(row.agent_group_id, row.messaging_group_id) as Array<{ id: string; container_status: string }>;
        const subscription = db
          .prepare(
            'SELECT status,agent_group_id,messaging_group_id FROM mattermost_subscriptions WHERE instance_key=? AND channel_id=?',
          )
          .get(binding.instanceId, binding.channelId) as
          | { status: string; agent_group_id: string; messaging_group_id: string }
          | undefined;
        if (
          sessions.length !== 1 ||
          sessions[0].id !== row.session_id ||
          sessions[0].container_status !== 'stopped' ||
          !subscription ||
          subscription.agent_group_id !== row.agent_group_id ||
          subscription.messaging_group_id !== row.messaging_group_id ||
          !['active', 'unsubscribed', 'archived'].includes(subscription.status)
        )
          throw new Error('legacy_fence_identity_conflict');
        db.prepare('UPDATE cos_identity_boundaries SET paused=1 WHERE scope_id=?').run(row.scope_id);
        db.prepare("UPDATE sessions SET status='closed' WHERE id=?").run(row.session_id);
        if (subscription.status === 'active')
          db.prepare(
            "UPDATE mattermost_subscriptions SET status='unsubscribed',archived_at=NULL WHERE instance_key=? AND channel_id=?",
          ).run(binding.instanceId, binding.channelId);
      }
      return { fencedScopes: rows.length };
    })
    .immediate();
}
