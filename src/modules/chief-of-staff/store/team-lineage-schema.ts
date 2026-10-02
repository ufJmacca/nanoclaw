import { createHash } from 'node:crypto';

/** Retain every immutable child revision; mutable step pointers never define the whole family. */
export const TEAM_LINEAGE_SCHEMA = `
CREATE TABLE cos.mission_team_children (
  scope_id text NOT NULL,team_id text NOT NULL,step_id text NOT NULL,mission_id text NOT NULL,
  root_generation integer NOT NULL CHECK(root_generation>0),revision integer NOT NULL CHECK(revision BETWEEN 0 AND 2),
  reason jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,mission_id),UNIQUE(scope_id,team_id,step_id,revision),
  FOREIGN KEY(scope_id,team_id,step_id) REFERENCES cos.mission_team_steps(scope_id,team_id,step_id),
  FOREIGN KEY(scope_id,mission_id) REFERENCES cos.missions(scope_id,id)
);
INSERT INTO cos.mission_team_children(scope_id,team_id,step_id,mission_id,root_generation,revision,reason)
  SELECT s.scope_id,s.team_id,s.step_id,s.child_mission_id,(w.body->'team'->>'generation')::integer,0,'{"kind":"initial"}'::jsonb
  FROM cos.mission_team_steps s JOIN cos.mission_work_orders w ON w.scope_id=s.scope_id AND w.id=s.child_mission_id;
CREATE TABLE cos.mission_team_reworks (
  scope_id text NOT NULL,team_id text NOT NULL,id text NOT NULL,review_mission_id text NOT NULL,review_submission_id text NOT NULL,
  body jsonb NOT NULL,digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,id),UNIQUE(scope_id,team_id,review_submission_id),
  FOREIGN KEY(scope_id,team_id) REFERENCES cos.mission_team_roots(scope_id,id),
  FOREIGN KEY(scope_id,review_mission_id,review_submission_id) REFERENCES cos.mission_result_submissions(scope_id,mission_id,id)
);
`;
export const TEAM_LINEAGE_CHECKSUM = createHash('sha256').update(TEAM_LINEAGE_SCHEMA).digest('hex');
