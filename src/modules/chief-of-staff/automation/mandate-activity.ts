import type { PoolClient } from 'pg';
import type { Context, Result } from '../domain/contracts.js';
import type { MandateRevisionBody } from './mandate-store.js';

/** Metadata and accounting only. The existing checked mission-result reader owns source-derived prose. */
export async function readMandateActivity(
  client: PoolClient,
  context: Context,
  head: { id: string; version: number; state: string; body: MandateRevisionBody; suspension_reason?: string | null },
  readable: boolean,
  offset: number,
): Promise<Result> {
  const parameters = [context.scopeId, head.id];
  const usage = (
    await client.query(
      `SELECT r.kind,count(*)::int AS n FROM cos.mission_budget_reservations r JOIN cos.mandate_missions l ON l.scope_id=r.scope_id AND l.mission_id=r.mission_id WHERE l.scope_id=$1 AND l.mandate_id=$2 GROUP BY r.kind`,
      parameters,
    )
  ).rows;
  const reservations = (
    await client.query(
      'SELECT budget,state,used FROM cos.mandate_reservations WHERE scope_id=$1 AND mandate_id=$2',
      parameters,
    )
  ).rows;
  const work = (
    await client.query(
      `SELECT m.id,m.state,m.generation,m.version,l.revision,l.occurrence_key,s.id AS submission_id,r.id AS review_id,r.decision AS review_decision
    FROM cos.mandate_missions l JOIN cos.missions m ON m.scope_id=l.scope_id AND m.id=l.mission_id
    LEFT JOIN LATERAL (SELECT id FROM cos.mission_result_submissions WHERE scope_id=m.scope_id AND mission_id=m.id ORDER BY created_at DESC LIMIT 1) s ON true
    LEFT JOIN cos.mission_reviews r ON r.scope_id=m.scope_id AND r.mission_id=m.id AND r.result_id=s.id
    WHERE l.scope_id=$1 AND l.mandate_id=$2 ORDER BY l.created_at DESC,l.mission_id LIMIT 5`,
      parameters,
    )
  ).rows;
  const activity = (
    await client.query(
      'SELECT id,revision,body,created_at FROM cos.mandate_activity WHERE scope_id=$1 AND mandate_id=$2 ORDER BY created_at DESC,id LIMIT 6 OFFSET $3',
      [...parameters, offset],
    )
  ).rows;
  const exposures = readable
    ? (
        await client.query(
          `SELECT DISTINCT e.source_id,e.revision_id FROM cos.evidence_refs e JOIN cos.mission_attempts a ON a.scope_id=e.scope_id AND a.session_id=e.session_id AND a.id::text=e.context_generation JOIN cos.mandate_missions l ON l.scope_id=a.scope_id AND l.mission_id=a.mission_id WHERE l.scope_id=$1 AND l.mandate_id=$2 ORDER BY e.source_id,e.revision_id LIMIT 31`,
          parameters,
        )
      ).rows
    : [];
  const count = (kind: string) => Number(usage.find((r) => r.kind === kind)?.n ?? 0);
  const definitions = head.body.definition;
  const dimensions = ['max_missions', 'max_attempts', 'max_turns', 'max_tool_calls', 'wall_seconds'] as const;
  const reserved = Object.fromEntries(
    dimensions.map((key) => [key, reservations.reduce((total, row) => total + Number(row.budget[key]), 0)]),
  );
  return {
    status: 'ok',
    format: 'cos-mandate-activity/v1',
    mandate: {
      id: head.id,
      version: head.version,
      state: head.state,
      definition: definitions,
      suspension_reason: head.suspension_reason ?? null,
    },
    work: work.map((row) =>
      readable
        ? row
        : { id: row.id, state: row.state, generation: row.generation, revision: row.revision, details_withheld: true },
    ),
    activity: activity
      .slice(0, 5)
      .map((row) => ({
        id: row.id,
        revision: row.revision,
        created_at: row.created_at,
        body: Object.fromEntries(
          ['kind', 'action', 'reason', 'state', 'decision', 'model_calls', 'notifications', 'decisions_needed']
            .filter((k) => Object.hasOwn(row.body, k))
            .map((k) => [k, row.body[k]]),
        ),
      })),
    next_offset: activity.length > 5 ? offset + 5 : null,
    context_exposures: exposures.slice(0, 30),
    exposure_truncated: exposures.length > 30,
    source_details_withheld: !readable,
    accounting: {
      attempt_reservations: count('attempt'),
      model_turn_reservations: count('model'),
      tool_call_reservations: count('tool'),
      reserved_envelopes: reservations.length,
      reserved_limits: reserved,
      limits: definitions.budget,
      uncertain_envelopes: reservations.filter((r) => r.state === 'unknown').length,
      currency_estimate: null,
      monetary_usage: 'not_reported_by_subscription',
      hard_dollar_cap: false,
    },
    decisions_needed:
      head.state === 'suspended'
        ? [
            head.suspension_reason === 'unknown_usage'
              ? 'trusted_usage_reconciliation_then_owner_review'
              : 'owner_review_and_resume_or_revoke',
          ]
        : head.state === 'expired'
          ? ['owner_approved_renewal']
          : head.state === 'paused'
            ? ['owner_resume_or_revoke']
            : [],
  };
}
