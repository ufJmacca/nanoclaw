import { createHash } from 'node:crypto';

export const MISSION_SCHEMA = `
CREATE TABLE cos.mission_template_versions (
  scope_id text NOT NULL REFERENCES cos.scopes(id),id text NOT NULL,version integer NOT NULL CHECK(version>0),
  body jsonb NOT NULL,digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),reviewed_by text NOT NULL,
  provenance jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(scope_id,id,version)
);
CREATE TABLE cos.mission_context_manifests (
  scope_id text NOT NULL REFERENCES cos.scopes(id),digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  body jsonb NOT NULL,provenance jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(scope_id,digest)
);
CREATE TABLE cos.mission_work_orders (
  scope_id text NOT NULL,id text NOT NULL,body jsonb NOT NULL,digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  context_digest text NOT NULL,template_id text NOT NULL,template_version integer NOT NULL,
  provenance jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(scope_id,id),
  FOREIGN KEY(scope_id,context_digest) REFERENCES cos.mission_context_manifests(scope_id,digest),
  FOREIGN KEY(scope_id,template_id,template_version) REFERENCES cos.mission_template_versions(scope_id,id,version)
);
CREATE TABLE cos.missions (
  scope_id text NOT NULL,id text NOT NULL,proposal_id text UNIQUE REFERENCES cos.proposals(id),
  state text NOT NULL CHECK(state IN ('proposed','authorised','queued','running','awaiting_review','completed','partial','blocked','failed','cancelling','cancelled')),
  generation integer NOT NULL DEFAULT 0 CHECK(generation>=0),version integer NOT NULL DEFAULT 1 CHECK(version>0),
  provenance jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(scope_id,id),
  FOREIGN KEY(scope_id,id) REFERENCES cos.mission_work_orders(scope_id,id)
);
CREATE TABLE cos.mission_attempts (
  scope_id text NOT NULL,id text NOT NULL,mission_id text NOT NULL,generation integer NOT NULL CHECK(generation>0),
  dispatch_revision integer NOT NULL CHECK(dispatch_revision=1),input_id text NOT NULL UNIQUE,
  agent_group_id text NOT NULL UNIQUE,session_id text NOT NULL UNIQUE,
  state text NOT NULL CHECK(state IN ('queued','allocating','ready','running','submitted','failed','cancelled')),
  allocation jsonb NOT NULL DEFAULT '{}',lease_owner text,lease_until timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,id),UNIQUE(scope_id,mission_id,generation),UNIQUE(scope_id,mission_id,id,generation),
  FOREIGN KEY(scope_id,mission_id) REFERENCES cos.missions(scope_id,id)
);
CREATE TABLE cos.mission_budget_reservations (
  scope_id text NOT NULL,mission_id text NOT NULL,call_id text NOT NULL,attempt_id text NOT NULL,generation integer NOT NULL,
  kind text NOT NULL CHECK(kind IN ('attempt','model','tool')),payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,mission_id,call_id),
  FOREIGN KEY(scope_id,mission_id,attempt_id,generation) REFERENCES cos.mission_attempts(scope_id,mission_id,id,generation)
);
CREATE TABLE cos.mission_result_submissions (
  scope_id text NOT NULL,id text NOT NULL,mission_id text NOT NULL,attempt_id text NOT NULL,generation integer NOT NULL,
  body jsonb NOT NULL,digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),artifact_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,id),UNIQUE(scope_id,mission_id,id),UNIQUE(scope_id,attempt_id),
  FOREIGN KEY(scope_id,mission_id,attempt_id,generation) REFERENCES cos.mission_attempts(scope_id,mission_id,id,generation)
);
CREATE TABLE cos.mission_reviews (
  scope_id text NOT NULL,id text NOT NULL,mission_id text NOT NULL,result_id text NOT NULL,
  decision text NOT NULL CHECK(decision IN ('accept','partial','reject')),checks jsonb NOT NULL,provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,id),UNIQUE(scope_id,result_id),
  FOREIGN KEY(scope_id,mission_id,result_id) REFERENCES cos.mission_result_submissions(scope_id,mission_id,id)
);
CREATE INDEX mission_pending ON cos.missions(scope_id,state,created_at);
`;
export const MISSION_CHECKSUM = createHash('sha256').update(MISSION_SCHEMA).digest('hex');
