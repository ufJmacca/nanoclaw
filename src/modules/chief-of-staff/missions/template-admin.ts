import type pg from 'pg';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { parseDelegationChange } from './delegation.js';
import { RESEARCH_TEMPLATE } from './work-order.js';

/** Migration-role caller owns the maintenance lock and transaction. Never reachable from worker RPC. */
export async function installReviewedMissionTemplate(
  client: Pick<pg.Client, 'query'>,
  binding: CosBinding,
  requestId: string,
  input: unknown,
): Promise<void> {
  const change = parseDelegationChange(input);
  const scope = (
    await client.query(
      'SELECT owner_id,instance_id,channel_id,agent_group_id,status FROM cos.scopes WHERE id=$1 FOR UPDATE',
      [binding.scopeId],
    )
  ).rows[0];
  if (
    !scope ||
    scope.owner_id !== binding.ownerId ||
    scope.instance_id !== binding.instanceId ||
    scope.channel_id !== binding.channelId ||
    scope.agent_group_id !== binding.agentGroupId ||
    scope.status !== 'active'
  )
    throw Error('context_binding_changed');
  const parameters = [binding.scopeId, RESEARCH_TEMPLATE.id, RESEARCH_TEMPLATE.version];
  const existing = (
    await client.query(
      'SELECT body,digest,reviewed_by FROM cos.mission_template_versions WHERE scope_id=$1 AND id=$2 AND version=$3 FOR UPDATE',
      parameters,
    )
  ).rows[0];
  if (existing) {
    if (
      existing.digest !== change.templateDigest ||
      digest(existing.body) !== change.templateDigest ||
      existing.reviewed_by !== binding.ownerId
    )
      throw Error('mission_template_conflict');
    return;
  }
  await client.query(
    'INSERT INTO cos.mission_template_versions(scope_id,id,version,body,digest,reviewed_by,provenance) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      ...parameters,
      JSON.stringify(RESEARCH_TEMPLATE),
      change.templateDigest,
      binding.ownerId,
      JSON.stringify({ request_id: requestId, review_ref: change.reviewRef, binding_digest: digest(binding) }),
    ],
  );
}
