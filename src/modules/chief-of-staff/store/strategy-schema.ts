import { createHash } from 'node:crypto';
/** S10 direction is recorded separately from core record lifecycle, preserving existing obligations.
 * Unapproved review text lives in purgeable private artifacts; this schema stores references and fences.
 * Nothing in DDL enables a review cadence, specialist, model call, writer or external effect. */
export const STRATEGY_SCHEMA = `
ALTER TABLE cos.proposals ADD CONSTRAINT proposals_scope_identity UNIQUE(scope_id,id);
CREATE TABLE cos.review_charters (
  scope_id text PRIMARY KEY REFERENCES cos.scopes(id), owner_id text NOT NULL,
  session_id text NOT NULL, agent_group_id text NOT NULL,
  version integer NOT NULL CHECK(version>0), state text NOT NULL CHECK(state IN ('active','paused')),
  definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object' AND octet_length(definition::text)<=16384),
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'), provenance jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE cos.review_charter_revisions (
  scope_id text NOT NULL REFERENCES cos.scopes(id), version integer NOT NULL CHECK(version>0),
  body jsonb NOT NULL CHECK(jsonb_typeof(body)='object' AND octet_length(body::text)<=24576),
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'), proposal_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,version),
  FOREIGN KEY(scope_id,proposal_id) REFERENCES cos.proposals(scope_id,id)
);
ALTER TABLE cos.review_charters ADD CONSTRAINT review_charter_head_revision
  FOREIGN KEY(scope_id,version) REFERENCES cos.review_charter_revisions(scope_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE cos.strategy_observations (
  scope_id text NOT NULL REFERENCES cos.scopes(id), id uuid NOT NULL, initiative_id text NOT NULL,
  charter_version integer NOT NULL CHECK(charter_version>0),
  body jsonb NOT NULL CHECK(jsonb_typeof(body)='object' AND octet_length(body::text)<=8192),
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  context jsonb NOT NULL CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=4096),
  proposal_id text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,id), FOREIGN KEY(scope_id,initiative_id) REFERENCES cos.records(scope_id,id),
  FOREIGN KEY(scope_id,charter_version) REFERENCES cos.review_charter_revisions(scope_id,version),
  FOREIGN KEY(scope_id,proposal_id) REFERENCES cos.proposals(scope_id,id)
);
CREATE TABLE cos.strategy_review_snapshots (
  scope_id text NOT NULL REFERENCES cos.scopes(id), id text NOT NULL CHECK(id ~ '^review-[a-f0-9]{64}$'),
  revision integer NOT NULL CHECK(revision>0), previous_revision integer,
  charter_version integer NOT NULL CHECK(charter_version>0),
  owner_id text NOT NULL, session_id text NOT NULL, processing_provider text NOT NULL,
  artifact_id text NOT NULL UNIQUE,
  snapshot_digest text NOT NULL CHECK(snapshot_digest ~ '^[a-f0-9]{64}$'),
  context jsonb NOT NULL CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=4096),
  version_refs jsonb NOT NULL CHECK(jsonb_typeof(version_refs)='object' AND octet_length(version_refs::text)<=16384),
  as_of timestamptz NOT NULL, expires_at timestamptz NOT NULL CHECK(expires_at>as_of),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,id,revision),
  CHECK((revision=1 AND previous_revision IS NULL) OR (revision>1 AND previous_revision=revision-1)),
  FOREIGN KEY(scope_id,id,previous_revision) REFERENCES cos.strategy_review_snapshots(scope_id,id,revision),
  FOREIGN KEY(scope_id,charter_version) REFERENCES cos.review_charter_revisions(scope_id,version),
  FOREIGN KEY(scope_id,artifact_id) REFERENCES cos.artifacts(scope_id,id)
);
CREATE TABLE cos.strategy_review_results (
  scope_id text NOT NULL, review_id text NOT NULL, revision integer NOT NULL CHECK(revision>0),
  artifact_id text NOT NULL UNIQUE,
  draft_digest text NOT NULL CHECK(draft_digest ~ '^[a-f0-9]{64}$'),
  output_digest text NOT NULL CHECK(output_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,review_id,revision),
  FOREIGN KEY(scope_id,review_id,revision) REFERENCES cos.strategy_review_snapshots(scope_id,id,revision),
  FOREIGN KEY(scope_id,artifact_id) REFERENCES cos.artifacts(scope_id,id)
);
CREATE TABLE cos.strategy_decisions (
  scope_id text NOT NULL, proposal_id text NOT NULL UNIQUE,
  review_id text NOT NULL, review_revision integer NOT NULL CHECK(review_revision>0), initiative_id text NOT NULL,
  option_id text NOT NULL CHECK(length(option_id) BETWEEN 1 AND 100),
  decision text NOT NULL CHECK(decision IN ('approved','rejected')),
  direction text NOT NULL CHECK(direction IN ('continue','change','pause','stop')),
  rationale text NOT NULL CHECK(length(rationale) BETWEEN 1 AND 500), provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,proposal_id),
  UNIQUE(scope_id,proposal_id,initiative_id),
  FOREIGN KEY(scope_id,proposal_id) REFERENCES cos.proposals(scope_id,id),
  FOREIGN KEY(scope_id,review_id,review_revision) REFERENCES cos.strategy_review_results(scope_id,review_id,revision),
  FOREIGN KEY(scope_id,initiative_id) REFERENCES cos.records(scope_id,id)
);
CREATE TABLE cos.strategy_directions (
  scope_id text NOT NULL, initiative_id text NOT NULL,
  version integer NOT NULL CHECK(version>0), direction text NOT NULL CHECK(direction IN ('continue','change','pause','stop')),
  rationale text NOT NULL CHECK(length(rationale) BETWEEN 1 AND 500), provenance jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,initiative_id),
  FOREIGN KEY(scope_id,initiative_id) REFERENCES cos.records(scope_id,id)
);
CREATE TABLE cos.strategy_direction_revisions (
  scope_id text NOT NULL, initiative_id text NOT NULL, version integer NOT NULL CHECK(version>0),
  expected_record_version integer NOT NULL CHECK(expected_record_version>0), proposal_id text NOT NULL UNIQUE,
  body jsonb NOT NULL CHECK(jsonb_typeof(body)='object' AND octet_length(body::text)<=16384),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id,initiative_id,version),
  FOREIGN KEY(scope_id,initiative_id) REFERENCES cos.records(scope_id,id),
  FOREIGN KEY(scope_id,proposal_id,initiative_id) REFERENCES cos.strategy_decisions(scope_id,proposal_id,initiative_id)
);
ALTER TABLE cos.strategy_directions ADD CONSTRAINT strategy_direction_head_revision
  FOREIGN KEY(scope_id,initiative_id,version) REFERENCES cos.strategy_direction_revisions(scope_id,initiative_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX strategy_observations_by_initiative ON cos.strategy_observations(scope_id,initiative_id,created_at,id);
CREATE INDEX strategy_decisions_by_review ON cos.strategy_decisions(scope_id,review_id,review_revision,created_at,proposal_id);
`;
export const STRATEGY_CHECKSUM = createHash('sha256').update(STRATEGY_SCHEMA).digest('hex');
