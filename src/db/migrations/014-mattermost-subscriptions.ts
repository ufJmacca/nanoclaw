import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'mattermost-strict-subscriptions',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE mattermost_subscriptions (
        instance_key       TEXT NOT NULL,
        channel_id         TEXT NOT NULL,
        messaging_group_id TEXT NOT NULL UNIQUE REFERENCES messaging_groups(id),
        agent_group_id     TEXT NOT NULL UNIQUE REFERENCES agent_groups(id),
        wiring_id          TEXT NOT NULL UNIQUE REFERENCES messaging_group_agents(id),
        status             TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('pending', 'active', 'unsubscribed', 'archived')),
        created_at         TEXT NOT NULL,
        archived_at        TEXT,
        PRIMARY KEY (instance_key, channel_id)
      );

      CREATE TRIGGER mattermost_validate_active_subscription_insert
      BEFORE INSERT ON mattermost_subscriptions
      WHEN NEW.status = 'active' AND (
        NOT EXISTS (
          SELECT 1
            FROM messaging_groups mg
           WHERE mg.id = NEW.messaging_group_id
             AND mg.channel_type = 'mattermost'
             AND mg.platform_id = 'mattermost:' || NEW.instance_key || ':' || NEW.channel_id
             AND mg.is_group = 1
             AND mg.unknown_sender_policy = 'strict'
             AND mg.denied_at IS NULL
        )
        OR NOT EXISTS (
          SELECT 1
            FROM messaging_group_agents mga
           WHERE mga.id = NEW.wiring_id
             AND mga.messaging_group_id = NEW.messaging_group_id
             AND mga.agent_group_id = NEW.agent_group_id
             AND mga.engage_mode = 'pattern'
             AND mga.engage_pattern = '.'
             AND mga.sender_scope = 'known'
             AND mga.ignored_message_policy = 'drop'
             AND mga.session_mode = 'shared'
        )
        OR (SELECT COUNT(*) FROM messaging_group_agents WHERE messaging_group_id = NEW.messaging_group_id) <> 1
        OR (SELECT COUNT(*) FROM messaging_group_agents WHERE agent_group_id = NEW.agent_group_id) <> 1
        OR (SELECT COUNT(*) FROM agent_destinations WHERE agent_group_id = NEW.agent_group_id) <> 1
        OR NOT EXISTS (
          SELECT 1
            FROM agent_destinations ad
           WHERE ad.agent_group_id = NEW.agent_group_id
             AND ad.target_type = 'channel'
             AND ad.target_id = NEW.messaging_group_id
        )
        OR EXISTS (
          SELECT 1
            FROM agent_destinations ad
           WHERE ad.target_type = 'agent'
             AND ad.target_id = NEW.agent_group_id
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost subscription topology must be exclusive');
      END;

      CREATE TRIGGER mattermost_guard_subscription_identity_update
      BEFORE UPDATE OF instance_key, channel_id, messaging_group_id, agent_group_id, wiring_id, created_at
      ON mattermost_subscriptions
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost subscription ownership identity is immutable');
      END;

      CREATE TRIGGER mattermost_validate_active_subscription_update
      BEFORE UPDATE OF status ON mattermost_subscriptions
      WHEN NEW.status = 'active' AND (
        NOT EXISTS (
          SELECT 1 FROM messaging_groups mg
           WHERE mg.id = NEW.messaging_group_id
             AND mg.channel_type = 'mattermost'
             AND mg.platform_id = 'mattermost:' || NEW.instance_key || ':' || NEW.channel_id
             AND mg.is_group = 1
             AND mg.unknown_sender_policy = 'strict'
             AND mg.denied_at IS NULL
        )
        OR NOT EXISTS (
          SELECT 1 FROM messaging_group_agents mga
           WHERE mga.id = NEW.wiring_id
             AND mga.messaging_group_id = NEW.messaging_group_id
             AND mga.agent_group_id = NEW.agent_group_id
             AND mga.engage_mode = 'pattern'
             AND mga.engage_pattern = '.'
             AND mga.sender_scope = 'known'
             AND mga.ignored_message_policy = 'drop'
             AND mga.session_mode = 'shared'
        )
        OR (SELECT COUNT(*) FROM messaging_group_agents WHERE messaging_group_id = NEW.messaging_group_id) <> 1
        OR (SELECT COUNT(*) FROM messaging_group_agents WHERE agent_group_id = NEW.agent_group_id) <> 1
        OR (SELECT COUNT(*) FROM agent_destinations WHERE agent_group_id = NEW.agent_group_id) <> 1
        OR NOT EXISTS (
          SELECT 1 FROM agent_destinations ad
           WHERE ad.agent_group_id = NEW.agent_group_id
             AND ad.target_type = 'channel'
             AND ad.target_id = NEW.messaging_group_id
        )
        OR EXISTS (
          SELECT 1 FROM agent_destinations ad
           WHERE ad.target_type = 'agent' AND ad.target_id = NEW.agent_group_id
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost subscription topology must be exclusive');
      END;

      CREATE TRIGGER mattermost_guard_subscription_delete
      BEFORE DELETE ON mattermost_subscriptions
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost ownership reservation cannot be deleted');
      END;

      CREATE TRIGGER mattermost_guard_agent_workspace_identity_update
      BEFORE UPDATE OF id, folder ON agent_groups
      WHEN EXISTS (
        SELECT 1 FROM mattermost_subscriptions ms WHERE ms.agent_group_id = OLD.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost agent workspace identity is immutable');
      END;

      CREATE TRIGGER mattermost_guard_messaging_channel_identity_update
      BEFORE UPDATE OF id, channel_type, platform_id ON messaging_groups
      WHEN EXISTS (
        SELECT 1 FROM mattermost_subscriptions ms WHERE ms.messaging_group_id = OLD.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost messaging channel identity is immutable');
      END;

      CREATE TRIGGER mattermost_guard_reserved_agent_wiring_insert
      BEFORE INSERT ON messaging_group_agents
      WHEN EXISTS (
        SELECT 1
          FROM mattermost_subscriptions ms
         WHERE ms.agent_group_id = NEW.agent_group_id
           AND (ms.messaging_group_id <> NEW.messaging_group_id OR ms.wiring_id <> NEW.id)
      )
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost agent group is reserved for its canonical channel');
      END;

      CREATE TRIGGER mattermost_guard_reserved_group_wiring_insert
      BEFORE INSERT ON messaging_group_agents
      WHEN EXISTS (
        SELECT 1
          FROM mattermost_subscriptions ms
         WHERE ms.messaging_group_id = NEW.messaging_group_id
           AND (ms.agent_group_id <> NEW.agent_group_id OR ms.wiring_id <> NEW.id)
      )
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost messaging group is reserved for its canonical agent');
      END;

      CREATE TRIGGER mattermost_guard_reserved_agent_wiring_update
      BEFORE UPDATE ON messaging_group_agents
      WHEN EXISTS (
        SELECT 1
          FROM mattermost_subscriptions ms
         WHERE ms.agent_group_id = NEW.agent_group_id
           AND ms.wiring_id <> NEW.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost agent group is reserved for its canonical channel');
      END;

      CREATE TRIGGER mattermost_guard_reserved_group_wiring_update
      BEFORE UPDATE ON messaging_group_agents
      WHEN EXISTS (
        SELECT 1
          FROM mattermost_subscriptions ms
         WHERE ms.messaging_group_id = NEW.messaging_group_id
           AND ms.wiring_id <> NEW.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost messaging group is reserved for its canonical agent');
      END;

      CREATE TRIGGER mattermost_guard_canonical_wiring_identity_update
      BEFORE UPDATE OF id, messaging_group_id, agent_group_id ON messaging_group_agents
      WHEN EXISTS (
        SELECT 1 FROM mattermost_subscriptions ms WHERE ms.wiring_id = OLD.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost canonical wiring ownership is immutable');
      END;

      CREATE TRIGGER mattermost_guard_canonical_wiring_update
      BEFORE UPDATE ON messaging_group_agents
      WHEN EXISTS (
        SELECT 1
          FROM mattermost_subscriptions ms
         WHERE ms.status = 'active' AND ms.wiring_id = OLD.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Active Mattermost canonical wiring cannot be changed');
      END;

      CREATE TRIGGER mattermost_guard_outgoing_destination_insert
      BEFORE INSERT ON agent_destinations
      WHEN EXISTS (
        SELECT 1
          FROM mattermost_subscriptions ms
         WHERE ms.agent_group_id = NEW.agent_group_id
           AND (
             NEW.target_type <> 'channel'
             OR NEW.target_id <> ms.messaging_group_id
             OR EXISTS (
               SELECT 1 FROM agent_destinations existing
                WHERE existing.agent_group_id = NEW.agent_group_id
             )
           )
      )
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost agent destinations are restricted to the canonical channel');
      END;

      CREATE TRIGGER mattermost_guard_outgoing_destination_owner_update
      BEFORE UPDATE OF agent_group_id ON agent_destinations
      WHEN EXISTS (
        SELECT 1
          FROM mattermost_subscriptions ms
         WHERE ms.agent_group_id = NEW.agent_group_id
           AND OLD.agent_group_id <> ms.agent_group_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost agent destinations are restricted to the canonical channel');
      END;

      CREATE TRIGGER mattermost_guard_canonical_destination_identity_update
      BEFORE UPDATE OF agent_group_id, target_type, target_id ON agent_destinations
      WHEN EXISTS (
        SELECT 1 FROM mattermost_subscriptions ms WHERE ms.agent_group_id = OLD.agent_group_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost canonical destination ownership is immutable');
      END;

      CREATE TRIGGER mattermost_guard_canonical_destination_update
      BEFORE UPDATE ON agent_destinations
      WHEN EXISTS (
        SELECT 1
          FROM mattermost_subscriptions ms
         WHERE ms.status = 'active' AND ms.agent_group_id = OLD.agent_group_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Active Mattermost canonical destination cannot be changed');
      END;

      CREATE TRIGGER mattermost_guard_canonical_destination_delete
      BEFORE DELETE ON agent_destinations
      WHEN EXISTS (
        SELECT 1
          FROM mattermost_subscriptions ms
         WHERE ms.status = 'active' AND ms.agent_group_id = OLD.agent_group_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Active Mattermost canonical destination cannot be deleted');
      END;

      CREATE TRIGGER mattermost_guard_incoming_destination_insert
      BEFORE INSERT ON agent_destinations
      WHEN NEW.target_type = 'agent'
       AND EXISTS (
        SELECT 1
          FROM mattermost_subscriptions ms
         WHERE ms.agent_group_id = NEW.target_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost agent groups cannot be agent destinations');
      END;

      CREATE TRIGGER mattermost_guard_incoming_destination_update
      BEFORE UPDATE ON agent_destinations
      WHEN NEW.target_type = 'agent'
       AND EXISTS (
        SELECT 1
          FROM mattermost_subscriptions ms
         WHERE ms.agent_group_id = NEW.target_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Mattermost agent groups cannot be agent destinations');
      END;
    `);
  },
};
