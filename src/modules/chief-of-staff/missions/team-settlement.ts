import type { PoolClient } from 'pg';
import { digest } from '../domain/contracts.js';
import { teamStepUsage } from './team-budget.js';

/** Parent lock held. Release unused original credits only after every retained child is independently stopped. */
export async function settleTeamCredits(
  client: PoolClient,
  scopeId: string,
  teamId: string,
  generation: number,
  state: 'settled' | 'cancelled',
): Promise<boolean> {
  const pending = await client.query(
    `SELECT 1 FROM cos.mission_team_children c JOIN cos.mission_attempts a ON a.scope_id=c.scope_id AND a.mission_id=c.mission_id
    WHERE c.scope_id=$1 AND c.team_id=$2 AND a.allocation->>'stop_confirmed' IS DISTINCT FROM 'true' LIMIT 1`,
    [scopeId, teamId],
  );
  if (pending.rowCount) return false;
  const reservations = (
    await client.query(
      'SELECT * FROM cos.mission_team_reservations WHERE scope_id=$1 AND team_id=$2 ORDER BY step_id FOR UPDATE',
      [scopeId, teamId],
    )
  ).rows;
  const prepared = [];
  for (const r of reservations) {
    if (r.state === state) continue;
    if (r.state !== 'reserved') return false;
    const usage = await teamStepUsage(client, scopeId, teamId, r.step_id),
      unused = {
        attempt: r.max_attempts - usage.attempt,
        model: r.max_turns - usage.model,
        tool: r.max_tool_calls - usage.tool,
      };
    if (Object.values(unused).some((n) => !Number.isSafeInteger(n) || n < 0)) return false;
    prepared.push({ stepId: r.step_id, usage, unused });
  }
  for (const { stepId, usage, unused } of prepared) {
    const body = {
      generation,
      usage,
      unused,
      confirmed_stopped: true,
      provider_usage: usage.model ? 'uncertain' : 'no_model_calls',
    };
    await client.query(
      "INSERT INTO cos.mission_team_budget_events(scope_id,team_id,step_id,id,kind,body) VALUES($1,$2,$3,$4,'released',$5) ON CONFLICT DO NOTHING",
      [scopeId, teamId, stepId, 'team-release-' + digest({ team: teamId, step: stepId }), JSON.stringify(body)],
    );
    if (usage.model)
      await client.query(
        "INSERT INTO cos.mission_team_budget_events(scope_id,team_id,step_id,id,kind,body) VALUES($1,$2,$3,$4,'uncertain',$5) ON CONFLICT DO NOTHING",
        [
          scopeId,
          teamId,
          stepId,
          'team-uncertain-' + digest({ team: teamId, step: stepId }),
          JSON.stringify({ generation, model_reservations: usage.model, billed_tokens: null }),
        ],
      );
    await client.query(
      "UPDATE cos.mission_team_reservations SET state=$4,usage=$5,updated_at=clock_timestamp() WHERE scope_id=$1 AND team_id=$2 AND step_id=$3 AND state='reserved'",
      [scopeId, teamId, stepId, state, JSON.stringify(body)],
    );
  }
  return true;
}
