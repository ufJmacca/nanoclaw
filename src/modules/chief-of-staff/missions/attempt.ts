import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CosMissionIdentity } from '../../../cos-mission-boundary.js';
import { digest } from '../domain/contracts.js';

/** Parent mission row must be locked and its approved root limit checked before calling. */
export async function queueMissionAttempt(
  client: PoolClient,
  scopeId: string,
  missionId: string,
  generation: number,
  workOrderDigest: string,
  provenance: Record<string, unknown>,
): Promise<CosMissionIdentity> {
  const identity: CosMissionIdentity = {
    scopeId,
    missionId,
    generation,
    attemptId: randomUUID(),
    agentGroupId: 'cos-mission-' + randomUUID(),
    sessionId: randomUUID(),
    provider: 'codex',
  };
  const inputId = 'cos-mission-input-' + randomUUID();
  await client.query(
    "INSERT INTO cos.mission_attempts(scope_id,id,mission_id,generation,dispatch_revision,input_id,agent_group_id,session_id,state,provenance) VALUES($1,$2,$3,$4,1,$5,$6,$7,'queued',$8)",
    [
      scopeId,
      identity.attemptId,
      missionId,
      generation,
      inputId,
      identity.agentGroupId,
      identity.sessionId,
      JSON.stringify(provenance),
    ],
  );
  await client.query(
    "INSERT INTO cos.mission_budget_reservations(scope_id,mission_id,call_id,attempt_id,generation,kind,payload_digest) VALUES($1,$2,$3,$4,$5,'attempt',$6)",
    [
      scopeId,
      missionId,
      'attempt-' + identity.attemptId,
      identity.attemptId,
      generation,
      digest({ identity, inputId, workOrder: workOrderDigest }),
    ],
  );
  await client.query(
    "UPDATE cos.missions SET state='queued',generation=$3,version=version+1,provenance=provenance||$4::jsonb,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
    [scopeId, missionId, generation, JSON.stringify(provenance)],
  );
  return identity;
}
