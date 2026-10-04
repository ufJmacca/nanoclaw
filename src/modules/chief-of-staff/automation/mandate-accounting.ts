import type { PoolClient } from 'pg';
import type { CosMissionIdentity } from '../../../cos-mission-boundary.js';

/** Called only by the trusted host's failure transaction. Model text cannot report or clear usage. */
export async function recordMandateUncertainUsage(
  client: PoolClient,
  identity: CosMissionIdentity,
  reason: string,
): Promise<void> {
  const charged = (
    await client.query(
      "SELECT count(*)::int AS n FROM cos.mission_budget_reservations WHERE scope_id=$1 AND mission_id=$2 AND kind='model'",
      [identity.scopeId, identity.missionId],
    )
  ).rows[0].n;
  if (!charged) return;
  const changed = await client.query(
    `UPDATE cos.mandate_reservations r SET state='unknown',used=$3::jsonb,updated_at=clock_timestamp()
     FROM cos.mandate_missions l WHERE l.scope_id=$1 AND l.mission_id=$2 AND r.scope_id=l.scope_id AND r.occurrence_key=l.occurrence_key`,
    [
      identity.scopeId,
      identity.missionId,
      JSON.stringify({
        accounting: 'host_reserved_structural/v1',
        model_turn_reservations: charged,
        exact_provider_usage: 'unknown',
        currency_estimate: null,
        monetary_usage: 'not_reported_by_subscription',
        reason,
      }),
    ],
  );
  if (changed.rowCount !== 1) throw Error('mandate_usage_receipt_missing');
}
