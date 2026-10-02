import type { PoolClient } from 'pg';
import { digest } from '../domain/contracts.js';
import type { KnowledgeArtifacts } from '../knowledge/artifacts.js';
import type { MissionWorkerResult } from '../contracts/mission-worker-protocol.js';
import type { ResearchWorkOrder } from './work-order.js';
import { checkWorkerResult } from './result-checks.js';

/** Caller recaptures current source/provider/parent authority before invoking this reader.
 * The published artifact and attempt are locked through the transaction. No private worker history is read. */
export async function readVerifiedSubmission(
  client: PoolClient,
  artifacts: KnowledgeArtifacts,
  scopeId: string,
  missionId: string,
  submissionId: string,
  generation: number,
  order: ResearchWorkOrder,
  requireStopped = false,
) {
  const submission = (
    await client.query(
      `SELECT s.*,a.digest AS artifact_digest,a.kind,a.lifecycle,a.provenance AS artifact_provenance,
    t.state AS attempt_state,t.allocation,t.session_id AS worker_session
    FROM cos.mission_result_submissions s JOIN cos.artifacts a ON a.scope_id=s.scope_id AND a.id=s.artifact_id
    JOIN cos.mission_attempts t ON t.scope_id=s.scope_id AND t.mission_id=s.mission_id AND t.id=s.attempt_id AND t.generation=s.generation
    WHERE s.scope_id=$1 AND s.mission_id=$2 AND s.id=$3 FOR SHARE OF a,t`,
      [scopeId, missionId, submissionId],
    )
  ).rows[0];
  if (
    !submission ||
    submission.generation !== generation ||
    submission.attempt_state !== 'submitted' ||
    (requireStopped && submission.allocation.stop_confirmed !== true) ||
    submission.kind !== 'mission_result' ||
    submission.lifecycle !== 'published' ||
    submission.artifact_digest !== submission.body.artifact_digest ||
    submission.artifact_provenance.submission_id !== submissionId ||
    submission.artifact_provenance.mission_id !== missionId ||
    submission.artifact_provenance.attempt_id !== submission.attempt_id ||
    submission.artifact_provenance.generation !== submission.generation ||
    submission.artifact_provenance.processing_provider !== 'codex' ||
    submission.artifact_provenance.context_generation !== submission.attempt_id ||
    submission.artifact_provenance.session_id !== submission.worker_session ||
    submission.artifact_provenance.work_order_digest !== order.digest ||
    submission.artifact_provenance.result_digest !== submission.digest
  )
    return null;
  const result: MissionWorkerResult = JSON.parse(artifacts.read(submission.artifact_id, submission.artifact_digest));
  const checks = checkWorkerResult(order, result);
  if (
    checks.status === 'invalid' ||
    checks.resultDigest !== submission.digest ||
    digest(checks) !== digest(submission.body.checks)
  )
    return null;
  return { submission, result, checks };
}
