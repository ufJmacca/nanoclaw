import type { PoolClient } from 'pg';
import { digest, type Result } from '../domain/contracts.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import type { MissionReviews, ReviewSnapshot } from './review-store.js';

export type MissionReviewLease = { owner: string; fence: number };
export type MissionReviewIdentity = {
  missionId: string;
  submissionId: string;
  attemptId: string;
  generation: number;
  sessionId: string;
  contextGeneration: string;
};
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const validLease = (v: unknown): v is MissionReviewLease =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === 2 &&
  id((v as MissionReviewLease).owner) &&
  Number.isSafeInteger((v as MissionReviewLease).fence) &&
  (v as MissionReviewLease).fence > 0;
type StoredLease = MissionReviewLease & { deadlineAt: string };
const storedLease = (v: unknown): v is StoredLease =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === 3 &&
  validLease({ owner: (v as StoredLease).owner, fence: (v as StoredLease).fence }) &&
  typeof (v as StoredLease).deadlineAt === 'string' &&
  Number.isFinite(Date.parse((v as StoredLease).deadlineAt));

/** Receipt access may finish the tool response after completion, but never grants another model/tool invocation. */
export async function currentReviewLease(
  client: PoolClient,
  current: ReviewSnapshot,
  lease: MissionReviewLease,
  receiptOnly = false,
): Promise<boolean> {
  const stored = current.submission.allocation.coordinator_review;
  const states = receiptOnly ? ['awaiting_review', 'completed', 'partial', 'blocked'] : ['awaiting_review'];
  return (
    validLease(lease) &&
    storedLease(stored) &&
    stored.owner === lease.owner &&
    stored.fence === lease.fence &&
    states.includes(current.mission.state) &&
    current.submission.allocation.stop_confirmed === true &&
    (
      await client.query(
        'SELECT $1::timestamptz > clock_timestamp() AND $1::timestamptz <= $2::timestamptz AS current',
        [stored.deadlineAt, current.order.body.deadlineAt],
      )
    ).rows[0].current
  );
}

/** Only the trusted host may acquire these grants, after establishing that the shared main session is idle.
 * Review never allocates another AgentGroup/context, renews the mission deadline, or creates a new attempt. */
export class MissionReviewRuns {
  constructor(readonly reviews: MissionReviews) {}
  private async live(client: PoolClient, current: ReviewSnapshot): Promise<boolean> {
    return (
      current.mission.state === 'awaiting_review' &&
      current.submission.allocation.stop_confirmed === true &&
      (await client.query('SELECT $1::timestamptz > clock_timestamp() AS current', [current.order.body.deadlineAt]))
        .rows[0].current
    );
  }
  private async usage(client: PoolClient, context: KnowledgeContext, missionId: string) {
    const rows = (
      await client.query(
        'SELECT kind,count(*)::int AS n FROM cos.mission_budget_reservations WHERE scope_id=$1 AND mission_id=$2 GROUP BY kind',
        [context.scopeId, missionId],
      )
    ).rows;
    return { model: rows.find((r) => r.kind === 'model')?.n ?? 0, tool: rows.find((r) => r.kind === 'tool')?.n ?? 0 };
  }
  private async currentLease(client: PoolClient, current: ReviewSnapshot, lease: MissionReviewLease) {
    return currentReviewLease(client, current, lease);
  }
  private async deadline(client: PoolClient, current: ReviewSnapshot): Promise<string> {
    return (
      await client.query("SELECT LEAST($1::timestamptz,clock_timestamp()+interval '30 seconds') AS deadline", [
        current.order.body.deadlineAt,
      ])
    ).rows[0].deadline.toISOString();
  }
  private async save(client: PoolClient, context: KnowledgeContext, current: ReviewSnapshot, lease: StoredLease) {
    await client.query(
      "UPDATE cos.mission_attempts SET allocation=jsonb_set(allocation,'{coordinator_review}',$3::jsonb),updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
      [context.scopeId, current.submission.attempt_id, JSON.stringify(lease)],
    );
  }
  async claim(context: KnowledgeContext, missionId: string, submissionId: string, hostId: string): Promise<Result> {
    if (context.origin || !id(hostId)) return { status: 'denied' };
    return this.reviews.withCurrentSubmission(context, missionId, submissionId, async (client, current) => {
      if (!(await this.live(client, current))) return { status: 'denied' };
      const limits = current.order.body.request.limits,
        usage = await this.usage(client, context, missionId);
      // A fresh automatic review needs at least a model turn, result read and recorded judgement.
      if (usage.model >= limits.max_turns || usage.tool + 2 > limits.max_tool_calls) return { status: 'denied' };
      const old = current.submission.allocation.coordinator_review;
      if (old !== undefined && !storedLease(old)) return { status: 'denied' };
      let lease: StoredLease;
      if (old && (await this.currentLease(client, current, { owner: old.owner, fence: old.fence }))) {
        if (old.owner !== hostId) return { status: 'pending' };
        lease = old;
      } else {
        const fence = old ? old.fence + 1 : 1;
        if (!Number.isSafeInteger(fence)) return { status: 'denied' };
        lease = { owner: hostId, fence, deadlineAt: await this.deadline(client, current) };
        await this.save(client, context, current, lease);
      }
      const identity: MissionReviewIdentity = {
        missionId,
        submissionId,
        attemptId: current.submission.attempt_id,
        generation: current.submission.generation,
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
    missionId: string,
    submissionId: string,
    lease: MissionReviewLease,
    receiptOnly = false,
  ): Promise<Result> {
    if (!validLease(lease)) return { status: 'denied' };
    return this.reviews.withCurrentSubmission(context, missionId, submissionId, async (client, current) => ({
      status: (await currentReviewLease(client, current, lease, receiptOnly)) ? 'ok' : 'denied',
    }));
  }
  async renew(
    context: KnowledgeContext,
    missionId: string,
    submissionId: string,
    lease: MissionReviewLease,
  ): Promise<Result> {
    if (!validLease(lease)) return { status: 'denied' };
    return this.reviews.withCurrentSubmission(context, missionId, submissionId, async (client, current) => {
      if (!(await this.currentLease(client, current, lease))) return { status: 'denied' };
      const deadlineAt = await this.deadline(client, current);
      await this.save(client, context, current, { ...lease, deadlineAt });
      return { status: 'ok', deadline_at: deadlineAt };
    });
  }
  async reserve(
    context: KnowledgeContext,
    missionId: string,
    submissionId: string,
    lease: MissionReviewLease,
    callId: string,
    kind: 'model' | 'tool',
  ): Promise<Result> {
    if (!validLease(lease) || !id(callId) || !['model', 'tool'].includes(kind)) return { status: 'denied' };
    return this.reviews.withCurrentSubmission(context, missionId, submissionId, async (client, current) => {
      if (!(await this.currentLease(client, current, lease))) return { status: 'denied' };
      const hash = digest({
        role: 'coordinator_review',
        session: context.sessionId,
        generation: context.generation,
        lease,
        kind,
      });
      const old = (
        await client.query(
          'SELECT attempt_id,generation,kind,payload_digest FROM cos.mission_budget_reservations WHERE scope_id=$1 AND mission_id=$2 AND call_id=$3',
          [context.scopeId, missionId, callId],
        )
      ).rows[0];
      if (old)
        return old.attempt_id === current.submission.attempt_id &&
          old.generation === current.submission.generation &&
          old.kind === kind &&
          old.payload_digest === hash
          ? { status: 'ok', reserved: false }
          : { status: 'conflict' };
      const usage = await this.usage(client, context, missionId),
        limits = current.order.body.request.limits;
      if (usage[kind] >= (kind === 'model' ? limits.max_turns : limits.max_tool_calls)) return { status: 'denied' };
      await client.query(
        'INSERT INTO cos.mission_budget_reservations(scope_id,mission_id,call_id,attempt_id,generation,kind,payload_digest) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [context.scopeId, missionId, callId, current.submission.attempt_id, current.submission.generation, kind, hash],
      );
      return { status: 'ok', reserved: true };
    });
  }
}
