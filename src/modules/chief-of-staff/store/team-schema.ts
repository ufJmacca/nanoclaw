import { createHash } from 'node:crypto';

/** S06's immutable approved graph and root credit escrow. No agent receives SQL access. */
export const TEAM_SCHEMA = `
CREATE TABLE cos.mission_team_work_orders (
  scope_id text NOT NULL,id text NOT NULL,body jsonb NOT NULL,digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  context_digest text NOT NULL,provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,id),FOREIGN KEY(scope_id,context_digest) REFERENCES cos.mission_context_manifests(scope_id,digest)
);
CREATE TABLE cos.mission_team_roots (
  scope_id text NOT NULL,id text NOT NULL,proposal_id text UNIQUE REFERENCES cos.proposals(id),
  state text NOT NULL CHECK(state IN ('proposed','queued','running','awaiting_review','completed','partial','blocked','failed','cancelling','cancelled')),
  generation integer NOT NULL DEFAULT 0 CHECK(generation>=0),version integer NOT NULL DEFAULT 1 CHECK(version>0),
  provenance jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,id),FOREIGN KEY(scope_id,id) REFERENCES cos.mission_team_work_orders(scope_id,id)
);
CREATE TABLE cos.mission_team_steps (
  scope_id text NOT NULL,team_id text NOT NULL,step_id text NOT NULL,definition jsonb NOT NULL,
  state text NOT NULL CHECK(state IN ('blocked','ready','running','submitted','completed','partial','failed','cancelled')),
  child_mission_id text UNIQUE,version integer NOT NULL DEFAULT 1 CHECK(version>0),provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,team_id,step_id),FOREIGN KEY(scope_id,team_id) REFERENCES cos.mission_team_roots(scope_id,id),
  FOREIGN KEY(scope_id,child_mission_id) REFERENCES cos.missions(scope_id,id)
);
CREATE TABLE cos.mission_team_dependencies (
  scope_id text NOT NULL,team_id text NOT NULL,step_id text NOT NULL,depends_on text NOT NULL CHECK(step_id<>depends_on),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,team_id,step_id,depends_on),
  FOREIGN KEY(scope_id,team_id,step_id) REFERENCES cos.mission_team_steps(scope_id,team_id,step_id),
  FOREIGN KEY(scope_id,team_id,depends_on) REFERENCES cos.mission_team_steps(scope_id,team_id,step_id)
);
CREATE TABLE cos.mission_team_reservations (
  scope_id text NOT NULL,team_id text NOT NULL,step_id text NOT NULL,
  max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 1 AND 3),max_turns integer NOT NULL CHECK(max_turns BETWEEN 1 AND 12),
  max_tool_calls integer NOT NULL CHECK(max_tool_calls BETWEEN 1 AND 64),
  state text NOT NULL CHECK(state IN ('reserved','settled','cancelled')),usage jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,team_id,step_id),FOREIGN KEY(scope_id,team_id,step_id) REFERENCES cos.mission_team_steps(scope_id,team_id,step_id)
);
CREATE TABLE cos.mission_team_budget_events (
  scope_id text NOT NULL,team_id text NOT NULL,step_id text NOT NULL,id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('reserved','released','uncertain')),body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,id),UNIQUE(scope_id,team_id,step_id,kind),
  FOREIGN KEY(scope_id,team_id,step_id) REFERENCES cos.mission_team_steps(scope_id,team_id,step_id)
);
CREATE INDEX mission_team_pending ON cos.mission_team_roots(scope_id,state,id);
`;
export const TEAM_CHECKSUM = createHash('sha256').update(TEAM_SCHEMA).digest('hex');
