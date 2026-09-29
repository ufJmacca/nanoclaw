import { createHash } from 'node:crypto';

export const INITIAL_SCHEMA = `
CREATE TABLE cos.scopes (
  id text PRIMARY KEY, owner_id text NOT NULL, instance_id text NOT NULL,
  channel_id text NOT NULL, agent_group_id text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('active','paused','revoked')),
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(instance_id,channel_id)
);
CREATE TABLE cos.records (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES cos.scopes(id),
  kind text NOT NULL CHECK (kind IN ('charter','goal','project')),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  description text NOT NULL CHECK(length(description) <= 8000),
  lifecycle text NOT NULL CHECK(lifecycle IN ('active','inactive')),
  version integer NOT NULL CHECK(version > 0), provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(scope_id,id)
);
CREATE UNIQUE INDEX one_active_charter ON cos.records(scope_id) WHERE kind='charter' AND lifecycle='active';
CREATE TABLE cos.proposals (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES cos.scopes(id),
  session_id text NOT NULL, ingress_id text NOT NULL, owner_id text NOT NULL,
  change jsonb NOT NULL, payload_hash text NOT NULL, challenge_hash text NOT NULL,
  state text NOT NULL CHECK(state IN ('pending','approved','rejected','applied','conflict','expired')),
  expires_at timestamptz NOT NULL, decision_ingress_id text UNIQUE,
  applied_record_id text, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE cos.operations (
  session_id text NOT NULL, request_id text NOT NULL,
  scope_id text NOT NULL REFERENCES cos.scopes(id), method text NOT NULL,
  payload_hash text NOT NULL, result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(session_id,request_id)
);
CREATE TABLE cos.events (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES cos.scopes(id),
  kind text NOT NULL, resource_id text NOT NULL, version integer NOT NULL,
  provenance jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE cos.outbox (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES cos.scopes(id),
  kind text NOT NULL CHECK(kind IN ('approval_preview','proposal_apply','rpc_response')),
  payload jsonb NOT NULL, delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
`;
export const INITIAL_CHECKSUM = createHash('sha256').update(INITIAL_SCHEMA).digest('hex');
