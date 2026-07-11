import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'mattermost-recovery',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE mattermost_recovery_cursors (
        instance_key        TEXT NOT NULL,
        channel_id          TEXT NOT NULL,
        last_post_created_at INTEGER NOT NULL DEFAULT 0 CHECK (last_post_created_at >= 0),
        last_post_id         TEXT,
        updated_at           TEXT NOT NULL,
        PRIMARY KEY (instance_key, channel_id),
        FOREIGN KEY (instance_key, channel_id)
          REFERENCES mattermost_subscriptions(instance_key, channel_id)
      );

      CREATE TABLE mattermost_post_receipts (
        instance_key  TEXT NOT NULL,
        post_id       TEXT NOT NULL,
        channel_id    TEXT NOT NULL,
        create_at     INTEGER NOT NULL CHECK (create_at >= 0),
        payload_digest TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('processing', 'completed')),
        claimed_at    TEXT NOT NULL,
        completed_at  TEXT,
        PRIMARY KEY (instance_key, post_id),
        CHECK (
             (status = 'processing' AND completed_at IS NULL)
          OR (status = 'completed' AND completed_at IS NOT NULL)
        )
      );

      CREATE INDEX idx_mattermost_post_receipts_channel_created
        ON mattermost_post_receipts(instance_key, channel_id, create_at, post_id);

      CREATE TABLE mattermost_approval_recovery_quarantine (
        approval_id   TEXT PRIMARY KEY
                      REFERENCES pending_mattermost_channel_approvals(approval_id)
                      ON DELETE CASCADE,
        reason        TEXT NOT NULL CHECK (reason IN (
                        'invalid_stored_event',
                        'event_identity_mismatch',
                        'non_pristine_placeholder',
                        'orphan_workspace_identity',
                        'invalid_subscription_topology',
                        'unsafe_subscription_filesystem',
                        'invalid_session_topology',
                        'message_identity_collision',
                        'bot_membership_absent'
                      )),
        quarantined_at TEXT NOT NULL
      );
    `);
  },
};
