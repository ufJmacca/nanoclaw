import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Context, Result } from '../domain/contracts.js';
import type { ScheduleChange } from '../contracts/schedule-protocol.js';
/** Schedule authority is created only inside the durable owner-approved proposal transaction. */
export class BriefScheduleStore {
  async applyApproved(
    client: PoolClient,
    context: Context,
    proposal: { id: string; decision_ingress_id: string },
    change: ScheduleChange,
  ): Promise<Result> {
    if (
      change.policy.snooze_until &&
      !(await client.query('SELECT $1::timestamptz>clock_timestamp() AS valid', [change.policy.snooze_until])).rows[0]
        .valid
    )
      return { status: 'conflict' };
    const id = change.record_id ?? randomUUID();
    const provenance = {
      proposal_id: proposal.id,
      owner_id: context.ownerId,
      ingress_id: proposal.decision_ingress_id,
      reason: change.reason,
    };
    const values = [
      context.scopeId,
      id,
      context.ownerId,
      context.sessionId,
      context.agentGroupId,
      change.title,
      JSON.stringify(change.policy),
      JSON.stringify(change.limits),
      JSON.stringify(provenance),
    ];
    const changed = change.record_id
      ? await client.query(
          `UPDATE cos.brief_schedules SET title=$6,policy=$7,limits=$8,provenance=$9,version=version+1,activated_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE scope_id=$1 AND id::text=$2 AND owner_id=$3 AND session_id=$4 AND agent_group_id=$5 AND version=$10 RETURNING *`,
          [...values, change.expected_version],
        )
      : await client.query(
          `INSERT INTO cos.brief_schedules(scope_id,id,owner_id,session_id,agent_group_id,title,policy,limits,provenance,version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1) ON CONFLICT DO NOTHING RETURNING *`,
          values,
        );
    if (changed.rowCount !== 1) return { status: 'conflict' };
    await client.query(
      'INSERT INTO cos.brief_schedule_revisions(scope_id,schedule_id,version,body,proposal_id) VALUES($1,$2,$3,$4,$5)',
      [context.scopeId, id, changed.rows[0].version, JSON.stringify(changed.rows[0]), proposal.id],
    );
    return { status: 'ok', record_id: id };
  }
  async read(client: PoolClient, context: Context): Promise<unknown[]> {
    return (
      await client.query(
        'SELECT id,title,version,policy,limits,activated_at,last_local_date::text FROM cos.brief_schedules WHERE scope_id=$1 AND owner_id=$2 AND session_id=$3 AND agent_group_id=$4 LIMIT 1',
        [context.scopeId, context.ownerId, context.sessionId, context.agentGroupId],
      )
    ).rows;
  }
}
