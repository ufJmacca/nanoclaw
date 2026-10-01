import { createHash } from 'node:crypto';
export const SCHEDULE_SCHEMA = `
CREATE TABLE cos.brief_schedules (
  scope_id text NOT NULL REFERENCES cos.scopes(id),id uuid NOT NULL,
  owner_id text NOT NULL,session_id text NOT NULL,agent_group_id text NOT NULL,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  policy jsonb NOT NULL,limits jsonb NOT NULL,version integer NOT NULL CHECK(version>0),
  provenance jsonb NOT NULL,activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_local_date date,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,id),UNIQUE(scope_id),
  CHECK(policy->>'state' IN ('active','paused'))
);
CREATE TABLE cos.brief_schedule_revisions (
  scope_id text NOT NULL,schedule_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
  body jsonb NOT NULL,proposal_id text NOT NULL UNIQUE REFERENCES cos.proposals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,schedule_id,version),
  FOREIGN KEY(scope_id,schedule_id) REFERENCES cos.brief_schedules(scope_id,id)
);
`;
export const SCHEDULE_CHECKSUM = createHash('sha256').update(SCHEDULE_SCHEMA).digest('hex');
