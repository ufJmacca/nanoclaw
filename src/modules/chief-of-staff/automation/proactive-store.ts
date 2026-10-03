import type { PoolClient } from 'pg';
import type { Context, Result } from '../domain/contracts.js';
import type { ProactivePolicyChange } from '../contracts/proactive-protocol.js';
/** Used within the host approval transaction; models cannot approve configuration or dispositions. */
export class ProactiveStore {
  async validatePolicyChange(client: PoolClient, context: Context, change: ProactivePolicyChange): Promise<boolean> {
    const current = (
      await client.query('SELECT owner_id,version FROM cos.proactive_policies WHERE scope_id=$1', [context.scopeId])
    ).rows[0];
    return (
      !context.origin &&
      (current
        ? current.owner_id === context.ownerId && current.version === change.expected_version
        : change.expected_version === 0)
    );
  }
  async applyPolicy(
    client: PoolClient,
    context: Context,
    proposal: { id: string; decision_ingress_id: string },
    change: ProactivePolicyChange,
  ): Promise<Result> {
    if (!(await this.validatePolicyChange(client, context, change))) return { status: 'conflict' };
    const version = change.expected_version + 1;
    const provenance = {
      owner_id: context.ownerId,
      ingress_id: proposal.decision_ingress_id,
      proposal_id: proposal.id,
    };
    await client.query(
      `INSERT INTO cos.proactive_policies(scope_id,owner_id,version,state,policy,provenance) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(scope_id) DO UPDATE SET version=excluded.version,state=excluded.state,policy=excluded.policy,provenance=excluded.provenance,updated_at=clock_timestamp()`,
      [
        context.scopeId,
        context.ownerId,
        version,
        change.state,
        JSON.stringify(change.policy),
        JSON.stringify(provenance),
      ],
    );
    await client.query(
      'INSERT INTO cos.proactive_policy_revisions(scope_id,version,body,proposal_id) VALUES($1,$2,$3,$4)',
      [context.scopeId, version, JSON.stringify({ ...change, provenance }), proposal.id],
    );
    return { status: 'ok', record_id: 'proactive-policy', version };
  }
}
