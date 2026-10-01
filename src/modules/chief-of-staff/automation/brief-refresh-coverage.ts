import type { PoolClient } from 'pg';
import type { KnowledgeContext } from '../knowledge/store.js';
import type { BriefCoverage } from './brief-snapshot.js';
import type { BriefRefreshPlan } from './brief-refresh.js';

/** Read host-owned refresh provenance; worker input cannot supply a coverage outcome. */
export async function briefRefreshCoverage(
  client: PoolClient,
  context: KnowledgeContext,
  timeZone: string,
  publication = false,
): Promise<{ refresh: BriefCoverage['refresh']; truncated: boolean } | null> {
  if (!context.origin) return { refresh: 'not_requested', truncated: false };
  const run = (
    await client.query(
      `SELECT r.limits,r.provenance FROM cos.brief_runs r
      JOIN cos.brief_schedules s ON s.scope_id=r.scope_id AND s.id=r.schedule_id AND s.version=r.schedule_version
      WHERE r.scope_id=$1 AND r.id=$2 AND r.generation=$3 AND r.owner_id=$4 AND r.session_id=$5 AND r.agent_group_id=$6
      AND (r.state='dispatched' OR ($8::boolean AND r.state='prepared'))
      AND r.deadline_at>clock_timestamp() AND r.lease_until>clock_timestamp()
      AND s.policy->>'state'='active' AND s.policy->>'time_zone'=$7`,
      [
        context.scopeId,
        context.origin.runId,
        context.origin.generation,
        context.ownerId,
        context.sessionId,
        context.agentGroupId,
        timeZone,
        publication,
      ],
    )
  ).rows[0];
  if (!run) return null;
  const plan = run.provenance.refresh as BriefRefreshPlan | undefined;
  // Existing zero-refresh reservations have no provider work to reconcile.
  if (!plan) return run.limits.refresh_seconds === 0 ? { refresh: 'not_requested', truncated: false } : null;
  if (
    plan.version !== 1 ||
    plan.provider !== context.provider ||
    plan.generation !== context.origin.generation ||
    !['not_requested', 'complete', 'failed', 'timed_out'].includes(plan.state) ||
    typeof plan.truncated !== 'boolean'
  )
    return null;
  return { refresh: plan.state as BriefCoverage['refresh'], truncated: plan.truncated };
}
