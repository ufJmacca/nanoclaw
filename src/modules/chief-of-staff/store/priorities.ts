import type { Context, Change, Result } from '../domain/contracts.js';
import { digest, validChange } from '../domain/contracts.js';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { BoundedDatabase, DatabaseUnavailable } from './client.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function authorised(client: PoolClient, context: Context): Promise<boolean> {
  const result = await client.query(
    `SELECT id FROM cos.scopes WHERE id=$1 AND owner_id=$2
    AND agent_group_id=$3 AND status='active' FOR SHARE`,
    [context.scopeId, context.ownerId, context.agentGroupId],
  );
  return result.rowCount === 1;
}

async function event(
  client: PoolClient,
  scope: string,
  kind: string,
  resource: string,
  provenance: unknown,
): Promise<void> {
  await client.query(
    'INSERT INTO cos.events(id,scope_id,kind,resource_id,version,provenance) VALUES($1,$2,$3,$4,1,$5)',
    [randomUUID(), scope, kind, resource, JSON.stringify(provenance)],
  );
}

export class PriorityStore {
  constructor(readonly database: BoundedDatabase) {}

  private async transaction(operation: (client: PoolClient) => Promise<Result>, mutation = true): Promise<Result> {
    try {
      return await this.database.run(async (client) => {
        await client.query('BEGIN');
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      }, mutation);
    } catch (error) {
      if (error instanceof DatabaseUnavailable) return { status: error.code === 'pending' ? 'pending' : 'unavailable' };
      throw error;
    }
  }

  async propose(context: Context, requestId: string, change: Change): Promise<Result> {
    if (!uuid.test(requestId) || !validChange(change)) return { status: 'denied' };
    const hash = digest({ method: 'cos_change_propose', change });
    const result = await this.transaction(async (client) => {
      if (!(await authorised(client, context))) return { status: 'denied' };
      const inserted = await client.query(
        `INSERT INTO cos.operations(session_id,request_id,scope_id,method,payload_hash)
        VALUES($1,$2,$3,'cos_change_propose',$4) ON CONFLICT DO NOTHING RETURNING request_id`,
        [context.sessionId, requestId, context.scopeId, hash],
      );
      if (inserted.rowCount === 0) {
        // Unique insertion waits for the original, even when its commit acknowledgement was lost.
        const existing = (
          await client.query(
            'SELECT scope_id,payload_hash,result FROM cos.operations WHERE session_id=$1 AND request_id=$2',
            [context.sessionId, requestId],
          )
        ).rows[0];
        if (existing?.scope_id !== context.scopeId || existing?.payload_hash !== hash) return { status: 'conflict' };
        return existing.result ?? { status: 'pending', request_id: requestId };
      }
      const id = randomUUID();
      const token = randomBytes(24).toString('base64url');
      await client.query(
        `INSERT INTO cos.proposals(id,scope_id,session_id,ingress_id,owner_id,change,payload_hash,challenge_hash,state,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',clock_timestamp()+interval '15 minutes')`,
        [
          id,
          context.scopeId,
          context.sessionId,
          context.ingressId,
          context.ownerId,
          JSON.stringify(change),
          digest(change),
          digest(token),
        ],
      );
      const receipt: Result = {
        status: 'ok',
        proposal_id: id,
        confirmation_token: token,
        change,
        request_id: requestId,
      };
      await client.query(`INSERT INTO cos.outbox(id,scope_id,kind,payload) VALUES($1,$2,'approval_preview',$3)`, [
        'preview-' + id,
        context.scopeId,
        JSON.stringify(receipt),
      ]);
      await event(client, context.scopeId, 'proposed', id, {
        ingress_id: context.ingressId,
        owner_id: context.ownerId,
      });
      await client.query('UPDATE cos.operations SET result=$3 WHERE session_id=$1 AND request_id=$2', [
        context.sessionId,
        requestId,
        JSON.stringify(receipt),
      ]);
      return receipt;
    });
    return result.status === 'pending' ? { ...result, request_id: requestId } : result;
  }

  async decide(context: Context, proposalId: string, token: string, decision: 'approve' | 'reject'): Promise<Result> {
    if (!uuid.test(proposalId) || token.length > 100 || !['approve', 'reject'].includes(decision))
      return { status: 'denied' };
    return this.transaction(async (client) => {
      if (!(await authorised(client, context))) return { status: 'denied' };
      const proposal = (
        await client.query(
          `SELECT *,expires_at <= clock_timestamp() AS expired FROM cos.proposals
        WHERE id=$1 AND scope_id=$2 FOR UPDATE`,
          [proposalId, context.scopeId],
        )
      ).rows[0];
      if (!proposal || proposal.owner_id !== context.ownerId || !equal(proposal.challenge_hash, digest(token)))
        return { status: 'denied' };
      if (proposal.state !== 'pending') {
        if (proposal.decision_ingress_id !== context.ingressId) return { status: 'denied' };
        const approved = ['approved', 'applied', 'conflict'].includes(proposal.state);
        return approved === (decision === 'approve')
          ? { status: 'ok', proposal_id: proposalId, decision }
          : { status: 'conflict' };
      }
      if (proposal.expired) {
        await client.query("UPDATE cos.proposals SET state='expired',updated_at=clock_timestamp() WHERE id=$1", [
          proposalId,
        ]);
        return { status: 'denied' };
      }
      const reused = await client.query('SELECT id FROM cos.proposals WHERE decision_ingress_id=$1', [
        context.ingressId,
      ]);
      if (reused.rowCount) return { status: 'denied' };
      await client.query(
        'UPDATE cos.proposals SET state=$2,decision_ingress_id=$3,updated_at=clock_timestamp() WHERE id=$1',
        [proposalId, decision === 'approve' ? 'approved' : 'rejected', context.ingressId],
      );
      await event(client, context.scopeId, decision, proposalId, {
        owner_id: context.ownerId,
        ingress_id: context.ingressId,
        payload_hash: proposal.payload_hash,
      });
      if (decision === 'approve')
        await client.query(
          `INSERT INTO cos.outbox(id,scope_id,kind,payload) VALUES($1,$2,'proposal_apply',$3) ON CONFLICT DO NOTHING`,
          ['apply-' + proposalId, context.scopeId, JSON.stringify({ proposal_id: proposalId })],
        );
      return { status: 'ok', proposal_id: proposalId, decision };
    });
  }

  /** Trusted outbox consumer only; approval acceptance never applies effects inline. */
  async apply(scopeId: string, proposalId: string): Promise<Result> {
    return this.transaction(async (client) => {
      const scope = await client.query("SELECT id FROM cos.scopes WHERE id=$1 AND status='active' FOR UPDATE", [
        scopeId,
      ]);
      if (!scope.rowCount) return { status: 'denied' };
      const proposal = (
        await client.query('SELECT * FROM cos.proposals WHERE id=$1 AND scope_id=$2 FOR UPDATE', [proposalId, scopeId])
      ).rows[0];
      if (!proposal || !['approved', 'applied', 'conflict'].includes(proposal.state)) return { status: 'denied' };
      if (proposal.state === 'applied') return { status: 'ok', record_id: proposal.applied_record_id };
      if (proposal.state === 'conflict') return { status: 'conflict' };
      const change = proposal.change as Change;
      if (!validChange(change) || digest(change) !== proposal.payload_hash) return { status: 'denied' };
      const recordId = change.record_id ?? randomUUID();
      const provenance = {
        proposal_id: proposalId,
        owner_id: proposal.owner_id,
        ingress_id: proposal.decision_ingress_id,
      };
      let changed = 0;
      if (change.record_id) {
        const update = await client.query(
          `UPDATE cos.records SET title=$3,description=$4,lifecycle=$5,version=version+1,
          provenance=$6,updated_at=clock_timestamp() WHERE id=$1 AND scope_id=$2 AND version=$7 AND kind=$8`,
          [
            recordId,
            scopeId,
            change.title,
            change.description,
            change.lifecycle,
            JSON.stringify(provenance),
            change.expected_version,
            change.kind,
          ],
        );
        changed = update.rowCount ?? 0;
      } else {
        const insert = await client.query(
          `INSERT INTO cos.records(id,scope_id,kind,title,description,lifecycle,version,provenance)
          VALUES($1,$2,$3,$4,$5,$6,1,$7) ON CONFLICT DO NOTHING`,
          [
            recordId,
            scopeId,
            change.kind,
            change.title,
            change.description,
            change.lifecycle,
            JSON.stringify(provenance),
          ],
        );
        changed = insert.rowCount ?? 0;
      }
      await client.query(
        'UPDATE cos.proposals SET state=$2,applied_record_id=$3,updated_at=clock_timestamp() WHERE id=$1',
        [proposalId, changed ? 'applied' : 'conflict', changed ? recordId : null],
      );
      await client.query('UPDATE cos.outbox SET delivered_at=clock_timestamp() WHERE id=$1', ['apply-' + proposalId]);
      await event(client, scopeId, changed ? 'applied' : 'conflict', proposalId, provenance);
      return changed ? { status: 'ok', record_id: recordId } : { status: 'conflict' };
    });
  }

  async context(context: Context): Promise<Result> {
    return this.transaction(async (client) => {
      if (!(await authorised(client, context))) return { status: 'denied' };
      const records = (
        await client.query(
          `SELECT id,kind,title,description,version,provenance FROM cos.records
        WHERE scope_id=$1 AND lifecycle='active' ORDER BY kind,id LIMIT 100`,
          [context.scopeId],
        )
      ).rows;
      return {
        status: 'ok',
        records,
        ranking: 'advice',
        coverage: records.length ? ['approved_records_only'] : ['no_approved_priorities'],
      };
    }, false);
  }
}
