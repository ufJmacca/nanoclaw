import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { BoundedDatabase, DatabaseUnavailable } from '../store/client.js';
import { digest, type Result } from '../domain/contracts.js';
import { KnowledgeArtifactsBusy } from '../knowledge/artifacts.js';
import type { KnowledgeContext, KnowledgeStore } from '../knowledge/store.js';
import { checkMissionReview, validMissionReview } from '../contracts/mission-review.js';
import { validMissionResult, type MissionResult } from '../contracts/mission-result.js';
import type { MissionProposalStore } from './proposal-store.js';
import { type ResearchResultChecks } from './result-checks.js';
import { recordResearchExposure } from './exposure.js';
import type { ResearchWorkOrder } from './work-order.js';
import { readVerifiedSubmission } from './submission-reader.js';
import { currentReviewLease } from './review-runs.js';
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
  /** S10 publication pin. Delegation is checked again without rereading private bytes under a publication lease. */
  reviewAuthorityDigest(context: KnowledgeContext): string | null {
    const authority = this.proposals.authority?.(context);
    return !context.origin && context.provider === 'codex' && authority?.contextGeneration === context.generation
      ? digest(authority)
      : null;
  }
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
      (context.origin &&
        (context.origin.kind !== 'mission_review' ||
          context.origin.runId !== missionId ||
          context.origin.submissionId !== submissionId)) ||
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
    const { origin, ...ownerContext } = context;
    const order = await this.proposals.captureReview(client, ownerContext, {
      kind: 'research_mission',
      mission_id: missionId,
      work_order_digest: m.digest,
      work_order: m.body as ResearchWorkOrder['body'],
    });
    if (!order) return null;
    const verified = await readVerifiedSubmission(
      client,
      this.knowledge.artifacts,
      context.scopeId,
      missionId,
      submissionId,
      m.generation,
      order,
    );
    if (!verified || verified.checks.status !== 'review_required' || !validMissionResult(verified.result)) return null;
    const { submission, result, checks } = verified;
    const snapshot = { mission: m, submission, order, result, checks };
    if (
      origin &&
      (origin.kind !== 'mission_review' ||
        origin.generation !== submission.generation ||
        !(await currentReviewLease(client, snapshot, { owner: origin.owner, fence: origin.fence }, true)))
    )
      return null;
    return snapshot;
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
            origin: context.origin ?? null,
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
