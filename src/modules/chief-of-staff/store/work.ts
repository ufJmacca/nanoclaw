import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Context, Result } from '../domain/contracts.js';
import type { WorkChange, WorkRead } from '../contracts/protocol.js';
import type { AnswerCitation } from '../contracts/answer-protocol.js';
import type { KnowledgeContext, KnowledgeStore } from '../knowledge/store.js';

/** Uses the parent proposal transaction; this is not a second approval or offline authority store. */
export class WorkStore {
  constructor(readonly knowledge?: KnowledgeStore) {}
  async evidenceAllowed(
    client: PoolClient,
    context: Context,
    refs: AnswerCitation[],
    retained?: KnowledgeContext,
    historical = false,
  ): Promise<boolean> {
    if (!refs.length) return true;
    for (const ref of refs) {
      if (
        ref.kind === 'record' &&
        !(
          await client.query(
            "SELECT 1 FROM cos.records WHERE scope_id=$1 AND id=$2 AND version=$3 AND lifecycle='active'",
            [context.scopeId, ref.record_id, ref.version],
          )
        ).rowCount
      )
        return false;
    }
    if (!refs.some((r) => r.kind === 'source')) return true;
    if (
      !this.knowledge ||
      !retained ||
      retained.scopeId !== context.scopeId ||
      retained.ownerId !== context.ownerId ||
      retained.sessionId !== context.sessionId ||
      retained.agentGroupId !== context.agentGroupId
    )
      return false;
    return this.knowledge.answers.validateWorkEvidence(client, retained, refs, historical);
  }
  async validateChange(
    client: PoolClient,
    context: Context,
    change: WorkChange,
    retained?: KnowledgeContext,
  ): Promise<boolean> {
    if (
      change.project_id &&
      !(
        await client.query(
          "SELECT 1 FROM cos.records WHERE scope_id=$1 AND id=$2 AND kind='project' AND lifecycle='active'",
          [context.scopeId, change.project_id],
        )
      ).rowCount
    )
      return false;
    if (
      change.defer_until &&
      !(await client.query('SELECT $1::timestamptz > clock_timestamp() AS valid', [change.defer_until])).rows[0].valid
    )
      return false;
    return this.evidenceAllowed(client, context, change.evidence, retained);
  }
  async applyApproved(
    client: PoolClient,
    context: Context,
    proposal: { id: string; decision_ingress_id: string },
    change: WorkChange,
    retained?: KnowledgeContext,
  ): Promise<Result> {
    if (!(await this.validateChange(client, context, change, retained))) return { status: 'conflict' };
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
      change.kind,
      change.state,
      change.title,
      change.description,
      change.project_id,
      change.due ? JSON.stringify(change.due) : null,
      change.defer_until,
      JSON.stringify(change.evidence),
      retained ? JSON.stringify(retained) : null,
      JSON.stringify(provenance),
    ];
    const result = change.record_id
      ? await client.query(
          `UPDATE cos.work_items SET state=$5,title=$6,description=$7,project_id=$8,due=$9,defer_until=$10,evidence=$11,evidence_context=$12,provenance=$13,version=version+1,updated_at=clock_timestamp()
          WHERE scope_id=$1 AND id::text=$2 AND owner_id=$3 AND kind=$4 AND version=$14 RETURNING *`,
          [...values, change.expected_version],
        )
      : await client.query(
          `INSERT INTO cos.work_items(scope_id,id,owner_id,kind,state,title,description,project_id,due,defer_until,evidence,evidence_context,provenance,version)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1) ON CONFLICT DO NOTHING RETURNING *`,
          values,
        );
    if (result.rowCount !== 1) return { status: 'conflict' };
    const row = result.rows[0];
    await client.query(
      'INSERT INTO cos.work_revisions(scope_id,work_id,version,body,proposal_id) VALUES($1,$2,$3,$4,$5)',
      [context.scopeId, id, row.version, JSON.stringify(row), proposal.id],
    );
    return { status: 'ok', record_id: id };
  }
  async read(client: PoolClient, context: Context, input: WorkRead, retained?: KnowledgeContext): Promise<Result> {
    if ('record_id' in input) {
      const row =
        input.version === undefined
          ? (
              await client.query('SELECT * FROM cos.work_items WHERE scope_id=$1 AND owner_id=$2 AND id::text=$3', [
                context.scopeId,
                context.ownerId,
                input.record_id,
              ])
            ).rows[0]
          : (
              await client.query(
                'SELECT r.body FROM cos.work_revisions r JOIN cos.work_items w ON w.scope_id=r.scope_id AND w.id=r.work_id WHERE r.scope_id=$1 AND w.owner_id=$2 AND r.work_id::text=$3 AND r.version=$4',
                [context.scopeId, context.ownerId, input.record_id, input.version],
              )
            ).rows[0]?.body;
      if (!row || !(await this.evidenceAllowed(client, context, row.evidence, retained, true)))
        return { status: 'denied' };
      const { evidence_context: _context, ...item } = row;
      return { status: 'ok', item };
    }
    const offset = input.offset ?? 0;
    const rows = (
      await client.query(
        `SELECT * FROM cos.work_items WHERE scope_id=$1 AND owner_id=$2 AND
      ($3::boolean OR state IN ('confirmed','needed') OR (state='deferred' AND defer_until<=clock_timestamp())) ORDER BY kind,id LIMIT 6 OFFSET $4`,
        [context.scopeId, context.ownerId, input.view === 'all', offset],
      )
    ).rows;
    const items: unknown[] = [];
    let withheld = 0;
    for (const row of rows.slice(0, 5)) {
      if (!(await this.evidenceAllowed(client, context, row.evidence, retained, true))) {
        withheld++;
        continue;
      }
      items.push({
        id: row.id,
        kind: row.kind,
        state: row.state,
        title: row.title,
        description: row.description.slice(0, 300),
        description_truncated: row.description.length > 300,
        project_id: row.project_id,
        due: row.due,
        defer_until: row.defer_until,
        evidence: row.evidence,
        version: row.version,
        owner_id: row.owner_id,
        provenance: { proposal_id: row.provenance.proposal_id },
      });
    }
    return {
      status: 'ok',
      items,
      withheld,
      next_offset: rows.length > 5 && offset < 10000 ? offset + 5 : null,
      truncated: rows.length > 5,
    };
  }
}
