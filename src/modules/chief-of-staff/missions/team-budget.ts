import type { PoolClient } from 'pg';

/** Caller holds the root lock. All child revisions share the original step escrow. */
export async function teamStepUsage(client: PoolClient, scopeId: string, teamId: string, stepId: string) {
  const rows = (
    await client.query(
      `SELECT b.kind,count(*)::int AS n FROM cos.mission_budget_reservations b
    JOIN cos.mission_team_children c ON c.scope_id=b.scope_id AND c.mission_id=b.mission_id
    WHERE c.scope_id=$1 AND c.team_id=$2 AND c.step_id=$3 GROUP BY b.kind`,
      [scopeId, teamId, stepId],
    )
  ).rows;
  return {
    attempt: rows.find((r) => r.kind === 'attempt')?.n ?? 0,
    model: rows.find((r) => r.kind === 'model')?.n ?? 0,
    tool: rows.find((r) => r.kind === 'tool')?.n ?? 0,
  };
}
