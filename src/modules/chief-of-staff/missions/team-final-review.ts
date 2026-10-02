import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { KnowledgeContext } from '../knowledge/store.js';
import { digest, type Result } from '../domain/contracts.js';
import { validMissionReview, checkMissionReview } from '../contracts/mission-review.js';
import type { MissionReviewLease, MissionReviewIdentity } from './review-runs.js';
import type { TeamRunStore } from './team-run-store.js';
import type { TeamReviewSnapshot } from './team-snapshot.js';
import { teamStepUsage } from './team-budget.js';
import { settleTeamCredits } from './team-settlement.js';
import { recordResearchExposure } from './exposure.js';

const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const validLease = (v: unknown): v is MissionReviewLease =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === 2 &&
  id((v as MissionReviewLease).owner) &&
  Number.isSafeInteger((v as MissionReviewLease).fence) &&
  (v as MissionReviewLease).fence > 0;
type Grant = MissionReviewLease & {
  deadlineAt: string;
  resultDigest: string;
  version: number;
  submissionId: string;
  attemptId: string;
};
function grant(v: unknown): Grant | null {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(',') !== 'attemptId,deadlineAt,fence,owner,resultDigest,submissionId,version'
  )
    return null;
  const g = v as Grant;
  return validLease({ owner: g.owner, fence: g.fence }) &&
    hash(g.resultDigest) &&
    uuid(g.submissionId) &&
    uuid(g.attemptId) &&
    Number.isSafeInteger(g.version) &&
    g.version > 0 &&
    typeof g.deadlineAt === 'string' &&
    Number.isFinite(Date.parse(g.deadlineAt))
    ? g
    : null;
}

/** Final team judgement belongs to the retained main CoS context, never a specialist. No model wait holds this pool. */
export class TeamFinalReviews {
  constructor(readonly teams: TeamRunStore) {}
  private withCurrent(
    context: KnowledgeContext,
    teamId: string,
    operation: (client: PoolClient, current: TeamReviewSnapshot) => Promise<Result>,
  ): Promise<Result> {
    if (context.provider !== 'codex' || !uuid(context.generation) || !id(teamId) || context.origin?.kind === 'schedule')
      return Promise.resolve({ status: 'denied' });
    const { origin, ...ownerContext } = context;
    return this.teams.withReviewSnapshot(ownerContext, teamId, async (client, current) => {
      if (
        current.order.body.origin.contextGeneration !== context.generation ||
        (origin &&
          (origin.kind !== 'mission_review' ||
            origin.runId !== teamId ||
            origin.submissionId !== current.anchor.id ||
            origin.generation !== current.root.generation ||
            !(await this.currentLease(client, current, { owner: origin.owner, fence: origin.fence }, true))))
      )
        return { status: 'denied' };
      return operation(client, current);
    });
  }
  private async currentLease(
    client: PoolClient,
    current: TeamReviewSnapshot,
    lease: MissionReviewLease,
    receiptOnly = false,
  ): Promise<boolean> {
    const stored = grant(current.root.provenance.coordinator_review),
      retired = current.root.provenance.coordinator_review_retired;
    const states = receiptOnly ? ['awaiting_review', 'completed', 'partial', 'blocked'] : ['awaiting_review'];
    return (
      validLease(lease) &&
      !!stored &&
      states.includes(current.root.state) &&
      stored.owner === lease.owner &&
      stored.fence === lease.fence &&
      stored.resultDigest === current.resultDigest &&
      stored.submissionId === current.anchor.id &&
      stored.attemptId === current.anchor.attempt_id &&
      (current.root.version === stored.version ||
        (receiptOnly && current.root.state !== 'awaiting_review' && current.root.version === stored.version + 1)) &&
      digest(retired ?? null) !== digest({ owner: stored.owner, fence: stored.fence }) &&
      (
        await client.query('SELECT $1::timestamptz>clock_timestamp() AND $1::timestamptz<=$2::timestamptz AS current', [
          stored.deadlineAt,
          current.order.body.deadlineAt,
        ])
      ).rows[0].current
    );
  }
  private async stopped(client: PoolClient, context: KnowledgeContext, teamId: string): Promise<boolean> {
    return !(
      await client.query(
        `SELECT 1 FROM cos.mission_team_children c JOIN cos.mission_attempts a ON a.scope_id=c.scope_id AND a.mission_id=c.mission_id
      WHERE c.scope_id=$1 AND c.team_id=$2 AND a.allocation->>'stop_confirmed' IS DISTINCT FROM 'true' LIMIT 1`,
        [context.scopeId, teamId],
      )
    ).rowCount;
  }
  private async deadline(client: PoolClient, current: TeamReviewSnapshot) {
    return (
      await client.query("SELECT LEAST($1::timestamptz,clock_timestamp()+interval '30 seconds') AS deadline", [
        current.order.body.deadlineAt,
      ])
    ).rows[0].deadline.toISOString() as string;
  }
  private async capacity(client: PoolClient, context: KnowledgeContext, current: TeamReviewSnapshot) {
    let model = 0,
      tool = 0;
    for (const step of current.order.body.request.steps) {
      const usage = await teamStepUsage(client, context.scopeId, current.root.id, step.step_id);
      model += step.limits.max_turns - usage.model;
      tool += step.limits.max_tool_calls - usage.tool;
    }
    return { model, tool };
  }
  private async save(client: PoolClient, context: KnowledgeContext, teamId: string, value: Grant) {
    await client.query(
      "UPDATE cos.mission_team_roots SET provenance=jsonb_set(provenance,'{coordinator_review}',$3::jsonb),updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
      [context.scopeId, teamId, JSON.stringify(value)],
    );
  }
  async read(context: KnowledgeContext, teamId: string, submissionId: string): Promise<Result> {
    if (!uuid(submissionId)) return { status: 'denied' };
    return this.withCurrent(context, teamId, async (client, current) => {
      if (current.anchor.id !== submissionId) return { status: 'denied' };
      await recordResearchExposure(client, context, current.order);
      const review =
        (
          await client.query(
            'SELECT id,decision,checks FROM cos.mission_team_reviews WHERE scope_id=$1 AND team_id=$2 AND generation=$3 AND result_digest=$4',
            [context.scopeId, teamId, current.root.generation, current.resultDigest],
          )
        ).rows[0] ?? null;
      return {
        status: 'ok',
        mission: { id: teamId, state: current.root.state, version: current.root.version },
        submission: { id: submissionId, digest: current.resultDigest },
        result: current.brief,
        criteria: current.order.body.request.acceptance_criteria,
        review,
      };
    });
  }
  /** Trusted host establishes independent main-session idle before installing the acknowledged lease in native SQLite. */
  async claim(context: KnowledgeContext, teamId: string, submissionId: string, hostId: string): Promise<Result> {
    if (context.origin || !uuid(submissionId) || !id(hostId)) return { status: 'denied' };
    return this.withCurrent(context, teamId, async (client, current) => {
      if (
        current.root.state !== 'awaiting_review' ||
        current.anchor.id !== submissionId ||
        !(await this.stopped(client, context, teamId)) ||
        !(await client.query('SELECT $1::timestamptz>clock_timestamp() AS current', [current.order.body.deadlineAt]))
          .rows[0].current
      )
        return { status: 'denied' };
      const budget = await this.capacity(client, context, current);
      if (budget.model < 1 || budget.tool < 2) return { status: 'denied' };
      const old = grant(current.root.provenance.coordinator_review);
      if (current.root.provenance.coordinator_review !== undefined && !old) return { status: 'denied' };
      if (
        old &&
        old.resultDigest === current.resultDigest &&
        digest(current.root.provenance.coordinator_review_retired ?? null) ===
          digest({ owner: old.owner, fence: old.fence })
      )
        return { status: 'denied' };
      let lease: Grant;
      if (old && (await this.currentLease(client, current, { owner: old.owner, fence: old.fence }))) {
        if (old.owner !== hostId) return { status: 'pending' };
        lease = old;
      } else {
        const fence = old ? old.fence + 1 : 1;
        if (!Number.isSafeInteger(fence)) return { status: 'denied' };
        lease = {
          owner: hostId,
          fence,
          deadlineAt: await this.deadline(client, current),
          resultDigest: current.resultDigest,
          version: current.root.version,
          submissionId,
          attemptId: current.anchor.attempt_id,
        };
        await this.save(client, context, teamId, lease);
      }
      const identity: MissionReviewIdentity = {
        missionId: teamId,
        submissionId,
        attemptId: current.anchor.attempt_id,
        generation: current.root.generation,
        sessionId: context.sessionId,
        contextGeneration: context.generation,
      };
      return {
        status: 'ok',
        identity,
        lease: { owner: lease.owner, fence: lease.fence },
        deadline_at: lease.deadlineAt,
        input_id: 'cos-mission-review-' + digest({ scope: context.scopeId, identity }),
        issued_at: current.order.body.issuedAt,
      };
    });
  }
  async authorize(
    context: KnowledgeContext,
    teamId: string,
    submissionId: string,
    lease: MissionReviewLease,
    receiptOnly = false,
  ): Promise<Result> {
    if (!validLease(lease)) return { status: 'denied' };
    return this.withCurrent(context, teamId, async (client, current) => ({
      status:
        current.anchor.id === submissionId && (await this.currentLease(client, current, lease, receiptOnly))
          ? 'ok'
          : 'denied',
    }));
  }
  async renew(
    context: KnowledgeContext,
    teamId: string,
    submissionId: string,
    lease: MissionReviewLease,
  ): Promise<Result> {
    if (!validLease(lease)) return { status: 'denied' };
    return this.withCurrent(context, teamId, async (client, current) => {
      if (current.anchor.id !== submissionId || !(await this.currentLease(client, current, lease)))
        return { status: 'denied' };
      const deadlineAt = await this.deadline(client, current);
      await this.save(client, context, teamId, { ...grant(current.root.provenance.coordinator_review)!, deadlineAt });
      return { status: 'ok', deadline_at: deadlineAt };
    });
  }
  async reserve(
    context: KnowledgeContext,
    teamId: string,
    submissionId: string,
    lease: MissionReviewLease,
    callId: string,
    kind: 'model' | 'tool',
  ): Promise<Result> {
    if (
      context.origin?.kind !== 'mission_review' ||
      !validLease(lease) ||
      !id(callId) ||
      !['model', 'tool'].includes(kind)
    )
      return { status: 'denied' };
    return this.withCurrent(context, teamId, async (client, current) => {
      if (current.anchor.id !== submissionId || !(await this.currentLease(client, current, lease)))
        return { status: 'denied' };
      const payloadDigest = digest({
        role: 'team_coordinator_review',
        session: context.sessionId,
        contextGeneration: context.generation,
        generation: current.root.generation,
        resultDigest: current.resultDigest,
        lease,
        kind,
      });
      const old = (
        await client.query(
          'SELECT kind,payload_digest FROM cos.mission_team_calls WHERE scope_id=$1 AND team_id=$2 AND call_id=$3',
          [context.scopeId, teamId, callId],
        )
      ).rows[0];
      if (old)
        return old.kind === kind && old.payload_digest === payloadDigest
          ? { status: 'ok', reserved: false }
          : { status: 'conflict' };
      let stepId: string | null = null;
      for (const step of current.order.body.request.steps) {
        const usage = await teamStepUsage(client, context.scopeId, teamId, step.step_id);
        if (usage[kind] < (kind === 'model' ? step.limits.max_turns : step.limits.max_tool_calls)) {
          stepId = step.step_id;
          break;
        }
      }
      if (!stepId) return { status: 'denied' };
      await client.query(
        'INSERT INTO cos.mission_team_calls(scope_id,team_id,step_id,call_id,generation,kind,payload_digest,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          context.scopeId,
          teamId,
          stepId,
          callId,
          current.root.generation,
          kind,
          payloadDigest,
          JSON.stringify({
            role: 'coordinator_review',
            session_id: context.sessionId,
            context_generation: context.generation,
            lease,
            result_digest: current.resultDigest,
          }),
        ],
      );
      return { status: 'ok', reserved: true };
    });
  }
  async review(context: KnowledgeContext, requestId: string, input: unknown): Promise<Result> {
    const origin = context.origin;
    if (
      origin?.kind !== 'mission_review' ||
      !uuid(requestId) ||
      !validMissionReview(input) ||
      !input.mission_id.startsWith('team-')
    )
      return { status: 'denied' };
    return this.withCurrent(context, input.mission_id, async (client, current) => {
      const payloadHash = digest({ method: 'cos_team_review', generation: context.generation, review: input });
      const old = (
        await client.query(
          'SELECT scope_id,payload_hash,result FROM cos.operations WHERE session_id=$1 AND request_id=$2',
          [context.sessionId, requestId],
        )
      ).rows[0];
      if (old)
        return old.scope_id === context.scopeId && old.payload_hash === payloadHash
          ? (old.result ?? { status: 'pending' })
          : { status: 'conflict' };
      if (
        current.root.state !== 'awaiting_review' ||
        current.root.version !== input.expected_version ||
        current.resultDigest !== input.result_digest ||
        current.anchor.id !== input.submission_id
      )
        return { status: 'conflict' };
      if (
        !(await this.currentLease(client, current, { owner: origin.owner, fence: origin.fence })) ||
        !(await this.stopped(client, context, input.mission_id))
      )
        return { status: 'denied' };
      const state = checkMissionReview(input, current.checks);
      if (!state) return { status: 'denied' };
      const lease = { owner: origin.owner, fence: origin.fence };
      const charged = (
        await client.query(
          "SELECT kind,count(*)::int AS n FROM cos.mission_team_calls WHERE scope_id=$1 AND team_id=$2 AND generation=$3 AND provenance->'lease'=$4::jsonb GROUP BY kind",
          [context.scopeId, input.mission_id, current.root.generation, JSON.stringify(lease)],
        )
      ).rows;
      if ((charged.find((r) => r.kind === 'model')?.n ?? 0) < 1 || (charged.find((r) => r.kind === 'tool')?.n ?? 0) < 2)
        return { status: 'denied' };
      const inserted = await client.query(
        "INSERT INTO cos.operations(session_id,request_id,scope_id,method,payload_hash) VALUES($1,$2,$3,'cos_team_review',$4) ON CONFLICT DO NOTHING RETURNING request_id",
        [context.sessionId, requestId, context.scopeId, payloadHash],
      );
      if (!inserted.rowCount) return { status: 'conflict' };
      if (!(await settleTeamCredits(client, context.scopeId, input.mission_id, current.root.generation, 'settled')))
        throw Error('team_settlement_pending');
      const reviewId = randomUUID();
      await recordResearchExposure(client, context, current.order);
      await client.query(
        'INSERT INTO cos.mission_team_reviews(scope_id,id,team_id,generation,submission_id,result_digest,decision,checks,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          context.scopeId,
          reviewId,
          input.mission_id,
          current.root.generation,
          input.submission_id,
          input.result_digest,
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
            origin: context.origin,
          }),
        ],
      );
      await client.query(
        'UPDATE cos.mission_team_roots SET state=$3,version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2',
        [context.scopeId, input.mission_id, state],
      );
      const receipt = {
        status: 'ok',
        team_id: input.mission_id,
        submission_id: input.submission_id,
        review_id: reviewId,
        state,
        version: input.expected_version + 1,
      };
      await client.query(
        "INSERT INTO cos.outbox(id,scope_id,kind,payload) VALUES($1,$2,'team_review_notification',$3)",
        [
          'team-review-' + reviewId,
          context.scopeId,
          JSON.stringify({
            team_id: input.mission_id,
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
