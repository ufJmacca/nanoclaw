import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration015: Migration = {
  version: 15,
  name: 'mattermost-lifecycle',
  up(db: Database.Database) {
    const duplicateSessionOwner = db
      .prepare(
        `SELECT ms.instance_key, ms.channel_id
           FROM mattermost_subscriptions ms
           JOIN sessions s
             ON s.agent_group_id = ms.agent_group_id
             OR s.messaging_group_id = ms.messaging_group_id
          GROUP BY ms.instance_key, ms.channel_id
         HAVING COUNT(DISTINCT s.id) > 1
          LIMIT 1`,
      )
      .get();
    if (duplicateSessionOwner) {
      throw new Error('Cannot migrate Mattermost lifecycle: a channel owns multiple session identities');
    }

    db.exec(`
      CREATE TABLE pending_mattermost_channel_approvals (
        approval_id        TEXT PRIMARY KEY,
        instance_key       TEXT NOT NULL,
        channel_id         TEXT NOT NULL,
        messaging_group_id TEXT NOT NULL UNIQUE REFERENCES messaging_groups(id),
        requester_user_id  TEXT NOT NULL,
        approver_user_id   TEXT NOT NULL,
        original_message   TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'processing', 'completed', 'rejected')),
        created_at         TEXT NOT NULL,
        decided_at         TEXT,
        decided_by         TEXT,
        replayed_at        TEXT,
        title              TEXT NOT NULL,
        options_json       TEXT NOT NULL,
        UNIQUE (instance_key, channel_id)
      );

      CREATE TRIGGER mattermost_guard_active_session_insert
      BEFORE INSERT ON sessions
      WHEN NEW.status = 'active'
       AND EXISTS (
        SELECT 1 FROM mattermost_subscriptions ms
         WHERE ms.agent_group_id = NEW.agent_group_id
            OR ms.messaging_group_id = NEW.messaging_group_id
      )
       AND NOT EXISTS (
        SELECT 1 FROM mattermost_subscriptions ms
         WHERE ms.status = 'active'
           AND ms.agent_group_id = NEW.agent_group_id
           AND ms.messaging_group_id = NEW.messaging_group_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Inactive Mattermost subscription cannot own an active session');
      END;

      CREATE TRIGGER mattermost_guard_active_session_update
      BEFORE UPDATE OF status, agent_group_id, messaging_group_id, thread_id ON sessions
      WHEN NEW.status = 'active'
       AND EXISTS (
        SELECT 1 FROM mattermost_subscriptions ms
         WHERE ms.agent_group_id = NEW.agent_group_id
            OR ms.messaging_group_id = NEW.messaging_group_id
      )
       AND NOT EXISTS (
        SELECT 1 FROM mattermost_subscriptions ms
         WHERE ms.status = 'active'
           AND ms.agent_group_id = NEW.agent_group_id
           AND ms.messaging_group_id = NEW.messaging_group_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Inactive Mattermost subscription cannot own an active session');
      END;

      CREATE TRIGGER mattermost_guard_subscription_lifecycle_update
      BEFORE UPDATE OF status ON mattermost_subscriptions
      WHEN NEW.status <> OLD.status
       AND NOT (
            (OLD.status = 'pending' AND NEW.status = 'active')
         OR (OLD.status = 'active' AND NEW.status = 'unsubscribed')
         OR (OLD.status = 'unsubscribed' AND NEW.status IN ('active', 'archived'))
       )
      BEGIN
        SELECT RAISE(ABORT, 'Invalid Mattermost subscription lifecycle transition');
      END;

      CREATE TRIGGER mattermost_guard_subscription_archive_timestamp_insert
      BEFORE INSERT ON mattermost_subscriptions
      WHEN (NEW.status = 'archived' AND NEW.archived_at IS NULL)
        OR (NEW.status <> 'archived' AND NEW.archived_at IS NOT NULL)
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost archived status requires an archive timestamp');
      END;

      CREATE TRIGGER mattermost_guard_subscription_archive_timestamp_update
      BEFORE UPDATE OF status, archived_at ON mattermost_subscriptions
      WHEN (NEW.status = 'archived' AND NEW.archived_at IS NULL)
        OR (NEW.status <> 'archived' AND NEW.archived_at IS NOT NULL)
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost archived status requires an archive timestamp');
      END;

      CREATE TRIGGER mattermost_guard_permanent_destination_delete
      BEFORE DELETE ON agent_destinations
      WHEN EXISTS (
        SELECT 1 FROM mattermost_subscriptions ms
         WHERE ms.agent_group_id = OLD.agent_group_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Active Mattermost canonical destination cannot be deleted');
      END;

      CREATE TRIGGER mattermost_guard_session_cardinality_insert
      BEFORE INSERT ON sessions
      WHEN EXISTS (
        SELECT 1 FROM mattermost_subscriptions owner
         WHERE owner.agent_group_id = NEW.agent_group_id
            OR owner.messaging_group_id = NEW.messaging_group_id
      )
       AND EXISTS (
        SELECT 1
          FROM sessions existing
          JOIN mattermost_subscriptions owner
            ON owner.agent_group_id = existing.agent_group_id
            OR owner.messaging_group_id = existing.messaging_group_id
         WHERE owner.agent_group_id = NEW.agent_group_id
            OR owner.messaging_group_id = NEW.messaging_group_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost channel already owns a session identity');
      END;

      CREATE TRIGGER mattermost_guard_session_delete
      BEFORE DELETE ON sessions
      WHEN EXISTS (
        SELECT 1 FROM mattermost_subscriptions ms
         WHERE ms.agent_group_id = OLD.agent_group_id
            OR ms.messaging_group_id = OLD.messaging_group_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost session identity cannot be deleted');
      END;

      CREATE TRIGGER mattermost_guard_session_ownership_update
      BEFORE UPDATE OF id, agent_group_id, messaging_group_id, thread_id ON sessions
      WHEN EXISTS (
        SELECT 1 FROM mattermost_subscriptions ms
         WHERE ms.agent_group_id IN (OLD.agent_group_id, NEW.agent_group_id)
            OR ms.messaging_group_id IN (OLD.messaging_group_id, NEW.messaging_group_id)
      )
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost session ownership identity is immutable');
      END;

      CREATE TRIGGER mattermost_guard_unsubscribe_session_state
      BEFORE UPDATE OF status ON mattermost_subscriptions
      WHEN OLD.status = 'active' AND NEW.status = 'unsubscribed'
       AND EXISTS (
        SELECT 1 FROM sessions s
         WHERE (s.agent_group_id = OLD.agent_group_id OR s.messaging_group_id = OLD.messaging_group_id)
           AND (s.status IS NOT 'closed' OR s.container_status IS NOT 'stopped')
      )
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost sessions must be closed before unsubscribe');
      END;
    `);
  },
};
