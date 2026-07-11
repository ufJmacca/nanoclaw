/**
 * Reference copy of the current v2 schema.
 * Read this to understand the DB structure.
 * Actual creation is done by migrations — do not use this at runtime.
 */

export const SCHEMA = `
-- Agent workspaces: folder, skills, CLAUDE.md.
-- All workspaces are equal; privilege lives on users, not groups.
-- Container config (mcpServers, packages, imageTag, additionalMounts) lives
-- in groups/<folder>/container.json on disk, not in the DB.
CREATE TABLE agent_groups (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  folder           TEXT NOT NULL UNIQUE,
  agent_provider   TEXT,
  created_at       TEXT NOT NULL
);

-- Platform groups/channels. unknown_sender_policy governs what happens
-- when a sender we've never seen before posts in this chat.
-- The column DEFAULT is "strict" (inherited from migration 001), but it
-- only matters if something inserts without specifying the field, which no
-- current callsite does. Router auto-create hardcodes "request_approval"
-- (see src/router.ts:151); setup scripts pick per context.
CREATE TABLE messaging_groups (
  id                    TEXT PRIMARY KEY,
  channel_type          TEXT NOT NULL,
  platform_id           TEXT NOT NULL,
  name                  TEXT,
  is_group              INTEGER DEFAULT 0,
  unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
                        -- 'strict' | 'request_approval' | 'public'
  denied_at             TEXT,
  created_at            TEXT NOT NULL,
  UNIQUE(channel_type, platform_id)
);

-- Which agent groups handle which messaging groups.
-- engage_mode / engage_pattern / sender_scope / ignored_message_policy are
-- the four orthogonal axes that together replace v1's opaque trigger_rules
-- JSON + response_scope enum. See docs/v1-vs-v2/ACTION-ITEMS.md item 1.
CREATE TABLE messaging_group_agents (
  id                     TEXT PRIMARY KEY,
  messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
  engage_mode            TEXT NOT NULL DEFAULT 'mention',
                         -- 'pattern' | 'mention' | 'mention-sticky'
  engage_pattern         TEXT,   -- regex; required when engage_mode='pattern';
                                 -- '.' means "match every message" (the "always" flavor)
  sender_scope           TEXT NOT NULL DEFAULT 'all',    -- 'all' | 'known'
  ignored_message_policy TEXT NOT NULL DEFAULT 'drop',   -- 'drop' | 'accumulate'
  session_mode           TEXT DEFAULT 'shared',
  priority               INTEGER DEFAULT 0,
  created_at             TEXT NOT NULL,
  UNIQUE(messaging_group_id, agent_group_id)
);

-- Per-agent routing map and delivery ACL. target_id refers to a messaging
-- group for channel targets and an agent group for agent targets.
CREATE TABLE agent_destinations (
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  local_name     TEXT NOT NULL,
  target_type    TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (agent_group_id, local_name)
);
CREATE INDEX idx_agent_dest_target ON agent_destinations(target_type, target_id);

-- Canonical one-channel/one-agent boundary for Mattermost. A strict
-- subscription owns one messaging group, one fresh agent group, and one
-- shared-session wiring. Runtime routing validates the complete topology;
-- these UNIQUE keys serialize subscription races at the database layer.
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
  SELECT 1 FROM mattermost_subscriptions ms
   WHERE ms.messaging_group_id = NEW.messaging_group_id
     AND (ms.agent_group_id <> NEW.agent_group_id OR ms.wiring_id <> NEW.id)
)
BEGIN
  SELECT RAISE(ABORT, 'Mattermost messaging group is reserved for its canonical agent');
END;

CREATE TRIGGER mattermost_guard_reserved_agent_wiring_update
BEFORE UPDATE ON messaging_group_agents
WHEN EXISTS (
  SELECT 1 FROM mattermost_subscriptions ms
   WHERE ms.agent_group_id = NEW.agent_group_id
     AND ms.wiring_id <> NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'Mattermost agent group is reserved for its canonical channel');
END;

CREATE TRIGGER mattermost_guard_reserved_group_wiring_update
BEFORE UPDATE ON messaging_group_agents
WHEN EXISTS (
  SELECT 1 FROM mattermost_subscriptions ms
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
  SELECT 1 FROM mattermost_subscriptions ms
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
  SELECT 1 FROM mattermost_subscriptions ms
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
  SELECT 1 FROM mattermost_subscriptions ms
   WHERE ms.status = 'active' AND ms.agent_group_id = OLD.agent_group_id
)
BEGIN
  SELECT RAISE(ABORT, 'Active Mattermost canonical destination cannot be changed');
END;

CREATE TRIGGER mattermost_guard_canonical_destination_delete
BEFORE DELETE ON agent_destinations
WHEN EXISTS (
  SELECT 1 FROM mattermost_subscriptions ms
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
  SELECT 1 FROM mattermost_subscriptions ms
   WHERE ms.agent_group_id = NEW.target_id
)
BEGIN
  SELECT RAISE(ABORT, 'Mattermost agent groups cannot be agent destinations');
END;

-- Users are messaging-platform identifiers, namespaced: "phone:+1555...",
-- "tg:123", "discord:456", "email:a@x.com". A single human can own multiple
-- user rows if they have identifiers on unrelated channels (no linking yet).
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  display_name TEXT,
  created_at   TEXT NOT NULL
);

-- Role grants on users. Privilege is user-level, not group-level.
--   role ∈ {owner, admin}
--   owner: always global (agent_group_id IS NULL)
--   admin: agent_group_id NULL = global, else scoped to that agent group
-- Invariant: admin @ A implies membership in A (no row needed).
CREATE TABLE user_roles (
  user_id        TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL,
  agent_group_id TEXT REFERENCES agent_groups(id),
  granted_by     TEXT REFERENCES users(id),
  granted_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
CREATE INDEX idx_user_roles_scope ON user_roles(agent_group_id, role);

-- "Known" membership in an agent group. Required for an unprivileged user
-- to interact with a workspace. Admin @ A is implicitly a member of A.
CREATE TABLE agent_group_members (
  user_id        TEXT NOT NULL REFERENCES users(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  added_by       TEXT REFERENCES users(id),
  added_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);

-- Cached mapping from (user, channel) to the DM messaging group. Lets the
-- host initiate cold DMs (pairing, approvals) without reprobing the
-- platform API on every send. Populated lazily by ensureUserDm().
CREATE TABLE user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);

-- Sessions: one folder = one session = one container when running
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  messaging_group_id TEXT REFERENCES messaging_groups(id),
  thread_id          TEXT,
  agent_provider     TEXT,
  status             TEXT DEFAULT 'active',
  container_status   TEXT DEFAULT 'stopped',
  last_active        TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX idx_sessions_lookup ON sessions(messaging_group_id, thread_id);

-- Exactly one NanoClaw host may admit container executions for this central
-- database. The owner process is checked before stale crash state is replaced.
CREATE TABLE host_execution_lease (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  owner_id     TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  pid          INTEGER NOT NULL CHECK (pid > 0),
  acquired_at  TEXT NOT NULL
);

-- Host-side state for owner-authorized creation of a new dedicated
-- Mattermost subscription. Completed/rejected rows are retained as audit
-- state; only pending/processing rows can be decided.
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

-- Durable content-free recovery state. Cursors advance only after a complete
-- channel recovery window is proven; receipts never store raw post bodies.
CREATE TABLE mattermost_recovery_cursors (
  instance_key         TEXT NOT NULL,
  channel_id           TEXT NOT NULL,
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

-- A compact, content-free rejection boundary for completed receipts retired
-- from bounded storage. It deliberately has no subscription foreign key:
-- unknown and owner-pending channels receive durable deduplication too.
CREATE TABLE mattermost_receipt_retention_floors (
  instance_key            TEXT NOT NULL,
  channel_id              TEXT NOT NULL,
  reject_before_create_at INTEGER NOT NULL CHECK (reject_before_create_at >= 0),
  updated_at              TEXT NOT NULL,
  PRIMARY KEY (instance_key, channel_id)
);

-- A processing approval is durable evidence that the designated owner
-- already authorized the subscription. Deterministically corrupt recovery
-- state remains non-rejectable in processing while this content-free record
-- prevents repeated automatic recovery attempts.
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

-- Phase 7 lifecycle guards. Application services perform the same checks,
-- while these triggers serialize stale routes and direct SQLite writers.
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

-- Pending interactive questions
CREATE TABLE pending_questions (
  question_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  message_out_id TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  title          TEXT NOT NULL,
  options_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- Pending approvals for unknown senders (unknown_sender_policy='request_approval').
-- In-flight dedup via UNIQUE(messaging_group_id, sender_identity): a second
-- message from the same unknown sender while a card is pending is silently
-- dropped instead of spamming the admin.
CREATE TABLE pending_sender_approvals (
  id                 TEXT PRIMARY KEY,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  sender_identity    TEXT NOT NULL,    -- namespaced user id (channel_type:handle)
  sender_name        TEXT,
  original_message   TEXT NOT NULL,    -- JSON of the original InboundEvent
  approver_user_id   TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  UNIQUE(messaging_group_id, sender_identity)
);
`;

/**
 * Session DB schemas — split into two files so each has exactly one writer.
 * This eliminates SQLite write contention across the host-container mount boundary.
 *
 *   inbound.db  — host writes, container reads (read-only mount or open read-only)
 *   outbound.db — container writes, host reads (read-only open)
 */

/** Host-owned: inbound messages + delivery tracking + destination map. */
export const INBOUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_in (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  kind           TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  status         TEXT DEFAULT 'pending',
  process_after  TEXT,
  recurrence     TEXT,
  series_id      TEXT,
  tries          INTEGER DEFAULT 0,
  trigger        INTEGER NOT NULL DEFAULT 1,
                 -- 0 = accumulated context (don't wake), 1 = wake agent
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_in_series ON messages_in(series_id);

-- Host tracks delivery outcomes for messages_out IDs.
-- Avoids writing to outbound.db (container-owned).
CREATE TABLE IF NOT EXISTS delivered (
  message_out_id      TEXT PRIMARY KEY,
  platform_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'delivered',
  delivered_at        TEXT NOT NULL
);

-- Destination map for this session's agent.
-- Host overwrites on every container wake AND on demand (rewires, new child
-- agents, etc.). Container queries this live on every lookup, so changes
-- take effect mid-session without requiring a container restart.
CREATE TABLE IF NOT EXISTS destinations (
  name            TEXT PRIMARY KEY,
  display_name    TEXT,
  type            TEXT NOT NULL,   -- 'channel' | 'agent'
  channel_type    TEXT,            -- for type='channel'
  platform_id     TEXT,            -- for type='channel'
  agent_group_id  TEXT             -- for type='agent'
);

-- Default reply routing for this session. Single-row table (id=1).
-- Host overwrites on every container wake from the session's messaging_group
-- and thread_id. Container reads it in send_message / ask_user_question to
-- default the channel/thread of outbound messages when the agent doesn't
-- specify an explicit destination.
CREATE TABLE IF NOT EXISTS session_routing (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  channel_type TEXT,
  platform_id  TEXT,
  thread_id    TEXT
);
`;

/** Container-owned: outbound messages + processing acknowledgments. */
export const OUTBOUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_out (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  in_reply_to    TEXT,
  timestamp      TEXT NOT NULL,
  deliver_after  TEXT,
  recurrence     TEXT,
  kind           TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL
);

-- Container tracks processing status here instead of updating messages_in.
-- Host reads this to know which messages have been processed.
-- On container startup, stale 'processing' entries are cleared (crash recovery).
CREATE TABLE IF NOT EXISTS processing_ack (
  message_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  status_changed TEXT NOT NULL
);

-- Persistent key/value state owned by the container. Used (among other things)
-- to store the SDK session ID so the agent's conversation resumes across
-- container restarts. Cleared by /clear.
CREATE TABLE IF NOT EXISTS session_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Current tool-in-flight state. Single-row table (id=1). Container writes on
-- PreToolUse and clears on PostToolUse / PostToolUseFailure. Host reads in the
-- sweep to extend the stuck-tolerance window when Bash is running with a
-- declared timeout > 60s (long-running scripts shouldn't be flagged as stuck).
CREATE TABLE IF NOT EXISTS container_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  current_tool             TEXT,
  tool_declared_timeout_ms INTEGER,
  tool_started_at          TEXT,
  updated_at               TEXT NOT NULL
);
`;
