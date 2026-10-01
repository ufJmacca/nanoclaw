import { createHash } from 'node:crypto';

export const WORK_SCHEMA = `
ALTER TABLE cos.proposals ADD COLUMN work_context jsonb;
CREATE TABLE cos.work_items (
  scope_id text NOT NULL REFERENCES cos.scopes(id), id uuid NOT NULL,
  owner_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('commitment','decision')),
  state text NOT NULL,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  description text NOT NULL CHECK(length(description)<=8000),
  project_id text, due jsonb, defer_until timestamptz,
  evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='array' AND jsonb_array_length(evidence)<=10),
  evidence_context jsonb,
  version integer NOT NULL CHECK(version>0), provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,id),
  FOREIGN KEY(scope_id,project_id) REFERENCES cos.records(scope_id,id),
  CHECK((kind='commitment' AND state IN ('confirmed','completed','deferred','dismissed'))
    OR (kind='decision' AND state IN ('needed','decided','deferred','dismissed'))),
  CHECK((state='deferred')=(defer_until IS NOT NULL))
);
CREATE TABLE cos.work_revisions (
  scope_id text NOT NULL, work_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
  body jsonb NOT NULL, proposal_id text NOT NULL UNIQUE REFERENCES cos.proposals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,work_id,version),
  FOREIGN KEY(scope_id,work_id) REFERENCES cos.work_items(scope_id,id)
);
CREATE INDEX work_open_by_scope ON cos.work_items(scope_id,kind,state,id);
`;
export const WORK_CHECKSUM = createHash('sha256').update(WORK_SCHEMA).digest('hex');
