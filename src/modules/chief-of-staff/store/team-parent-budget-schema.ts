import { createHash } from 'node:crypto';

/** Unallocated original root credits are distinct from every step escrow. Applied versions 1–12 stay unchanged. */
export const TEAM_PARENT_BUDGET_SCHEMA = `
CREATE TABLE cos.mission_team_root_reservations (
  scope_id text NOT NULL,team_id text NOT NULL,
  max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 0 AND 12),
  max_turns integer NOT NULL CHECK(max_turns BETWEEN 0 AND 24),
  max_tool_calls integer NOT NULL CHECK(max_tool_calls BETWEEN 0 AND 128),
  state text NOT NULL CHECK(state IN ('reserved','settled','cancelled')),usage jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,team_id),FOREIGN KEY(scope_id,team_id) REFERENCES cos.mission_team_roots(scope_id,id)
);
CREATE TABLE cos.mission_team_root_budget_events (
  scope_id text NOT NULL,team_id text NOT NULL,id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('reserved','released','uncertain')),body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,id),UNIQUE(scope_id,team_id,kind),
  FOREIGN KEY(scope_id,team_id) REFERENCES cos.mission_team_root_reservations(scope_id,team_id)
);
ALTER TABLE cos.mission_team_calls ALTER COLUMN step_id DROP NOT NULL;
ALTER TABLE cos.mission_team_calls ADD FOREIGN KEY(scope_id,team_id) REFERENCES cos.mission_team_roots(scope_id,id);

-- No pre-v13 call could use parent slack. Retain already-approved caps rather than creating fresh budgets.
INSERT INTO cos.mission_team_root_reservations(scope_id,team_id,max_attempts,max_turns,max_tool_calls,state)
SELECT r.scope_id,r.id,
  (w.body->'request'->'limits'->>'max_attempts')::int - a.attempts,
  (w.body->'request'->'limits'->>'max_turns')::int - a.turns,
  (w.body->'request'->'limits'->>'max_tool_calls')::int - a.tools,
  CASE WHEN r.state IN ('completed','partial','blocked','failed','cancelled')
    AND NOT EXISTS(SELECT 1 FROM cos.mission_team_reservations s WHERE s.scope_id=r.scope_id AND s.team_id=r.id AND s.state='reserved')
    AND NOT EXISTS(SELECT 1 FROM cos.mission_team_children c JOIN cos.mission_attempts t ON t.scope_id=c.scope_id AND t.mission_id=c.mission_id
      WHERE c.scope_id=r.scope_id AND c.team_id=r.id AND t.allocation->>'stop_confirmed' IS DISTINCT FROM 'true')
    THEN CASE WHEN r.state='cancelled' THEN 'cancelled' ELSE 'settled' END ELSE 'reserved' END
FROM cos.mission_team_roots r JOIN cos.mission_team_work_orders w ON w.scope_id=r.scope_id AND w.id=r.id
JOIN LATERAL(SELECT sum(s.max_attempts)::int AS attempts,sum(s.max_turns)::int AS turns,sum(s.max_tool_calls)::int AS tools
  FROM cos.mission_team_reservations s WHERE s.scope_id=r.scope_id AND s.team_id=r.id) a ON a.attempts IS NOT NULL
WHERE r.generation>0;
INSERT INTO cos.mission_team_root_budget_events(scope_id,team_id,id,kind,body)
SELECT p.scope_id,p.team_id,'team-parent-reserve-'||p.team_id,'reserved',
  jsonb_build_object('limits',jsonb_build_object('attempt',p.max_attempts,'model',p.max_turns,'tool',p.max_tool_calls),
    'work_order_digest',w.digest,'backfilled',true)
FROM cos.mission_team_root_reservations p JOIN cos.mission_team_work_orders w ON w.scope_id=p.scope_id AND w.id=p.team_id;
INSERT INTO cos.mission_team_root_budget_events(scope_id,team_id,id,kind,body)
SELECT p.scope_id,p.team_id,'team-parent-release-'||p.team_id,'released',
  jsonb_build_object('usage',jsonb_build_object('attempt',0,'model',0,'tool',0),
    'unused',jsonb_build_object('attempt',p.max_attempts,'model',p.max_turns,'tool',p.max_tool_calls),
    'confirmed_stopped',true,'provider_usage','no_model_calls','backfilled',true)
FROM cos.mission_team_root_reservations p WHERE p.state<>'reserved';
UPDATE cos.mission_team_root_reservations p SET usage=e.body FROM cos.mission_team_root_budget_events e
WHERE e.scope_id=p.scope_id AND e.team_id=p.team_id AND e.kind='released';
`;
export const TEAM_PARENT_BUDGET_CHECKSUM = createHash('sha256').update(TEAM_PARENT_BUDGET_SCHEMA).digest('hex');
