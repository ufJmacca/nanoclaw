import { createHash } from 'node:crypto';
/** S07 state is scoped and durable. No connector, live activation or execution grant is added by DDL. */
export const PROACTIVE_SCHEMA = `
CREATE TABLE cos.proactive_policies (
  scope_id text PRIMARY KEY REFERENCES cos.scopes(id), owner_id text NOT NULL,
  version integer NOT NULL CHECK(version>0), state text NOT NULL CHECK(state IN ('active','paused')),
  policy jsonb NOT NULL, provenance jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE cos.proactive_policy_revisions (
  scope_id text NOT NULL REFERENCES cos.scopes(id), version integer NOT NULL CHECK(version>0),
  body jsonb NOT NULL, proposal_id text NOT NULL UNIQUE REFERENCES cos.proposals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,version)
);
CREATE TABLE cos.proactive_observations (
  scope_id text NOT NULL REFERENCES cos.scopes(id), event_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('source_revision','calendar_snapshot','commitment_transition','mission_outcome')),
  resource_id text NOT NULL, resource_version integer NOT NULL CHECK(resource_version>0), project_id text,
  observed_at timestamptz NOT NULL, material_digest text NOT NULL CHECK(material_digest ~ '^[a-f0-9]{64}$'),
  provenance jsonb NOT NULL, PRIMARY KEY(scope_id,event_id), UNIQUE(scope_id,kind,resource_id,resource_version),
  FOREIGN KEY(scope_id,project_id) REFERENCES cos.records(scope_id,id)
);
CREATE TABLE cos.proactive_batches (
  scope_id text NOT NULL REFERENCES cos.scopes(id), id text NOT NULL, session_id text NOT NULL,
  policy_version integer NOT NULL CHECK(policy_version>0), body jsonb NOT NULL, digest text NOT NULL,
  context jsonb NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,id)
);
CREATE TABLE cos.proactive_suggestions (
  scope_id text NOT NULL REFERENCES cos.scopes(id), id text NOT NULL,
  semantic_key text NOT NULL CHECK(semantic_key ~ '^[a-f0-9]{64}$'), family_key text NOT NULL,
  version integer NOT NULL CHECK(version>0), state text NOT NULL CHECK(state IN ('open','accepted','deferred','dismissed')),
  review_at timestamptz, prior_id text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,id), UNIQUE(scope_id,semantic_key),
  FOREIGN KEY(scope_id,prior_id) REFERENCES cos.proactive_suggestions(scope_id,id)
);
CREATE TABLE cos.proactive_revisions (
  scope_id text NOT NULL, suggestion_id text NOT NULL, version integer NOT NULL CHECK(version>0),
  batch_id text NOT NULL, body jsonb NOT NULL, digest text NOT NULL, context jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,suggestion_id,version),
  FOREIGN KEY(scope_id,suggestion_id) REFERENCES cos.proactive_suggestions(scope_id,id),
  FOREIGN KEY(scope_id,batch_id) REFERENCES cos.proactive_batches(scope_id,id)
);
CREATE TABLE cos.proactive_feedback (
  scope_id text NOT NULL, suggestion_id text NOT NULL, version integer NOT NULL,
  proposal_id text NOT NULL UNIQUE REFERENCES cos.proposals(id), decision text NOT NULL CHECK(decision IN ('accept','defer','dismiss')),
  review_at timestamptz, reason text NOT NULL, usefulness text NOT NULL CHECK(usefulness IN ('useful','not_useful','unrated')),
  review_seconds integer NOT NULL CHECK(review_seconds BETWEEN 0 AND 3600), provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,proposal_id),
  FOREIGN KEY(scope_id,suggestion_id,version) REFERENCES cos.proactive_revisions(scope_id,suggestion_id,version)
);
CREATE TABLE cos.proactive_notifications (
  scope_id text NOT NULL, suggestion_id text NOT NULL, version integer NOT NULL,
  local_date date NOT NULL, route text NOT NULL CHECK(route IN ('digest','interruption')), provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,suggestion_id,version),
  FOREIGN KEY(scope_id,suggestion_id,version) REFERENCES cos.proactive_revisions(scope_id,suggestion_id,version)
);
CREATE INDEX proactive_open ON cos.proactive_suggestions(scope_id,state,updated_at,id);
CREATE INDEX proactive_daily_budget ON cos.proactive_notifications(scope_id,local_date);
`;
export const PROACTIVE_CHECKSUM = createHash('sha256').update(PROACTIVE_SCHEMA).digest('hex');
