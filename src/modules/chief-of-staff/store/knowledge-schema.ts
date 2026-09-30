import { createHash } from 'node:crypto';

export const KNOWLEDGE_SCHEMA = `
CREATE TABLE cos.artifacts (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES cos.scopes(id),
  kind text NOT NULL CHECK(kind IN ('source','answer','summary')),
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  byte_length integer NOT NULL CHECK(byte_length BETWEEN 0 AND 1048576),
  lifecycle text NOT NULL CHECK(lifecycle IN ('published','quarantined','deleted')),
  version integer NOT NULL DEFAULT 1 CHECK(version > 0), provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(scope_id,id)
);
CREATE TABLE cos.sources (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES cos.scopes(id),
  source_key text NOT NULL CHECK(length(source_key) BETWEEN 1 AND 160),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  project_id text, current_revision_id text,
  status text NOT NULL CHECK(status IN ('admitted','indexing','current','stale','revoked','failed','unsupported')),
  processing_providers text[] NOT NULL, access_policy jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0), provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(scope_id,id), UNIQUE(scope_id,source_key),
  FOREIGN KEY(scope_id,project_id) REFERENCES cos.records(scope_id,id)
);
CREATE TABLE cos.source_revisions (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES cos.scopes(id), source_id text NOT NULL,
  artifact_id text NOT NULL, digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  version integer NOT NULL CHECK(version > 0), supersedes text,
  locator_format text NOT NULL CHECK(locator_format='normalized-utf8-lines/v1'),
  provenance jsonb NOT NULL, captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(scope_id,id), UNIQUE(scope_id,source_id,version), UNIQUE(scope_id,source_id,id),
  FOREIGN KEY(scope_id,source_id) REFERENCES cos.sources(scope_id,id),
  FOREIGN KEY(scope_id,artifact_id) REFERENCES cos.artifacts(scope_id,id),
  FOREIGN KEY(scope_id,source_id,supersedes) REFERENCES cos.source_revisions(scope_id,source_id,id)
);
ALTER TABLE cos.sources ADD CONSTRAINT current_source_revision
  FOREIGN KEY(scope_id,id,current_revision_id) REFERENCES cos.source_revisions(scope_id,source_id,id);
CREATE TABLE cos.chunks (
  scope_id text NOT NULL, revision_id text NOT NULL, ordinal integer NOT NULL CHECK(ordinal >= 0),
  start_line integer NOT NULL CHECK(start_line > 0), end_line integer NOT NULL CHECK(end_line >= start_line),
  heading text NOT NULL CHECK(length(heading) <= 200), text text NOT NULL CHECK(length(text) <= 2000),
  search tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,revision_id,ordinal),
  UNIQUE(scope_id,revision_id,start_line,end_line),
  FOREIGN KEY(scope_id,revision_id) REFERENCES cos.source_revisions(scope_id,id)
);
CREATE INDEX knowledge_full_text ON cos.chunks USING gin(search);
CREATE TABLE cos.evidence_refs (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES cos.scopes(id),
  source_id text NOT NULL, revision_id text NOT NULL, revision_digest text NOT NULL,
  source_version integer NOT NULL CHECK(source_version > 0),
  start_line integer NOT NULL CHECK(start_line > 0), end_line integer NOT NULL CHECK(end_line >= start_line),
  session_id text NOT NULL, context_generation text NOT NULL, processing_provider text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(scope_id,id),
  UNIQUE(scope_id,session_id,context_generation,revision_id,start_line,end_line,source_version),
  FOREIGN KEY(scope_id,source_id,revision_id) REFERENCES cos.source_revisions(scope_id,source_id,id)
);
CREATE TABLE cos.derivation_links (
  scope_id text NOT NULL, artifact_id text NOT NULL, evidence_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,artifact_id,evidence_id),
  FOREIGN KEY(scope_id,artifact_id) REFERENCES cos.artifacts(scope_id,id),
  FOREIGN KEY(scope_id,evidence_id) REFERENCES cos.evidence_refs(scope_id,id)
);
CREATE TABLE cos.revocation_tombstones (
  scope_id text NOT NULL, source_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('revoke','delete')),
  version integer NOT NULL CHECK(version > 0), provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), purge_after timestamptz,
  PRIMARY KEY(scope_id,source_id), FOREIGN KEY(scope_id,source_id) REFERENCES cos.sources(scope_id,id)
);
ALTER TABLE cos.outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE cos.outbox ADD CONSTRAINT outbox_kind_check
  CHECK(kind IN ('approval_preview','proposal_apply','rpc_response','knowledge_invalidate','knowledge_purge'));
`;
export const KNOWLEDGE_CHECKSUM = createHash('sha256').update(KNOWLEDGE_SCHEMA).digest('hex');
