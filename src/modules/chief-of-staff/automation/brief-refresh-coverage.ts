import type { PoolClient } from 'pg';
import type { KnowledgeContext } from '../knowledge/store.js';
import type { BriefCoverage } from './brief-snapshot.js';
import type { BriefRefreshPlan } from './brief-refresh.js';
import type { MailReviewAccess } from './mail-review-access.js';
import { digest } from '../domain/contracts.js';

/** Read host-owned refresh provenance; worker input cannot supply a coverage outcome. */
export async function briefRefreshCoverage(
  client: PoolClient,
  context: KnowledgeContext,
  timeZone: string,
  publication = false,
  preparedArtifactId?: string,
  reviewAccess?: Pick<MailReviewAccess, 'check'>,
): Promise<{ refresh: BriefCoverage['refresh']; truncated: boolean } | null> {
  if (!context.origin) return { refresh: 'not_requested', truncated: false };
  const run = (
    await client.query(
      `SELECT r.limits,r.provenance,r.review_inputs,s.purpose FROM cos.brief_runs r
      JOIN cos.brief_schedules s ON s.scope_id=r.scope_id AND s.id=r.schedule_id AND s.version=r.schedule_version
      WHERE r.scope_id=$1 AND r.id=$2 AND r.generation=$3 AND r.owner_id=$4 AND r.session_id=$5 AND r.agent_group_id=$6
      AND (r.state='dispatched' OR (r.state='prepared' AND
        ($8::boolean OR ($9::text IS NOT NULL AND r.snapshot->>'artifact_id'=$9))))
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
        preparedArtifactId ?? null,
      ],
    )
  ).rows[0];
  if (!run) return null;
  if (run.purpose === 'mail_review') {
    if (timeZone !== 'Australia/Sydney' || !reviewAccess) return null;
    const selected = await reviewAccess.check(client, context, 'read');
    return selected && digest(selected.inputs) === digest(run.review_inputs)
      ? { refresh: 'not_requested', truncated: selected.inputs.unexamined_threads > 0 }
      : null;
  }
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
