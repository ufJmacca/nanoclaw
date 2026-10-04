import { createHash } from 'node:crypto';

/** S08 adds durable standing grants and accounting; migration creates no active mandate. */
export const MANDATE_SCHEMA = `
CREATE TABLE cos.mandates (
  scope_id text NOT NULL REFERENCES cos.scopes(id), id text NOT NULL,
  owner_id text NOT NULL, session_id text NOT NULL, version integer NOT NULL CHECK(version>0),
  state text NOT NULL CHECK(state IN ('active','paused','revoked','suspended','expired')),
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(), last_local_date date,
  suspension_reason text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,id)
);
CREATE TABLE cos.mandate_revisions (
  scope_id text NOT NULL, mandate_id text NOT NULL, version integer NOT NULL CHECK(version>0),
  body jsonb NOT NULL, digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  proposal_id text NOT NULL UNIQUE REFERENCES cos.proposals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,mandate_id,version),
  FOREIGN KEY(scope_id,mandate_id) REFERENCES cos.mandates(scope_id,id)
);
CREATE TABLE cos.mandate_occurrences (
  scope_id text NOT NULL, mandate_id text NOT NULL, revision integer NOT NULL,
  occurrence_key text NOT NULL CHECK(occurrence_key ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK(kind IN ('event_approaching','project_changed','commitment_due','scheduled_review')),
  state text NOT NULL CHECK(state IN ('admitted','noop','denied','coalesced')),
  decision text NOT NULL, body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,occurrence_key),
  FOREIGN KEY(scope_id,mandate_id,revision) REFERENCES cos.mandate_revisions(scope_id,mandate_id,version)
);
CREATE TABLE cos.mandate_missions (
  scope_id text NOT NULL, mission_id text NOT NULL, mandate_id text NOT NULL, revision integer NOT NULL,
  occurrence_key text NOT NULL, approval_proposal_id text NOT NULL REFERENCES cos.proposals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,mission_id),
  UNIQUE(scope_id,occurrence_key), FOREIGN KEY(scope_id,mission_id) REFERENCES cos.missions(scope_id,id),
  FOREIGN KEY(scope_id,occurrence_key) REFERENCES cos.mandate_occurrences(scope_id,occurrence_key),
  FOREIGN KEY(scope_id,mandate_id,revision) REFERENCES cos.mandate_revisions(scope_id,mandate_id,version)
);
CREATE TABLE cos.mandate_reservations (
  scope_id text NOT NULL, mandate_id text NOT NULL, occurrence_key text NOT NULL,
  budget jsonb NOT NULL, state text NOT NULL CHECK(state IN ('held','settled','unknown')),
  used jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,occurrence_key), FOREIGN KEY(scope_id,mandate_id) REFERENCES cos.mandates(scope_id,id),
  FOREIGN KEY(scope_id,occurrence_key) REFERENCES cos.mandate_occurrences(scope_id,occurrence_key)
);
CREATE TABLE cos.mandate_activity (
  scope_id text NOT NULL, id text NOT NULL, mandate_id text NOT NULL, revision integer NOT NULL,
  body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,id),
  FOREIGN KEY(scope_id,mandate_id,revision) REFERENCES cos.mandate_revisions(scope_id,mandate_id,version)
);
CREATE TABLE cos.mandate_notifications (
  scope_id text NOT NULL, mission_id text NOT NULL, mandate_id text NOT NULL, revision integer NOT NULL,
  local_date date NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,mission_id), FOREIGN KEY(scope_id,mission_id) REFERENCES cos.mandate_missions(scope_id,mission_id),
  FOREIGN KEY(scope_id,mandate_id,revision) REFERENCES cos.mandate_revisions(scope_id,mandate_id,version)
);
CREATE TABLE cos.mandate_native_bindings (
  scope_id text NOT NULL, mandate_id text NOT NULL, revision integer NOT NULL,
  task_id text NOT NULL UNIQUE, ownership_digest text NOT NULL, state text NOT NULL CHECK(state IN ('staged','active','paused')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,mandate_id),
  FOREIGN KEY(scope_id,mandate_id,revision) REFERENCES cos.mandate_revisions(scope_id,mandate_id,version)
);
CREATE INDEX mandate_ready ON cos.mandates(scope_id,state,id);
CREATE INDEX mandate_accounting ON cos.mandate_reservations(scope_id,mandate_id,state);
CREATE INDEX mandate_daily_notifications ON cos.mandate_notifications(scope_id,mandate_id,local_date);
`;
export const MANDATE_CHECKSUM = createHash('sha256').update(MANDATE_SCHEMA).digest('hex');
