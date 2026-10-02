import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { BoundedDatabase, DatabaseUnavailable } from '../store/client.js';
import { digest, type Result } from '../domain/contracts.js';
import { KnowledgeArtifactsBusy } from '../knowledge/artifacts.js';
import type { KnowledgeContext, KnowledgeStore } from '../knowledge/store.js';
import { checkMissionReview, validMissionReview } from '../contracts/mission-review.js';
import type { MissionResult } from '../contracts/mission-result.js';
import type { MissionProposalStore } from './proposal-store.js';
import { checkResearchResult, type ResearchResultChecks } from './result-checks.js';
import { recordResearchExposure } from './exposure.js';
import type { ResearchWorkOrder } from './work-order.js';
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
export type ReviewSnapshot = {
  mission: { state: string; version: number; generation: number };
  submission: {
    id: string;
    digest: string;
    attempt_id: string;
    generation: number;
    allocation: Record<string, unknown>;
  };
  order: ResearchWorkOrder;
  result: MissionResult;
  checks: Extract<ResearchResultChecks, { status: 'review_required' }>;
};

/** Coordinator-only result access and advisory semantic review. Specialist submissions cannot call this store. */
export class MissionReviews {
  constructor(
    readonly database: BoundedDatabase,
    readonly proposals: MissionProposalStore,
    readonly knowledge: KnowledgeStore,
  ) {}
  private async transaction(operation: (client: PoolClient) => Promise<Result>): Promise<Result> {
    try {
      return await this.knowledge.artifacts.exclusive(() =>
        this.database.run(async (client) => {
          await client.query('BEGIN');
          const result = await operation(client);
          await client.query('COMMIT');
          return result;
        }, true),
      );
    } catch (error) {
      if (error instanceof DatabaseUnavailable) return { status: error.code === 'pending' ? 'pending' : 'unavailable' };
      if (error instanceof KnowledgeArtifactsBusy) return { status: 'unavailable' };
      throw error;
    }
  }
  /** Trusted host review orchestration shares the artifact lock and current mission row lock. */
  async withCurrentSubmission(
    context: KnowledgeContext,
    missionId: string,
    submissionId: string,
    operation: (client: PoolClient, current: ReviewSnapshot) => Promise<Result>,
  ): Promise<Result> {
    return this.transaction(async (client) => {
      const current = await this.snapshot(client, context, missionId, submissionId);
      return current ? operation(client, current) : { status: 'denied' };
    });
  }
  private async snapshot(
    client: PoolClient,
    context: KnowledgeContext,
    missionId: string,
    submissionId: string,
  ): Promise<ReviewSnapshot | null> {
    if (
      context.origin ||
      context.provider !== 'codex' ||
      !uuid(context.generation) ||
      !id(missionId) ||
      !uuid(submissionId)
    )
      return null;
    if (
      !(
        await client.query(
          "SELECT id FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 AND status='active' FOR SHARE",
          [context.scopeId, context.ownerId, context.agentGroupId],
        )
      ).rowCount
    )
      return null;
    const m = (
      await client.query(
        `SELECT m.state,m.version,m.generation,w.body,w.digest,p.state AS proposal_state,p.applied_record_id
      FROM cos.missions m JOIN cos.mission_work_orders w ON w.scope_id=m.scope_id AND w.id=m.id
      JOIN cos.proposals p ON p.id=m.proposal_id AND p.scope_id=m.scope_id
      WHERE m.scope_id=$1 AND m.id=$2 FOR UPDATE OF m`,
        [context.scopeId, missionId],
      )
    ).rows[0];
    if (
      !m ||
      !['awaiting_review', 'completed', 'partial', 'blocked'].includes(m.state) ||
      m.proposal_state !== 'applied' ||
      m.applied_record_id !== missionId
    )
      return null;
    const order = await this.proposals.captureReview(client, context, {
      kind: 'research_mission',
      mission_id: missionId,
      work_order_digest: m.digest,
      work_order: m.body as ResearchWorkOrder['body'],
    });
    if (!order) return null;
    const submission = (
      await client.query(
        `SELECT s.*,a.digest AS artifact_digest,a.kind,a.lifecycle,a.provenance AS artifact_provenance,
      t.state AS attempt_state,t.allocation,t.session_id AS worker_session
      FROM cos.mission_result_submissions s JOIN cos.artifacts a ON a.scope_id=s.scope_id AND a.id=s.artifact_id
      JOIN cos.mission_attempts t ON t.scope_id=s.scope_id AND t.mission_id=s.mission_id AND t.id=s.attempt_id AND t.generation=s.generation
      WHERE s.scope_id=$1 AND s.mission_id=$2 AND s.id=$3 FOR SHARE OF a,t`,
        [context.scopeId, missionId, submissionId],
      )
    ).rows[0];
    if (
      !submission ||
      submission.generation !== m.generation ||
      submission.attempt_state !== 'submitted' ||
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
    const result: MissionResult = JSON.parse(
      this.knowledge.artifacts.read(submission.artifact_id, submission.artifact_digest),
    );
    const checks = checkResearchResult(order, result);
    if (
      checks.status !== 'review_required' ||
      checks.resultDigest !== submission.digest ||
      digest(checks) !== digest(submission.body.checks)
    )
      return null;
    return { mission: m, submission, order, result, checks };
  }
  async read(context: KnowledgeContext, missionId: string, submissionId: string): Promise<Result> {
    return this.transaction(async (client) => {
      const current = await this.snapshot(client, context, missionId, submissionId);
      if (!current) return { status: 'denied' };
      await recordResearchExposure(client, context, current.order);
      const review =
        (
          await client.query(
            'SELECT id,decision,checks FROM cos.mission_reviews WHERE scope_id=$1 AND mission_id=$2 AND result_id=$3',
            [context.scopeId, missionId, submissionId],
          )
        ).rows[0] ?? null;
      return {
        status: 'ok',
        mission: { id: missionId, state: current.mission.state, version: current.mission.version },
        submission: { id: submissionId, digest: current.submission.digest },
        result: current.result,
        criteria: current.order.body.request.acceptance_criteria,
        review,
      };
    });
  }
  async review(context: KnowledgeContext, requestId: string, input: unknown): Promise<Result> {
    if (!uuid(requestId) || !validMissionReview(input)) return { status: 'denied' };
    return this.transaction(async (client) => {
      const current = await this.snapshot(client, context, input.mission_id, input.submission_id);
      if (!current) return { status: 'denied' };
      const hash = digest({ method: 'cos_mission_review', generation: context.generation, review: input });
      const old = (
        await client.query(
          'SELECT scope_id,payload_hash,result FROM cos.operations WHERE session_id=$1 AND request_id=$2',
          [context.sessionId, requestId],
        )
      ).rows[0];
      if (old)
        return old.scope_id === context.scopeId && old.payload_hash === hash
          ? (old.result ?? { status: 'pending' })
          : { status: 'conflict' };
      if (
        current.mission.state !== 'awaiting_review' ||
        current.mission.version !== input.expected_version ||
        current.submission.digest !== input.result_digest
      )
        return { status: 'conflict' };
      if (current.submission.allocation.stop_confirmed !== true) return { status: 'pending', state: 'awaiting_review' };
      const state = checkMissionReview(input, current.checks);
      if (!state) return { status: 'denied' };
      const inserted = await client.query(
        `INSERT INTO cos.operations(session_id,request_id,scope_id,method,payload_hash)
        VALUES($1,$2,$3,'cos_mission_review',$4) ON CONFLICT DO NOTHING RETURNING request_id`,
        [context.sessionId, requestId, context.scopeId, hash],
      );
      if (!inserted.rowCount) return { status: 'conflict' };
      const reviewId = randomUUID();
      await recordResearchExposure(client, context, current.order);
      await client.query(
        `INSERT INTO cos.mission_reviews(scope_id,id,mission_id,result_id,decision,checks,provenance)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          context.scopeId,
          reviewId,
          input.mission_id,
          input.submission_id,
          input.decision,
          JSON.stringify({ deterministic: current.checks, criteria: input.criteria, semantic_review: 'advisory' }),
          JSON.stringify({
            request_id: requestId,
            owner_id: context.ownerId,
            session_id: context.sessionId,
            context_generation: context.generation,
            ingress_id: context.ingressId,
            result_digest: input.result_digest,
            work_order_digest: current.order.digest,
          }),
        ],
      );
      await client.query(
        'UPDATE cos.missions SET state=$3,version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2',
        [context.scopeId, input.mission_id, state],
      );
      const receipt = {
        status: 'ok',
        mission_id: input.mission_id,
        submission_id: input.submission_id,
        review_id: reviewId,
        state,
        version: input.expected_version + 1,
      };
      await client.query(
        "INSERT INTO cos.outbox(id,scope_id,kind,payload) VALUES($1,$2,'mission_review_notification',$3)",
        [
          'mission-review-' + reviewId,
          context.scopeId,
          JSON.stringify({
            mission_id: input.mission_id,
            submission_id: input.submission_id,
            review_id: reviewId,
            session_id: context.sessionId,
            context_generation: context.generation,
            result_digest: input.result_digest,
          }),
        ],
      );
      await client.query('UPDATE cos.operations SET result=$3 WHERE session_id=$1 AND request_id=$2', [
        context.sessionId,
        requestId,
        JSON.stringify(receipt),
      ]);
      return receipt;
    });
  }
}
