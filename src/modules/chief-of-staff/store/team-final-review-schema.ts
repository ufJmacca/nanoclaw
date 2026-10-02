import { createHash } from 'node:crypto';
export const TEAM_FINAL_REVIEW_SCHEMA = `
CREATE TABLE cos.mission_team_calls (
  scope_id text NOT NULL,team_id text NOT NULL,step_id text NOT NULL,call_id text NOT NULL,
  generation integer NOT NULL CHECK(generation>0),kind text NOT NULL CHECK(kind IN ('model','tool')),
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,team_id,call_id),FOREIGN KEY(scope_id,team_id,step_id) REFERENCES cos.mission_team_reservations(scope_id,team_id,step_id)
);
CREATE TABLE cos.mission_team_reviews (
  scope_id text NOT NULL,id text NOT NULL,team_id text NOT NULL,generation integer NOT NULL CHECK(generation>0),
  submission_id text NOT NULL,result_digest text NOT NULL CHECK(result_digest ~ '^[a-f0-9]{64}$'),
  decision text NOT NULL CHECK(decision IN ('accept','partial','reject')),checks jsonb NOT NULL,provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,id),UNIQUE(scope_id,team_id,generation,result_digest),
  FOREIGN KEY(scope_id,team_id) REFERENCES cos.mission_team_roots(scope_id,id),
  FOREIGN KEY(scope_id,submission_id) REFERENCES cos.mission_result_submissions(scope_id,id)
);
ALTER TABLE cos.outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE cos.outbox ADD CONSTRAINT outbox_kind_check
  CHECK(kind IN ('approval_preview','proposal_apply','rpc_response','knowledge_invalidate','knowledge_purge','mission_review_notification','team_review_notification'));
`;
export const TEAM_FINAL_REVIEW_CHECKSUM = createHash('sha256').update(TEAM_FINAL_REVIEW_SCHEMA).digest('hex');
