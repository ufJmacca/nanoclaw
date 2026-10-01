import { createHash } from 'node:crypto';
export const BRIEF_SCHEMA = `
CREATE TABLE cos.brief_runs (
  scope_id text NOT NULL,id text NOT NULL,schedule_id uuid NOT NULL,schedule_version integer NOT NULL,
  owner_id text NOT NULL,session_id text NOT NULL,agent_group_id text NOT NULL,
  intended_at timestamptz NOT NULL,local_date date NOT NULL,
  state text NOT NULL CHECK(state IN ('queued','dispatched','prepared','delivered','failed','cancelled','uncertain')),
  limits jsonb NOT NULL,model_calls integer NOT NULL DEFAULT 0 CHECK(model_calls>=0),tool_calls integer NOT NULL DEFAULT 0 CHECK(tool_calls>=0),
  generation integer NOT NULL DEFAULT 0,lease_owner text,lease_until timestamptz,deadline_at timestamptz NOT NULL,
  snapshot jsonb,version integer NOT NULL DEFAULT 1,provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,id),UNIQUE(scope_id,schedule_id,schedule_version,intended_at),UNIQUE(scope_id,schedule_id,local_date),
  FOREIGN KEY(scope_id,schedule_id,schedule_version) REFERENCES cos.brief_schedule_revisions(scope_id,schedule_id,version)
);
CREATE TABLE cos.brief_notifications (
  scope_id text NOT NULL,id text NOT NULL,run_id text NOT NULL,
  state text NOT NULL CHECK(state IN ('queued','delivering','delivered','failed','uncertain','cancelled')),
  payload jsonb,receipt jsonb,attempt_id text,started_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,id),UNIQUE(scope_id,run_id),FOREIGN KEY(scope_id,run_id) REFERENCES cos.brief_runs(scope_id,id)
);
CREATE TABLE cos.brief_call_reservations (
  scope_id text NOT NULL,run_id text NOT NULL,call_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('model','tool')),
  generation integer NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,run_id,call_id),FOREIGN KEY(scope_id,run_id) REFERENCES cos.brief_runs(scope_id,id)
);
`;
export const BRIEF_CHECKSUM = createHash('sha256').update(BRIEF_SCHEMA).digest('hex');
