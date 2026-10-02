import type { PoolClient } from 'pg';
import { digest } from '../domain/contracts.js';
import { validTeamRequest, type TeamRequest } from '../contracts/team-protocol.js';
type BudgetClient = Pick<PoolClient, 'query'>;

export type TeamCredits = { attempt: number; model: number; tool: number };
const dimensions = ['attempt', 'model', 'tool'] as const;
export function teamParentLimits(request: TeamRequest): TeamCredits {
  return {
    attempt:
      request.limits.max_attempts - request.steps.reduce((n, s) => n + s.limits.max_attempts + s.max_rework_count, 0),
    model: request.limits.max_turns - request.steps.reduce((n, s) => n + s.limits.max_turns, 0),
    tool: request.limits.max_tool_calls - request.steps.reduce((n, s) => n + s.limits.max_tool_calls, 0),
  };
}

/** Parent lock held. A single audit includes all retained children, retries, rework and coordinator calls. */
export async function teamBudget(client: BudgetClient, scopeId: string, teamId: string) {
  const order = (
    await client.query('SELECT body,digest FROM cos.mission_team_work_orders WHERE scope_id=$1 AND id=$2', [
      scopeId,
      teamId,
    ])
  ).rows[0];
  if (
    !order ||
    order.body.format !== 'cos-team-work-order/v1' ||
    order.body.teamId !== teamId ||
    digest(order.body) !== order.digest ||
    !validTeamRequest(order.body.request)
  )
    return null;
  const request: TeamRequest = order.body.request,
    parentLimits = teamParentLimits(request);
  const parent = (
    await client.query('SELECT * FROM cos.mission_team_root_reservations WHERE scope_id=$1 AND team_id=$2', [
      scopeId,
      teamId,
    ])
  ).rows[0];
  if (
    !parent ||
    parent.max_attempts !== parentLimits.attempt ||
    parent.max_turns !== parentLimits.model ||
    parent.max_tool_calls !== parentLimits.tool
  )
    return null;
  const parentCalls = (
    await client.query(
      'SELECT kind,count(*)::int AS n FROM cos.mission_team_calls WHERE scope_id=$1 AND team_id=$2 AND step_id IS NULL GROUP BY kind',
      [scopeId, teamId],
    )
  ).rows;
  const parentUsage: TeamCredits = {
    attempt: 0,
    model: parentCalls.find((r) => r.kind === 'model')?.n ?? 0,
    tool: parentCalls.find((r) => r.kind === 'tool')?.n ?? 0,
  };
  if (dimensions.some((k) => parentUsage[k] > parentLimits[k])) return null;
  const rows = (
    await client.query(
      'SELECT * FROM cos.mission_team_reservations WHERE scope_id=$1 AND team_id=$2 ORDER BY step_id',
      [scopeId, teamId],
    )
  ).rows;
  if (rows.length !== request.steps.length) return null;
  const steps = [];
  const usage = { ...parentUsage };
  for (const row of rows) {
    const step = request.steps.find((s) => s.step_id === row.step_id);
    if (!step) return null;
    const limits: TeamCredits = {
      attempt: step.limits.max_attempts + step.max_rework_count,
      model: step.limits.max_turns,
      tool: step.limits.max_tool_calls,
    };
    if (row.max_attempts !== limits.attempt || row.max_turns !== limits.model || row.max_tool_calls !== limits.tool)
      return null;
    const used = await teamStepUsage(client, scopeId, teamId, row.step_id);
    if (dimensions.some((k) => used[k] > limits[k])) return null;
    for (const k of dimensions) usage[k] += used[k];
    steps.push({ step_id: row.step_id, limits, usage: used, state: row.state as string });
  }
  const limits: TeamCredits = {
    attempt: request.limits.max_attempts,
    model: request.limits.max_turns,
    tool: request.limits.max_tool_calls,
  };
  if (dimensions.some((k) => usage[k] > limits[k])) return null;
  return { limits, usage, parent: { limits: parentLimits, usage: parentUsage, state: parent.state as string }, steps };
}

/** Caller holds the root lock. All child revisions share the original step escrow. */
export async function teamStepUsage(client: BudgetClient, scopeId: string, teamId: string, stepId: string) {
  const rows = (
    await client.query(
      `SELECT kind,count(*)::int AS n FROM (SELECT b.kind FROM cos.mission_budget_reservations b
    JOIN cos.mission_team_children c ON c.scope_id=b.scope_id AND c.mission_id=b.mission_id
    WHERE c.scope_id=$1 AND c.team_id=$2 AND c.step_id=$3
    UNION ALL SELECT kind FROM cos.mission_team_calls WHERE scope_id=$1 AND team_id=$2 AND step_id=$3) usage GROUP BY kind`,
      [scopeId, teamId, stepId],
    )
  ).rows;
  return {
    attempt: rows.find((r) => r.kind === 'attempt')?.n ?? 0,
    model: rows.find((r) => r.kind === 'model')?.n ?? 0,
    tool: rows.find((r) => r.kind === 'tool')?.n ?? 0,
  };
}
