import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { validCosMissionIdentity, type CosMissionIdentity } from '../../../cos-mission-boundary.js';
import { BoundedDatabase, DatabaseUnavailable } from '../store/client.js';
import { canonical, digest, type Context, type Result } from '../domain/contracts.js';
import { RESEARCH_TEMPLATE, type ResearchWorkOrder } from './work-order.js';
import type { MissionProposalStore } from './proposal-store.js';
import { queueMissionAttempt } from './attempt.js';
import { recordMissionExposure } from './exposure.js';
import { KnowledgeArtifactsBusy, type KnowledgeArtifacts } from '../knowledge/artifacts.js';
import { validMissionResult } from '../contracts/mission-result.js';
import { checkResearchResult } from './result-checks.js';

export type MissionDispatchLease = { owner: string; fence: number };
const validLease = (v: MissionDispatchLease) =>
  !!v &&
  Object.keys(v).length === 2 &&
  typeof v.owner === 'string' &&
  /^[a-zA-Z0-9_-]{1,100}$/.test(v.owner) &&
  Number.isSafeInteger(v.fence) &&
  v.fence > 0;

type MissionRow = {
  id: string;
  scope_id: string;
  state: string;
  generation: number;
  version: number;
  body: ResearchWorkOrder['body'];
  digest: string;
  proposal_id: string;
  proposal_state: string;
  applied_record_id: string;
  provenance: Record<string, unknown>;
};
type AttemptRow = {
  id: string;
  scope_id: string;
  mission_id: string;
  generation: number;
  agent_group_id: string;
  session_id: string;
  state: string;
  lease_owner: string | null;
  lease_current: boolean;
  allocation: Record<string, unknown>;
  provenance: Record<string, unknown>;
};
const id = (v: string) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const identityOf = (a: AttemptRow): CosMissionIdentity => ({
  scopeId: a.scope_id,
  missionId: a.mission_id,
  attemptId: a.id,
  generation: a.generation,
  agentGroupId: a.agent_group_id,
  sessionId: a.session_id,
  provider: 'codex',
});
const same = (a: AttemptRow | undefined, identity: CosMissionIdentity) =>
  !!a && digest(identityOf(a)) === digest(identity);
const activeAttempts = ['queued', 'allocating', 'ready', 'running'];
/** All methods are trusted host operations, not worker-supplied scope/identity RPCs.
 * Cancel/fail revoke authority first. confirmStopped records an independently verified native stop.
 * Only future allocation code may change queued -> allocating -> ready -> running.
 * completed/partial/blocked/cancelled cannot retry; failed can retry within the original approval and limits. */
export class MissionRunStore {
  constructor(
    readonly database: BoundedDatabase,
    readonly proposals: MissionProposalStore,
    readonly artifacts?: KnowledgeArtifacts,
    readonly resultHooks: { afterPublication?(): Promise<void> } = {},
  ) {}

  private async transaction(scopeId: string, operation: (client: PoolClient) => Promise<Result>): Promise<Result> {
    try {
      return await this.database.run(async (client) => {
        await client.query('BEGIN');
        const scope = await client.query('SELECT id FROM cos.scopes WHERE id=$1 FOR SHARE', [scopeId]);
        const result = scope.rowCount ? await operation(client) : { status: 'denied' as const };
        await client.query('COMMIT');
        return result;
      }, true);
    } catch (error) {
      if (error instanceof DatabaseUnavailable) return { status: error.code === 'pending' ? 'pending' : 'unavailable' };
      throw error;
    }
  }
  private async mission(client: PoolClient, scopeId: string, missionId: string): Promise<MissionRow | undefined> {
    return (
      await client.query(
        `SELECT m.*,w.body,w.digest,p.state AS proposal_state,p.applied_record_id
      FROM cos.missions m JOIN cos.mission_work_orders w ON w.scope_id=m.scope_id AND w.id=m.id
      LEFT JOIN cos.proposals p ON p.scope_id=m.scope_id AND p.id=m.proposal_id
      WHERE m.scope_id=$1 AND m.id=$2 FOR UPDATE OF m`,
        [scopeId, missionId],
      )
    ).rows[0];
  }
  private async attempt(client: PoolClient, identity: CosMissionIdentity): Promise<AttemptRow | undefined> {
    return (
      await client.query(
        'SELECT *,lease_until>clock_timestamp() AS lease_current FROM cos.mission_attempts WHERE scope_id=$1 AND mission_id=$2 AND id=$3 FOR UPDATE',
        [identity.scopeId, identity.missionId, identity.attemptId],
      )
    ).rows[0];
  }
  private async owner(client: PoolClient, context: Context, m: MissionRow | undefined): Promise<boolean> {
    if (!m || context.origin) return false;
    const o = m.body.origin;
    return (
      o.scopeId === context.scopeId &&
      o.ownerId === context.ownerId &&
      o.sessionId === context.sessionId &&
      o.agentGroupId === context.agentGroupId &&
      !!(
        await client.query('SELECT 1 FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3', [
          context.scopeId,
          context.ownerId,
          context.agentGroupId,
        ])
      ).rowCount
    );
  }
  private async capture(client: PoolClient, m: MissionRow): Promise<ResearchWorkOrder | null> {
    if (m.proposal_state !== 'applied' || m.applied_record_id !== m.id) return null;
    const o = m.body.origin;
    const context: Context = {
      scopeId: o.scopeId,
      ownerId: o.ownerId,
      sessionId: o.sessionId,
      agentGroupId: o.agentGroupId,
      ingressId: o.ingressId,
    };
    return this.proposals.captureChange(client, context, {
      kind: 'research_mission',
      mission_id: m.id,
      work_order_digest: m.digest,
      work_order: m.body,
    });
  }
  private async current(client: PoolClient, m: MissionRow): Promise<boolean> {
    return (await this.capture(client, m)) !== null;
  }
  private async usage(client: PoolClient, scopeId: string, missionId: string) {
    const rows = (
      await client.query(
        'SELECT kind,count(*)::int AS n FROM cos.mission_budget_reservations WHERE scope_id=$1 AND mission_id=$2 GROUP BY kind',
        [scopeId, missionId],
      )
    ).rows;
    return {
      attempt: rows.find((r) => r.kind === 'attempt')?.n ?? 0,
      model: rows.find((r) => r.kind === 'model')?.n ?? 0,
      tool: rows.find((r) => r.kind === 'tool')?.n ?? 0,
    };
  }
  /** Bounded host discovery, not an execution grant. Claim rechecks source access and captures exact bytes.
   * The cursor lets deferred or revoked early rows coexist with later eligible work without starvation. */
  async pendingDispatch(context: Context, after: string | null = null): Promise<Result> {
    const authority = this.proposals.authority?.(context);
    if (!authority || context.origin || (after !== null && !id(after))) return { status: 'denied' };
    return this.transaction(context.scopeId, async (client) => {
      const rows = (
        await client.query(
          `SELECT a.*, w.body, w.digest
        FROM cos.mission_attempts a
        JOIN cos.missions m ON m.scope_id=a.scope_id AND m.id=a.mission_id AND m.generation=a.generation
        JOIN cos.mission_work_orders w ON w.scope_id=m.scope_id AND w.id=m.id
        JOIN cos.proposals p ON p.scope_id=m.scope_id AND p.id=m.proposal_id
        JOIN cos.scopes s ON s.id=m.scope_id
        WHERE a.scope_id=$1 AND s.owner_id=$2 AND s.agent_group_id=$3 AND s.status='active'
          AND m.state='queued' AND a.state IN ('queued','allocating','ready')
          AND p.state='applied' AND p.applied_record_id=m.id
          AND a.allocation->>'stop_confirmed' IS DISTINCT FROM 'true'
          AND w.body->'origin'->>'scopeId'=$1 AND w.body->'origin'->>'ownerId'=$2
          AND w.body->'origin'->>'agentGroupId'=$3 AND w.body->'origin'->>'sessionId'=$4
          AND w.body->'origin'->>'contextGeneration'=$5
          AND w.body->'origin'->>'bindingDigest'=$6 AND w.body->'origin'->>'delegationDigest'=$7
          AND w.body->'provider'=$8::jsonb AND (w.body->>'deadlineAt')::timestamptz>clock_timestamp()
          AND ($9::text IS NULL OR a.id>$9)
        ORDER BY a.id LIMIT 20`,
          [
            context.scopeId,
            context.ownerId,
            context.agentGroupId,
            context.sessionId,
            authority.contextGeneration,
            authority.bindingDigest,
            authority.delegationDigest,
            JSON.stringify(authority.provider),
            after,
          ],
        )
      ).rows as Array<AttemptRow & { body: ResearchWorkOrder['body']; digest: string }>;
      const items = rows.flatMap((row) => {
        const identity = identityOf(row),
          origin = row.body.origin;
        return validCosMissionIdentity(identity) &&
          digest(row.body) === row.digest &&
          typeof origin.ingressId === 'string'
          ? [
              {
                identity,
                context: {
                  scopeId: origin.scopeId,
                  ownerId: origin.ownerId,
                  agentGroupId: origin.agentGroupId,
                  sessionId: origin.sessionId,
                  ingressId: origin.ingressId,
                },
              },
            ]
          : [];
      });
      if (digest(this.proposals.authority?.(context) ?? null) !== digest(authority)) return { status: 'denied' };
      return { status: 'ok', items, next_after: rows.length === 20 ? rows.at(-1)!.id : null };
    });
  }
  async inspect(context: Context, missionId: string): Promise<Result> {
    if (!id(missionId)) return { status: 'denied' };
    return this.transaction(context.scopeId, async (client) => {
      const m = await this.mission(client, context.scopeId, missionId);
      if (!m || !(await this.owner(client, context, m))) return { status: 'denied' };
      const attempts = (
        await client.query(
          'SELECT id,generation,state,allocation FROM cos.mission_attempts WHERE scope_id=$1 AND mission_id=$2 ORDER BY generation',
          [context.scopeId, missionId],
        )
      ).rows;
      const submission =
        (
          await client.query(
            `SELECT s.id,s.digest,r.id AS review_id,
        CASE WHEN o.id IS NULL THEN NULL ELSE COALESCE(o.payload->'delivery'->>'state','queued') END AS notification_state
        FROM cos.mission_result_submissions s
        LEFT JOIN cos.mission_reviews r ON r.scope_id=s.scope_id AND r.mission_id=s.mission_id AND r.result_id=s.id
        LEFT JOIN cos.outbox o ON o.scope_id=r.scope_id AND o.id='mission-review-' || r.id AND o.kind='mission_review_notification'
        WHERE s.scope_id=$1 AND s.mission_id=$2 AND s.generation=$3`,
            [context.scopeId, missionId, m.generation],
          )
        ).rows[0] ?? null;
      return {
        status: 'ok',
        mission: {
          id: m.id,
          state: m.state,
          generation: m.generation,
          version: m.version,
          limits: m.body.request.limits,
          deadline_at: m.body.deadlineAt,
          submission,
          usage: await this.usage(client, context.scopeId, missionId),
          attempts: attempts.map((a) => ({
            id: a.id,
            generation: a.generation,
            state: a.state,
            stop_confirmed: a.allocation.stop_confirmed === true,
          })),
        },
      };
    });
  }
  /** Exactly one caller receives reserved=true. Replays are accounting receipts, NEVER new invocation permission.
   * A pending/unavailable acknowledgement also grants no invocation. Every actual retry needs a new call ID. */
  async reserve(
    identity: CosMissionIdentity,
    callId: string,
    kind: 'model' | 'tool',
    payloadDigest: string,
  ): Promise<Result> {
    if (
      !validCosMissionIdentity(identity) ||
      !id(callId) ||
      !['model', 'tool'].includes(kind) ||
      !/^[a-f0-9]{64}$/.test(payloadDigest)
    )
      return { status: 'denied' };
    return this.transaction(identity.scopeId, async (client) => {
      const m = await this.mission(client, identity.scopeId, identity.missionId),
        a = await this.attempt(client, identity);
      if (
        !m ||
        !same(a, identity) ||
        m.generation !== identity.generation ||
        m.state !== 'running' ||
        a!.state !== 'running' ||
        !(await this.current(client, m))
      )
        return { status: 'denied' };
      return this.reserveCall(client, m, identity, callId, kind, payloadDigest);
    });
  }
  private async reserveCall(
    client: PoolClient,
    m: MissionRow,
    identity: CosMissionIdentity,
    callId: string,
    kind: 'model' | 'tool',
    payloadDigest: string,
  ): Promise<Result> {
    const old = (
      await client.query(
        'SELECT attempt_id,generation,kind,payload_digest FROM cos.mission_budget_reservations WHERE scope_id=$1 AND mission_id=$2 AND call_id=$3',
        [identity.scopeId, identity.missionId, callId],
      )
    ).rows[0];
    if (old)
      return old.attempt_id === identity.attemptId &&
        old.generation === identity.generation &&
        old.kind === kind &&
        old.payload_digest === payloadDigest
        ? { status: 'ok', reserved: false }
        : { status: 'conflict' };
    const usage = await this.usage(client, identity.scopeId, identity.missionId);
    const limit = kind === 'model' ? m.body.request.limits.max_turns : m.body.request.limits.max_tool_calls;
    if (usage[kind] >= limit) return { status: 'denied' };
    await client.query(
      'INSERT INTO cos.mission_budget_reservations(scope_id,mission_id,call_id,attempt_id,generation,kind,payload_digest) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [identity.scopeId, identity.missionId, callId, identity.attemptId, identity.generation, kind, payloadDigest],
    );
    return { status: 'ok', reserved: true };
  }
  async fail(
    identity: CosMissionIdentity,
    reason: 'provider_failed' | 'budget_exhausted' | 'deadline' | 'admission_denied' | 'allocation_failed',
  ): Promise<Result> {
    if (
      !validCosMissionIdentity(identity) ||
      !['provider_failed', 'budget_exhausted', 'deadline', 'admission_denied', 'allocation_failed'].includes(reason)
    )
      return { status: 'denied' };
    return this.transaction(identity.scopeId, async (client) => {
      const m = await this.mission(client, identity.scopeId, identity.missionId),
        a = await this.attempt(client, identity);
      if (!m || !same(a, identity) || m.generation !== identity.generation) return { status: 'denied' };
      if (m.state === 'failed' && a!.state === 'failed') return { status: 'ok' };
      if (!['queued', 'running'].includes(m.state) || !activeAttempts.includes(a!.state)) return { status: 'denied' };
      await client.query(
        "UPDATE cos.mission_attempts SET state='failed',lease_owner=NULL,lease_until=NULL,provenance=provenance||$3::jsonb,version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
        [identity.scopeId, identity.attemptId, JSON.stringify({ failure_reason: reason })],
      );
      await client.query(
        "UPDATE cos.missions SET state='failed',version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
        [identity.scopeId, identity.missionId],
      );
      return { status: 'ok' };
    });
  }
  async retry(context: Context, failedAttemptId: string): Promise<Result> {
    if (!id(failedAttemptId) || context.origin) return { status: 'denied' };
    return this.transaction(context.scopeId, async (client) => {
      const previous = (
        await client.query('SELECT * FROM cos.mission_attempts WHERE scope_id=$1 AND id=$2', [
          context.scopeId,
          failedAttemptId,
        ])
      ).rows[0] as AttemptRow | undefined;
      if (!previous) return { status: 'denied' };
      const m = await this.mission(client, context.scopeId, previous.mission_id);
      if (
        !m ||
        !(await this.owner(client, context, m)) ||
        !['failed', 'queued', 'running'].includes(m.state) ||
        !(await this.current(client, m))
      )
        return { status: 'denied' };
      const existing = (
        await client.query('SELECT * FROM cos.mission_attempts WHERE scope_id=$1 AND mission_id=$2 AND generation=$3', [
          context.scopeId,
          m.id,
          previous.generation + 1,
        ])
      ).rows[0] as AttemptRow | undefined;
      if (existing)
        return existing.provenance.retry_of === failedAttemptId &&
          existing.generation === m.generation &&
          activeAttempts.includes(existing.state)
          ? { status: 'ok', identity: identityOf(existing) }
          : { status: 'denied' };
      // Re-read under the parent lock: an in-flight cancellation/stop may have changed the initial lookup.
      const a = await this.attempt(client, identityOf(previous));
      if (
        !a ||
        m.state !== 'failed' ||
        m.generation !== a.generation ||
        a.state !== 'failed' ||
        a.allocation.stop_confirmed !== true
      )
        return { status: 'denied' };
      const usage = await this.usage(client, context.scopeId, m.id),
        limits = m.body.request.limits;
      if (
        usage.attempt >= limits.max_attempts ||
        usage.model >= limits.max_turns ||
        usage.tool >= limits.max_tool_calls
      )
        return { status: 'denied' };
      const active = await client.query(
        "SELECT 1 FROM cos.mission_attempts WHERE scope_id=$1 AND mission_id=$2 AND (state IN ('queued','allocating','ready','running','submitted') OR allocation->>'stop_confirmed' IS DISTINCT FROM 'true') LIMIT 1",
        [context.scopeId, m.id],
      );
      if (active.rowCount) return { status: 'denied' };
      const identity = await queueMissionAttempt(client, context.scopeId, m.id, m.generation + 1, m.digest, {
        ...m.provenance,
        retry_of: failedAttemptId,
      });
      return { status: 'ok', identity };
    });
  }
  /** Owner stop remains available after source revocation or a paused scope. It cannot grant any capability. */
  async cancel(context: Context, missionId: string): Promise<Result> {
    if (!id(missionId) || context.origin) return { status: 'denied' };
    return this.transaction(context.scopeId, async (client) => {
      const m = await this.mission(client, context.scopeId, missionId);
      if (!m || !(await this.owner(client, context, m))) return { status: 'denied' };
      if (['cancelling', 'cancelled'].includes(m.state)) return { status: 'ok', state: m.state };
      if (['completed', 'partial', 'blocked'].includes(m.state)) return { status: 'denied' };
      await client.query(
        "UPDATE cos.mission_attempts SET state='cancelled',lease_owner=NULL,lease_until=NULL,version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND mission_id=$2 AND state<>'cancelled'",
        [context.scopeId, missionId],
      );
      const pending = await client.query(
        "SELECT 1 FROM cos.mission_attempts WHERE scope_id=$1 AND mission_id=$2 AND allocation->>'stop_confirmed' IS DISTINCT FROM 'true' LIMIT 1",
        [context.scopeId, missionId],
      );
      const state = pending.rowCount ? 'cancelling' : 'cancelled';
      await client.query(
        'UPDATE cos.missions SET state=$3,generation=generation+1,version=version+1,provenance=provenance||$4::jsonb,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2',
        [
          context.scopeId,
          missionId,
          state,
          JSON.stringify({ cancel_ingress_id: context.ingressId, cancel_owner_id: context.ownerId }),
        ],
      );
      await client.query(
        "UPDATE cos.proposals SET state=CASE WHEN state='pending' THEN 'rejected' ELSE 'conflict' END,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2 AND state IN ('pending','approved')",
        [context.scopeId, m.proposal_id],
      );
      await client.query(
        "UPDATE cos.outbox SET delivered_at=clock_timestamp() WHERE scope_id=$1 AND payload->>'proposal_id'=$2 AND kind IN ('approval_preview','proposal_apply') AND delivered_at IS NULL",
        [context.scopeId, m.proposal_id],
      );
      return { status: 'ok', state };
    });
  }
  /** Caller must verify the exact native container is absent/stopped; this is not a worker assertion. */
  async confirmStopped(identity: CosMissionIdentity): Promise<Result> {
    if (!validCosMissionIdentity(identity)) return { status: 'denied' };
    return this.transaction(identity.scopeId, async (client) => {
      const m = await this.mission(client, identity.scopeId, identity.missionId),
        a = await this.attempt(client, identity);
      if (!m || !same(a, identity) || !['failed', 'cancelled', 'submitted'].includes(a!.state))
        return { status: 'denied' };
      if (a!.allocation.stop_confirmed !== true)
        await client.query(
          'UPDATE cos.mission_attempts SET allocation=allocation||\'{"stop_confirmed":true}\'::jsonb,version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2',
          [identity.scopeId, identity.attemptId],
        );
      if (m.state === 'cancelling') {
        const pending = await client.query(
          "SELECT 1 FROM cos.mission_attempts WHERE scope_id=$1 AND mission_id=$2 AND allocation->>'stop_confirmed' IS DISTINCT FROM 'true' LIMIT 1",
          [identity.scopeId, identity.missionId],
        );
        if (!pending.rowCount)
          await client.query(
            "UPDATE cos.missions SET state='cancelled',version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
            [identity.scopeId, identity.missionId],
          );
      }
      return { status: 'ok' };
    });
  }
  /** Host recovery metadata remains readable after authority loss; it never grants execution or returns source bytes. */
  async inspectRecovery(identity: CosMissionIdentity): Promise<Result> {
    if (!validCosMissionIdentity(identity)) return { status: 'denied' };
    return this.transaction(identity.scopeId, async (client) => {
      const m = await this.mission(client, identity.scopeId, identity.missionId),
        a = await this.attempt(client, identity);
      if (!m || !same(a, identity) || digest(m.body) !== m.digest) return { status: 'denied' };
      const o = m.body.origin;
      const context: Context = {
        scopeId: o.scopeId,
        ownerId: o.ownerId,
        agentGroupId: o.agentGroupId,
        sessionId: o.sessionId,
        ingressId: o.ingressId,
      };
      if (!(await this.owner(client, context, m))) return { status: 'denied' };
      return {
        status: 'ok',
        identity: identityOf(a!),
        context,
        state: m.state,
        attempt_state: a!.state,
        current_generation: m.generation === identity.generation,
        admitted: await this.current(client, m),
        stop_confirmed: a!.allocation.stop_confirmed === true,
      };
    });
  }
  /** Lease acquisition never creates another attempt or refreshes its deadline/budget. */
  async claimDispatch(context: Context, attemptId: string, owner: string): Promise<Result> {
    if (!id(attemptId) || !id(owner) || context.origin) return { status: 'denied' };
    return this.transaction(context.scopeId, async (client) => {
      const lookup = (
        await client.query('SELECT * FROM cos.mission_attempts WHERE scope_id=$1 AND id=$2', [
          context.scopeId,
          attemptId,
        ])
      ).rows[0] as AttemptRow | undefined;
      if (!lookup) return { status: 'denied' };
      const m = await this.mission(client, context.scopeId, lookup.mission_id),
        a = await this.attempt(client, identityOf(lookup));
      if (
        !m ||
        !a ||
        !(await this.owner(client, context, m)) ||
        m.state !== 'queued' ||
        m.generation !== a.generation ||
        !['queued', 'allocating', 'ready'].includes(a.state) ||
        m.proposal_state !== 'applied' ||
        m.applied_record_id !== m.id
      )
        return { status: 'denied' };
      if (a.lease_current && a.lease_owner !== owner) return { status: 'pending' };
      const origin = m.body.origin;
      const order = await this.proposals.captureChange(
        client,
        {
          scopeId: origin.scopeId,
          ownerId: origin.ownerId,
          agentGroupId: origin.agentGroupId,
          sessionId: origin.sessionId,
          ingressId: origin.ingressId,
        },
        { kind: 'research_mission', mission_id: m.id, work_order_digest: m.digest, work_order: m.body },
      );
      if (!order) return { status: 'denied' };
      const oldFence = a.allocation.dispatch_fence ?? 0;
      if (!Number.isSafeInteger(oldFence) || Number(oldFence) < 0 || Number(oldFence) >= Number.MAX_SAFE_INTEGER)
        return { status: 'denied' };
      const fence = a.lease_current && a.lease_owner === owner ? Number(oldFence) : Number(oldFence) + 1;
      if (fence < 1) return { status: 'denied' };
      // Persist conservative exposure before host files/provider state can be materialized.
      await recordMissionExposure(client, identityOf(a), order);
      const updated = (
        await client.query(
          "UPDATE cos.mission_attempts SET state=CASE WHEN state='queued' THEN 'allocating' ELSE state END,lease_owner=$3,lease_until=clock_timestamp()+interval '30 seconds',allocation=allocation||$4::jsonb,version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2 RETURNING input_id",
          [context.scopeId, attemptId, owner, JSON.stringify({ dispatch_fence: fence })],
        )
      ).rows[0];
      return { status: 'ok', identity: identityOf(a), inputId: updated.input_id, order, lease: { owner, fence } };
    });
  }
  private async dispatchCurrent(
    client: PoolClient,
    identity: CosMissionIdentity,
    lease: MissionDispatchLease,
    receipt = false,
  ) {
    const m = await this.mission(client, identity.scopeId, identity.missionId),
      a = await this.attempt(client, identity);
    if (
      !m ||
      !a ||
      !same(a, identity) ||
      m.generation !== identity.generation ||
      a.allocation.stop_confirmed === true ||
      (!(receipt && m.state === 'awaiting_review' && a.state === 'submitted') &&
        (!['queued', 'running'].includes(m.state) || !['allocating', 'ready', 'running'].includes(a.state))) ||
      a.lease_owner !== lease.owner ||
      !a.lease_current ||
      a.allocation.dispatch_fence !== lease.fence
    )
      return null;
    const order = await this.capture(client, m);
    return order ? { mission: m, attempt: a, order } : null;
  }
  async authorizeDispatch(identity: CosMissionIdentity, lease: MissionDispatchLease): Promise<Result> {
    if (!validCosMissionIdentity(identity) || !validLease(lease)) return { status: 'denied' };
    return this.transaction(identity.scopeId, async (client) => ({
      status: (await this.dispatchCurrent(client, identity, lease)) ? 'ok' : 'denied',
    }));
  }
  /** Allows acknowledgement of an accepted submission, but never a new launch/model/context reservation. */
  async authorizeWorker(identity: CosMissionIdentity, lease: MissionDispatchLease): Promise<Result> {
    if (!validCosMissionIdentity(identity) || !validLease(lease)) return { status: 'denied' };
    return this.transaction(identity.scopeId, async (client) => {
      const current = await this.dispatchCurrent(client, identity, lease, true);
      return { status: current && ['running', 'submitted'].includes(current.attempt.state) ? 'ok' : 'denied' };
    });
  }
  async submitResult(
    identity: CosMissionIdentity,
    lease: MissionDispatchLease,
    requestId: string,
    callId: string,
    result: unknown,
  ): Promise<Result> {
    if (
      !this.artifacts ||
      !validCosMissionIdentity(identity) ||
      !validLease(lease) ||
      !id(callId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) ||
      !validMissionResult(result)
    )
      return { status: 'denied' };
    const artifacts = this.artifacts,
      resultDigest = digest(result);
    const existing = async (client: PoolClient): Promise<Result | null> => {
      const old = (
        await client.query(
          `SELECT s.id,s.digest,s.body,s.artifact_id,a.digest AS artifact_digest,a.lifecycle
        FROM cos.mission_result_submissions s JOIN cos.artifacts a ON a.scope_id=s.scope_id AND a.id=s.artifact_id
        WHERE s.scope_id=$1 AND s.attempt_id=$2`,
          [identity.scopeId, identity.attemptId],
        )
      ).rows[0];
      if (!old) return null;
      if (old.body.request_id !== requestId || old.digest !== resultDigest) return { status: 'conflict' };
      if (
        old.lifecycle !== 'published' ||
        digest(JSON.parse(artifacts.read(old.artifact_id, old.artifact_digest))) !== resultDigest
      )
        return { status: 'denied' };
      return { status: 'ok', state: 'awaiting_review', submission_id: old.id };
    };
    try {
      return await artifacts.exclusive(async (artifactLease) => {
        const before = await this.transaction(identity.scopeId, async (client) => {
          const current = await this.dispatchCurrent(client, identity, lease, true);
          if (!current) return { status: 'denied' };
          const previous = await existing(client);
          if (previous) return previous;
          if (current.mission.state !== 'running' || current.attempt.state !== 'running') return { status: 'denied' };
          const checks = checkResearchResult(current.order, result);
          if (checks.status !== 'review_required') return { status: 'denied' };
          const reserved = await this.reserveCall(
            client,
            current.mission,
            identity,
            callId,
            'tool',
            digest({ method: 'cos_result_submit', requestId, resultDigest, workOrder: current.order.digest }),
          );
          if (reserved.status !== 'ok') return reserved;
          return reserved.reserved === true ? { status: 'ok', checks } : { status: 'pending' };
        });
        if (before.status !== 'ok' || before.submission_id) return before;
        const captured = artifacts.publishText(
          digest({ kind: 'mission_result', identity, requestId }),
          canonical(result),
          artifactLease,
        );
        await this.resultHooks.afterPublication?.();
        return this.transaction(identity.scopeId, async (client) => {
          // Pair publication with the existing orphan-cleanup barrier, including uncertain commits.
          await client.query('SELECT pg_advisory_xact_lock(73101004)');
          const current = await this.dispatchCurrent(client, identity, lease, true);
          if (!current) return { status: 'denied' };
          const previous = await existing(client);
          if (previous) return previous;
          if (current.mission.state !== 'running' || current.attempt.state !== 'running') return { status: 'denied' };
          const checks = checkResearchResult(current.order, result);
          if (checks.status !== 'review_required' || digest(checks) !== digest(before.checks))
            return { status: 'denied' };
          // Verify published bytes again before their durable metadata can be accepted.
          if (digest(JSON.parse(artifacts.read(captured.id, captured.digest))) !== resultDigest)
            return { status: 'denied' };
          const submissionId = randomUUID();
          await client.query(
            `INSERT INTO cos.artifacts(id,scope_id,kind,digest,byte_length,lifecycle,provenance)
            VALUES($1,$2,'mission_result',$3,$4,'published',$5)`,
            [
              captured.id,
              identity.scopeId,
              captured.digest,
              captured.byteLength,
              JSON.stringify({
                mission_id: identity.missionId,
                attempt_id: identity.attemptId,
                generation: identity.generation,
                session_id: identity.sessionId,
                context_generation: identity.attemptId,
                processing_provider: identity.provider,
                submission_id: submissionId,
                work_order_digest: current.order.digest,
                result_digest: resultDigest,
              }),
            ],
          );
          await recordMissionExposure(client, identity, current.order);
          await client.query(
            `INSERT INTO cos.derivation_links(scope_id,artifact_id,evidence_id)
            SELECT scope_id,$1,id FROM cos.evidence_refs WHERE scope_id=$2 AND session_id=$3 AND context_generation=$4 AND processing_provider='codex'
            ON CONFLICT DO NOTHING`,
            [captured.id, identity.scopeId, identity.sessionId, identity.attemptId],
          );
          await client.query(
            `INSERT INTO cos.mission_result_submissions(scope_id,id,mission_id,attempt_id,generation,body,digest,artifact_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              identity.scopeId,
              submissionId,
              identity.missionId,
              identity.attemptId,
              identity.generation,
              JSON.stringify({ request_id: requestId, checks, artifact_digest: captured.digest }),
              resultDigest,
              captured.id,
            ],
          );
          await client.query(
            "UPDATE cos.mission_attempts SET state='submitted',version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
            [identity.scopeId, identity.attemptId],
          );
          await client.query(
            "UPDATE cos.missions SET state='awaiting_review',version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
            [identity.scopeId, identity.missionId],
          );
          return { status: 'ok', state: 'awaiting_review', submission_id: submissionId };
        });
      });
    } catch (error) {
      if (error instanceof KnowledgeArtifactsBusy) return { status: 'unavailable' };
      throw error;
    }
  }
  /** Fresh disclosure and its root reservation share a transaction. A replay is not another disclosure grant. */
  async readContext(identity: CosMissionIdentity, lease: MissionDispatchLease, callId: string): Promise<Result> {
    if (!validCosMissionIdentity(identity) || !validLease(lease) || !id(callId)) return { status: 'denied' };
    return this.transaction(identity.scopeId, async (client) => {
      const current = await this.dispatchCurrent(client, identity, lease);
      if (!current || current.mission.state !== 'running' || current.attempt.state !== 'running')
        return { status: 'denied' };
      const reservation = await this.reserveCall(
        client,
        current.mission,
        identity,
        callId,
        'tool',
        digest({ method: 'cos_mission_context_get', work_order: current.order.digest }),
      );
      if (reservation.status !== 'ok') return reservation;
      if (reservation.reserved !== true) return { status: 'pending' };
      await recordMissionExposure(client, identity, current.order);
      return {
        status: 'ok',
        work_order: current.order.body,
        context: current.order.context,
        template: RESEARCH_TEMPLATE,
      };
    });
  }
  async markDispatchReady(
    identity: CosMissionIdentity,
    lease: MissionDispatchLease,
    receiptDigest: string,
  ): Promise<Result> {
    if (!validCosMissionIdentity(identity) || !validLease(lease) || !/^[a-f0-9]{64}$/.test(receiptDigest))
      return { status: 'denied' };
    return this.transaction(identity.scopeId, async (client) => {
      const current = await this.dispatchCurrent(client, identity, lease);
      if (!current || !['allocating', 'ready'].includes(current.attempt.state)) return { status: 'denied' };
      const existing = current.attempt.allocation.native_receipt;
      if (existing && existing !== receiptDigest) return { status: 'conflict' };
      await client.query(
        "UPDATE cos.mission_attempts SET state='ready',allocation=allocation||$3::jsonb,version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
        [identity.scopeId, identity.attemptId, JSON.stringify({ native_receipt: receiptDigest })],
      );
      return { status: 'ok' };
    });
  }
  /** Called by the restricted launch hook immediately before native spawning, never by an approval callback. */
  async beginExecution(identity: CosMissionIdentity, lease: MissionDispatchLease): Promise<Result> {
    if (!validCosMissionIdentity(identity) || !validLease(lease)) return { status: 'denied' };
    return this.transaction(identity.scopeId, async (client) => {
      const current = await this.dispatchCurrent(client, identity, lease);
      if (
        !current ||
        !['ready', 'running'].includes(current.attempt.state) ||
        typeof current.attempt.allocation.native_receipt !== 'string'
      )
        return { status: 'denied' };
      if (current.attempt.state === 'running') return { status: 'ok' };
      await client.query(
        "UPDATE cos.mission_attempts SET state='running',version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
        [identity.scopeId, identity.attemptId],
      );
      await client.query(
        "UPDATE cos.missions SET state='running',version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
        [identity.scopeId, identity.missionId],
      );
      return { status: 'ok' };
    });
  }
  /** Keeps an existing allocation/execution lease alive; an expired fence can never be revived. */
  async renewDispatch(identity: CosMissionIdentity, lease: MissionDispatchLease): Promise<Result> {
    if (!validCosMissionIdentity(identity) || !validLease(lease)) return { status: 'denied' };
    return this.transaction(identity.scopeId, async (client) => {
      if (!(await this.dispatchCurrent(client, identity, lease))) return { status: 'denied' };
      await client.query(
        "UPDATE cos.mission_attempts SET lease_until=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
        [identity.scopeId, identity.attemptId],
      );
      return { status: 'ok' };
    });
  }
}
