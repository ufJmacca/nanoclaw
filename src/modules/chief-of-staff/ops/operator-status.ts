import type { PoolClient } from 'pg';
import type { Context, Result } from '../domain/contracts.js';
import { BoundedDatabase, DatabaseUnavailable } from '../store/client.js';
import {
  STATUS_CATEGORIES,
  validStatusInput,
  type StatusInput,
  type StatusCategory,
} from '../contracts/operations-protocol.js';

/** Fixed projections deliberately exclude titles, source prose, raw receipts and approval challenges. */
const projections: Record<StatusCategory, string> = {
  priorities: `SELECT id,lifecycle AS state,version,id AS purpose_id,kind AS purpose_kind,NULL::text AS authority_id,NULL::jsonb AS limits FROM cos.records WHERE scope_id=$1`,
  work: `SELECT id::text,state,version,project_id AS purpose_id,'project' AS purpose_kind,provenance->>'proposal_id' AS authority_id,NULL::jsonb AS limits FROM cos.work_items WHERE scope_id=$1 AND owner_id=$2`,
  proposals: `SELECT id,CASE WHEN state='pending' AND expires_at<=clock_timestamp() THEN 'expired' ELSE state END AS state,version,COALESCE(change->>'project_id',change->>'record_id') AS purpose_id,'priority' AS purpose_kind,id AS authority_id,NULL::jsonb AS limits FROM cos.proposals WHERE scope_id=$1 AND owner_id=$2 AND session_id=$3`,
  missions: `SELECT m.id,m.state,m.version,COALESCE(w.body->'related'->'goal'->>'id',w.body->'related'->'project'->>'id') AS purpose_id,'priority' AS purpose_kind,m.proposal_id AS authority_id,w.body->'request'->'limits' AS limits FROM cos.missions m JOIN cos.mission_work_orders w USING(scope_id,id) WHERE m.scope_id=$1`,
  attempts: `SELECT a.id,a.state,a.version,a.mission_id AS purpose_id,'mission' AS purpose_kind,m.proposal_id AS authority_id,NULL::jsonb AS limits FROM cos.mission_attempts a JOIN cos.missions m ON m.scope_id=a.scope_id AND m.id=a.mission_id WHERE a.scope_id=$1`,
  teams: `SELECT m.id,m.state,m.version,COALESCE(w.body->'request'->>'goal_id',w.body->'request'->>'project_id') AS purpose_id,'priority' AS purpose_kind,m.proposal_id AS authority_id,w.body->'request'->'limits' AS limits FROM cos.mission_team_roots m JOIN cos.mission_team_work_orders w USING(scope_id,id) WHERE m.scope_id=$1`,
  mandates: `SELECT m.id,m.state,m.version,COALESCE(r.body->'definition'->>'goal_id',r.body->'definition'->>'project_id') AS purpose_id,'priority' AS purpose_kind,r.proposal_id AS authority_id,r.body->'definition'->'limits' AS limits FROM cos.mandates m JOIN cos.mandate_revisions r ON r.scope_id=m.scope_id AND r.mandate_id=m.id AND r.version=m.version WHERE m.scope_id=$1 AND m.owner_id=$2 AND m.session_id=$3`,
  actions: `SELECT a.id,a.state,i.body->>'project_id' AS purpose_id,'project' AS purpose_kind,i.proposal_id AS authority_id,NULL::jsonb AS limits FROM cos.actions a JOIN cos.action_intents i USING(scope_id,id) WHERE a.scope_id=$1`,
  action_receipts: `SELECT id::text,kind AS state,action_id AS purpose_id,'action' AS purpose_kind,action_id AS authority_id,NULL::jsonb AS limits FROM cos.action_receipts WHERE scope_id=$1`,
  operations: `SELECT request_id AS id,COALESCE(result->>'status','pending') AS state,NULL::text AS purpose_id,'scope' AS purpose_kind,NULL::text AS authority_id,NULL::jsonb AS limits FROM cos.operations WHERE scope_id=$1 AND session_id=$3`,
  sources: `SELECT id,status AS state,version,project_id AS purpose_id,'project' AS purpose_kind,NULL::text AS authority_id,NULL::jsonb AS limits FROM cos.sources WHERE scope_id=$1`,
  schedules: `SELECT id::text,policy->>'state' AS state,version,NULL::text AS purpose_id,'scope' AS purpose_kind,(SELECT proposal_id FROM cos.brief_schedule_revisions r WHERE r.scope_id=s.scope_id AND r.schedule_id=s.id AND r.version=s.version) AS authority_id,limits FROM cos.brief_schedules s WHERE scope_id=$1 AND owner_id=$2 AND session_id=$3`,
  reviews: `SELECT s.id||':'||s.revision::text AS id,CASE WHEN r.review_id IS NOT NULL THEN 'reviewed' WHEN s.expires_at<=clock_timestamp() THEN 'expired' ELSE 'collected' END AS state,s.revision AS version,NULL::text AS purpose_id,'scope' AS purpose_kind,(SELECT proposal_id FROM cos.review_charter_revisions c WHERE c.scope_id=s.scope_id AND c.version=s.charter_version) AS authority_id,NULL::jsonb AS limits FROM cos.strategy_review_snapshots s LEFT JOIN cos.strategy_review_results r ON r.scope_id=s.scope_id AND r.review_id=s.id AND r.revision=s.revision WHERE s.scope_id=$1 AND s.owner_id=$2 AND s.session_id=$3`,
  outbox: `SELECT id,CASE WHEN delivered_at IS NOT NULL THEN 'delivered' WHEN attempts>0 THEN 'pending_retry' ELSE 'pending' END AS state,NULL::text AS purpose_id,'scope' AS purpose_kind,NULL::text AS authority_id,NULL::jsonb AS limits FROM cos.outbox WHERE scope_id=$1`,
};
const names: Record<StatusCategory, string> = {
  priorities: 'priority',
  work: 'work',
  proposals: 'proposal',
  missions: 'mission',
  attempts: 'attempt',
  teams: 'team',
  mandates: 'mandate',
  actions: 'action',
  action_receipts: 'action_receipt',
  operations: 'operation',
  sources: 'source',
  schedules: 'schedule',
  reviews: 'review',
  outbox: 'outbox',
};
const referenceId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_:-]{1,200}$/.test(v);
function limits(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = [
    'max_attempts',
    'max_turns',
    'max_tool_calls',
    'max_concurrent_workers',
    'wall_seconds',
    'context_bytes',
    'result_bytes',
    'max_workers',
    'max_context_bytes',
    'max_wall_seconds',
    'max_missions',
    'max_notifications',
  ];
  return Object.fromEntries(
    Object.entries(value).filter(
      ([k, v]) => allowed.includes(k) && typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e9,
    ),
  ) as Record<string, number>;
}
async function read(client: PoolClient, context: Context, input: StatusInput): Promise<Result> {
  const params = [context.scopeId, context.ownerId, context.sessionId];
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const scope = (
      await client.query(
        "SELECT status,version FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 AND status IN ('active','paused')",
        [context.scopeId, context.ownerId, context.agentGroupId],
      )
    ).rows[0];
    if (!scope) {
      await client.query('ROLLBACK');
      return { status: 'denied' };
    }
    const categories = [];
    for (const category of STATUS_CATEGORIES) {
      // Bind all identity fields even when a projection only needs scope. No dynamic table/user SQL.
      const query = `WITH identity AS (SELECT $1::text AS scope,$2::text AS owner,$3::text AS session) SELECT state,count(*)::int AS count FROM (${projections[category]}) scoped GROUP BY state ORDER BY state`;
      const rows = (await client.query(query, params)).rows;
      if (
        rows.length > 24 ||
        rows.some(
          (r) =>
            typeof r.state !== 'string' ||
            !/^[a-z_]{1,40}$/.test(r.state) ||
            !Number.isSafeInteger(r.count) ||
            r.count < 0,
        )
      )
        throw Error('operator_status_invalid');
      categories.push({ category, states: Object.fromEntries(rows.map((r) => [r.state, r.count])) });
    }
    const category = input.category,
      limit = input.limit ?? 20,
      offset = input.offset ?? 0;
    const rows = category
      ? (
          await client.query(
            `WITH identity AS (SELECT $1::text AS scope,$2::text AS owner,$3::text AS session) SELECT * FROM (${projections[category]}) scoped ORDER BY id LIMIT $4 OFFSET $5`,
            [...params, limit + 1, offset],
          )
        ).rows
      : [];
    const items = [];
    for (const row of rows.slice(0, limit)) {
      if (!referenceId(row.id) || typeof row.state !== 'string' || !/^[a-z_]{1,40}$/.test(row.state))
        throw Error('operator_status_invalid');
      let purpose = { kind: 'scope', id: context.scopeId };
      if (referenceId(row.purpose_id)) {
        if (['priority', 'project', 'goal', 'charter'].includes(row.purpose_kind)) {
          const record = (
            await client.query('SELECT id,kind FROM cos.records WHERE scope_id=$1 AND id=$2', [
              context.scopeId,
              row.purpose_id,
            ])
          ).rows[0];
          if (record) purpose = { kind: 'priority', id: record.id };
        } else if (['mission', 'action'].includes(row.purpose_kind))
          purpose = { kind: row.purpose_kind, id: row.purpose_id };
      }
      let authority = { kind: 'scope', id: context.scopeId };
      if (category === 'action_receipts' && referenceId(row.authority_id))
        authority = { kind: 'action', id: row.authority_id };
      else if (referenceId(row.authority_id)) {
        const proposal = (
          await client.query('SELECT id FROM cos.proposals WHERE scope_id=$1 AND id=$2 AND owner_id=$3', [
            context.scopeId,
            row.authority_id,
            context.ownerId,
          ])
        ).rows[0];
        if (proposal) authority = { kind: 'proposal', id: proposal.id };
      }
      items.push({
        id: row.id,
        state: row.state,
        ...(Number.isSafeInteger(row.version) ? { version: row.version } : {}),
        purpose_ref: purpose,
        authority_ref: authority,
        evidence_ref: { kind: names[category!], id: row.id },
        limits: limits(row.limits),
      });
    }
    const usage = (
      await client.query(
        'SELECT kind,count(*)::int AS count FROM cos.mission_budget_reservations WHERE scope_id=$1 GROUP BY kind ORDER BY kind',
        [context.scopeId],
      )
    ).rows;
    const unknown = (
      await client.query(
        "SELECT count(*)::int AS count FROM cos.mandate_reservations WHERE scope_id=$1 AND state='unknown'",
        [context.scopeId],
      )
    ).rows[0].count;
    const expiredLeases = (
      await client.query(
        "SELECT count(*)::int AS count FROM cos.mission_attempts WHERE scope_id=$1 AND lease_until<=clock_timestamp() AND state IN ('allocating','ready','running')",
        [context.scopeId],
      )
    ).rows[0].count;
    await client.query('COMMIT');
    return {
      status: 'ok',
      format: 'cos-operator-status/v1',
      scope_state: scope.status,
      categories,
      category: category ?? null,
      items,
      next_offset: rows.length > limit && offset + limit <= 10000 ? offset + limit : null,
      page_truncated: rows.length > limit,
      pagination_exhausted: rows.length > limit && offset + limit > 10000,
      execution_authority: 'inspection_only',
      monetary_usage: 'unavailable',
      structural_reservations: Object.fromEntries(usage.map((r) => [r.kind, r.count])),
      unknown_mandate_reservations: unknown,
      expired_worker_leases: expiredLeases,
      coverage: 'scoped_metadata_only',
      source_content: 'withheld',
      provider_effects: 'use_current_action_reconciliation',
      read_at: new Date().toISOString(),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
/** Works while explicitly paused; does not change grants, schedule state, budgets or effects. */
export async function operatorStatus(database: BoundedDatabase, context: Context, input: StatusInput): Promise<Result> {
  if (context.origin || !validStatusInput(input)) return { status: 'denied' };
  try {
    return await database.run((client) => read(client, context, input));
  } catch (error) {
    if (error instanceof DatabaseUnavailable) return { status: 'unavailable' };
    throw error;
  }
}
