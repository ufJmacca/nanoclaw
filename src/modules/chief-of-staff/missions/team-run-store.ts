import type { PoolClient } from 'pg';
import { BoundedDatabase, DatabaseUnavailable } from '../store/client.js';
import { digest, type Context, type Result } from '../domain/contracts.js';
import type { MissionChange } from '../contracts/protocol.js';
import type { KnowledgeStore } from '../knowledge/store.js';
import type { TeamProposalStore } from './team-proposal-store.js';
import { sealTeamChildWorkOrder, validateTeamChildWorkOrder, type TeamChildWorkOrder } from './team-work-order.js';
import type { TeamInputArtifact } from '../contracts/team-inputs.js';
import type { TeamStep } from '../contracts/team-protocol.js';
import { validMissionResult } from '../contracts/mission-result.js';
import { readVerifiedSubmission } from './submission-reader.js';
import { validCosMissionIdentity } from '../../../cos-mission-boundary.js';
import { queueMissionAttempt } from './attempt.js';
import {
  defaultMissionWorkerCapacity,
  missionWorkerCapacity,
  lockMissionWorkerAdmission,
  missionWorkerOccupancy,
  type MissionWorkerCapacity,
} from './worker-admission.js';

const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
type CurrentTeam = {
  row: { id: string; generation: number; state: string };
  order: NonNullable<Awaited<ReturnType<TeamProposalStore['captureChange']>>>;
};
/** One host pool, parent-before-child locking and bounded credit escrow. No model/container wait occurs here. */
export class TeamRunStore {
  readonly workerCapacity: number;
  constructor(
    readonly database: BoundedDatabase,
    readonly proposals: TeamProposalStore,
    readonly knowledge?: KnowledgeStore,
    capacity: MissionWorkerCapacity = defaultMissionWorkerCapacity(),
  ) {
    this.workerCapacity = missionWorkerCapacity(capacity);
  }
  private async transaction(
    context: Context,
    operation: (client: PoolClient) => Promise<Result>,
    admission = true,
  ): Promise<Result> {
    if (context.origin) return { status: 'denied' };
    try {
      return await this.database.run(async (client) => {
        await client.query('BEGIN');
        const scope = await client.query(
          "SELECT id FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 AND (NOT $4::boolean OR status='active') FOR SHARE",
          [context.scopeId, context.ownerId, context.agentGroupId, admission],
        );
        const result = scope.rowCount ? await operation(client) : { status: 'denied' as const };
        await client.query('COMMIT');
        return result;
      }, true);
    } catch (error) {
      if (error instanceof DatabaseUnavailable) return { status: error.code === 'pending' ? 'pending' : 'unavailable' };
      throw error;
    }
  }
  private async root(client: PoolClient, context: Context, teamId: string, execution = true) {
    const row = (
      await client.query(
        `SELECT r.*,w.body,w.digest,p.state AS proposal_state,p.applied_record_id
      FROM cos.mission_team_roots r JOIN cos.mission_team_work_orders w ON w.scope_id=r.scope_id AND w.id=r.id
      JOIN cos.proposals p ON p.scope_id=r.scope_id AND p.id=r.proposal_id
      WHERE r.scope_id=$1 AND r.id=$2 FOR UPDATE OF r`,
        [context.scopeId, teamId],
      )
    ).rows[0];
    if (
      !row ||
      row.proposal_state !== 'applied' ||
      row.applied_record_id !== teamId ||
      row.generation < 1 ||
      !['queued', 'running', 'awaiting_review'].includes(row.state)
    )
      return null;
    const order = await this.proposals.captureChange(
      client,
      context,
      { kind: 'specialist_team', team_id: teamId, work_order_digest: row.digest, work_order: row.body },
      execution,
    );
    return order ? { row, order } : null;
  }
  /** Stable child creation is an intent, not a launch. Existing native MissionHost owns all resulting attempts. */
  async claimReady(context: Context, teamId: string): Promise<Result> {
    if (!id(teamId)) return { status: 'denied' };
    return this.transaction(context, async (client) => {
      // Serialise global team credit-to-native-slot admission before any root/child lock.
      await lockMissionWorkerAdmission(client);
      const current = await this.root(client, context, teamId);
      if (!current) return { status: 'denied' };
      const { active } = await missionWorkerOccupancy(client);
      const rootActive = (
        await client.query(
          `SELECT count(DISTINCT a.id)::int AS n FROM cos.mission_team_steps s
        JOIN cos.mission_attempts a ON a.scope_id=s.scope_id AND a.mission_id=s.child_mission_id
        WHERE s.scope_id=$1 AND s.team_id=$2 AND a.allocation->>'stop_confirmed' IS DISTINCT FROM 'true'`,
          [context.scopeId, teamId],
        )
      ).rows[0].n;
      let available = Math.max(
        0,
        Math.min(this.workerCapacity - active, current.order.body.request.limits.max_concurrent_workers - rootActive),
      );
      const ready = (
        await client.query(
          "SELECT * FROM cos.mission_team_steps WHERE scope_id=$1 AND team_id=$2 AND state='ready' ORDER BY step_id FOR UPDATE",
          [context.scopeId, teamId],
        )
      ).rows;
      const prepared = new Map<string, TeamChildWorkOrder>();
      // Validate every ready row before the first mutation. A denied admission must not have created a child.
      for (const row of ready) {
        const step = current.order.body.request.steps.find((s) => s.step_id === row.step_id);
        if (!step || digest(step) !== digest(row.definition) || row.child_mission_id !== null)
          return { status: 'denied' };
        const artifacts = await this.inputs(client, context, current, step, new Set([step.step_id]));
        if (!artifacts) return { status: 'denied' };
        prepared.set(
          step.step_id,
          sealTeamChildWorkOrder({
            missionId:
              'mission-' +
              digest({ scope: context.scopeId, team: teamId, generation: current.row.generation, step: step.step_id }),
            stepId: step.step_id,
            rootGeneration: current.row.generation,
            approved: current.order,
            artifacts,
          }),
        );
        if (
          !(
            await client.query('SELECT $1::timestamptz > clock_timestamp() AS current', [
              prepared.get(step.step_id)!.body.deadlineAt,
            ])
          ).rows[0].current
        )
          return { status: 'denied' };
        const reservation = (
          await client.query(
            "SELECT * FROM cos.mission_team_reservations WHERE scope_id=$1 AND team_id=$2 AND step_id=$3 AND state='reserved' FOR UPDATE",
            [context.scopeId, teamId, step.step_id],
          )
        ).rows[0];
        if (
          !reservation ||
          reservation.max_attempts !== step.limits.max_attempts + step.max_rework_count ||
          reservation.max_turns !== step.limits.max_turns ||
          reservation.max_tool_calls !== step.limits.max_tool_calls
        )
          return { status: 'denied' };
      }
      const created: string[] = [];
      for (const row of ready) {
        if (available <= 0) break;
        const step = current.order.body.request.steps.find((s) => s.step_id === row.step_id);
        if (!step) throw Error('team_step_integrity');
        const order = prepared.get(step.step_id)!,
          missionId = order.body.missionId;
        const provenance = {
          team_id: teamId,
          team_generation: current.row.generation,
          step_id: step.step_id,
          parent_proposal_id: current.row.proposal_id,
          owner_id: context.ownerId,
          decision_ingress_id: current.row.provenance.decision_ingress_id,
          work_order_digest: order.digest,
        };
        const manifest = {
          format: 'cos-team-child-manifest/v1',
          sources: order.context.sources.map(({ chunks, ...source }) => ({
            ...source,
            chunks: chunks.map(({ text, ...locator }) => ({ ...locator, digest: digest(text) })),
          })),
          artifacts: order.context.artifacts.map((a) =>
            a.state === 'submitted' ? (({ result: _result, ...locator }) => locator)(a) : a,
          ),
        };
        await client.query(
          'INSERT INTO cos.mission_context_manifests(scope_id,digest,body,provenance) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [context.scopeId, order.body.contextDigest, JSON.stringify(manifest), JSON.stringify(provenance)],
        );
        await client.query(
          'INSERT INTO cos.mission_work_orders(scope_id,id,body,digest,context_digest,template_id,template_version,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            context.scopeId,
            missionId,
            JSON.stringify(order.body),
            order.digest,
            order.body.contextDigest,
            order.body.template.id,
            order.body.template.version,
            JSON.stringify(provenance),
          ],
        );
        await client.query("INSERT INTO cos.missions(scope_id,id,state,provenance) VALUES($1,$2,'authorised',$3)", [
          context.scopeId,
          missionId,
          JSON.stringify(provenance),
        ]);
        await queueMissionAttempt(client, context.scopeId, missionId, 1, order.digest, provenance);
        await client.query(
          "UPDATE cos.mission_team_steps SET child_mission_id=$4,state='running',version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND team_id=$2 AND step_id=$3",
          [context.scopeId, teamId, step.step_id, missionId],
        );
        created.push(missionId);
        available--;
      }
      if (created.length)
        await client.query(
          "UPDATE cos.mission_team_roots SET state='running',version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
          [context.scopeId, teamId],
        );
      return { status: 'ok', team_id: teamId, created, capacity_available: available };
    });
  }
  /** Called only by the trusted S05 attempt store after locking the parent before the child. */
  async captureChild(client: PoolClient, context: Context, change: MissionChange, execution: boolean) {
    if (context.origin) return null;
    const lookup = (
      await client.query('SELECT team_id FROM cos.mission_team_steps WHERE scope_id=$1 AND child_mission_id=$2', [
        context.scopeId,
        change.mission_id,
      ])
    ).rows[0];
    if (!lookup) return null;
    const current = await this.root(client, context, lookup.team_id, execution);
    if (!current) return null;
    const row = (
      await client.query(
        `SELECT s.*,w.body,w.digest,b.state AS reservation_state,b.max_attempts,b.max_turns,b.max_tool_calls
      FROM cos.mission_team_steps s JOIN cos.mission_work_orders w ON w.scope_id=s.scope_id AND w.id=s.child_mission_id
      JOIN cos.mission_team_reservations b ON b.scope_id=s.scope_id AND b.team_id=s.team_id AND b.step_id=s.step_id
      WHERE s.scope_id=$1 AND s.team_id=$2 AND s.child_mission_id=$3 FOR SHARE OF s,b`,
        [context.scopeId, lookup.team_id, change.mission_id],
      )
    ).rows[0];
    if (
      !row ||
      row.state !== 'running' ||
      row.reservation_state !== 'reserved' ||
      row.digest !== change.work_order_digest ||
      digest(row.body) !== row.digest ||
      digest(change.work_order) !== row.digest
    )
      return null;
    if (
      execution &&
      !(await client.query('SELECT $1::timestamptz > clock_timestamp() AS current', [row.body.deadlineAt])).rows[0]
        .current
    )
      return null;
    const step = current.order.body.request.steps.find((s) => s.step_id === row.step_id);
    if (
      !step ||
      digest(step) !== digest(row.definition) ||
      row.max_attempts !== step.limits.max_attempts + step.max_rework_count ||
      row.max_turns !== step.limits.max_turns ||
      row.max_tool_calls !== step.limits.max_tool_calls
    )
      return null;
    const rebuilt = await this.childOrder(client, context, current, step.step_id);
    return rebuilt && rebuilt.digest === row.digest ? rebuilt : null;
  }
  private async inputs(
    client: PoolClient,
    context: Context,
    current: CurrentTeam,
    step: TeamStep,
    seen: Set<string>,
  ): Promise<TeamInputArtifact[] | null> {
    const inputs: TeamInputArtifact[] = [];
    for (const dependency of step.depends_on) {
      const row = (
        await client.query(
          `SELECT s.*,m.generation,m.state AS mission_state FROM cos.mission_team_steps s
        LEFT JOIN cos.missions m ON m.scope_id=s.scope_id AND m.id=s.child_mission_id
        WHERE s.scope_id=$1 AND s.team_id=$2 AND s.step_id=$3 FOR SHARE OF s`,
          [context.scopeId, current.row.id, dependency],
        )
      ).rows[0];
      const definition = current.order.body.request.steps.find((s) => s.step_id === dependency);
      if (!row || !definition || digest(row.definition) !== digest(definition)) return null;
      if (row.state === 'failed') {
        if (definition.required && current.order.body.request.partial_policy !== 'allow_labelled') return null;
        inputs.push({
          step_id: dependency,
          state: 'failed',
          required: definition.required,
          reason:
            row.provenance.failure_reason === 'missing_coverage'
              ? 'missing_coverage'
              : row.provenance.failure_reason === 'budget_exhausted'
                ? 'budget_exhausted'
                : 'worker_failed',
        });
        continue;
      }
      if (row.state !== 'submitted' || row.mission_state !== 'awaiting_review' || !id(row.provenance.submission_id))
        return null;
      const order = await this.childOrder(client, context, current, dependency, seen);
      if (!order || !this.knowledge) return null;
      const verified = await readVerifiedSubmission(
        client,
        this.knowledge.artifacts,
        context.scopeId,
        row.child_mission_id,
        row.provenance.submission_id,
        row.generation,
        order,
        true,
      );
      if (
        !verified ||
        !validMissionResult(verified.result) ||
        verified.submission.digest !== row.provenance.result_digest ||
        verified.submission.artifact_id !== row.provenance.artifact_id
      )
        return null;
      inputs.push({
        step_id: dependency,
        state: 'submitted',
        mission_id: row.child_mission_id,
        submission_id: verified.submission.id,
        artifact_id: verified.submission.artifact_id,
        result_digest: verified.submission.digest,
        result: verified.result,
      });
    }
    return inputs;
  }
  private async childOrder(
    client: PoolClient,
    context: Context,
    current: CurrentTeam,
    stepId: string,
    ancestors = new Set<string>(),
  ): Promise<TeamChildWorkOrder | null> {
    if (ancestors.has(stepId) || ancestors.size >= 6) return null;
    const seen = new Set(ancestors).add(stepId);
    const row = (
      await client.query(
        `SELECT s.*,w.body,w.digest,b.state AS reservation_state,b.max_attempts,b.max_turns,b.max_tool_calls
      FROM cos.mission_team_steps s JOIN cos.mission_work_orders w ON w.scope_id=s.scope_id AND w.id=s.child_mission_id
      JOIN cos.mission_team_reservations b ON b.scope_id=s.scope_id AND b.team_id=s.team_id AND b.step_id=s.step_id
      WHERE s.scope_id=$1 AND s.team_id=$2 AND s.step_id=$3 FOR SHARE OF s,b`,
        [context.scopeId, current.row.id, stepId],
      )
    ).rows[0];
    const step = current.order.body.request.steps.find((s) => s.step_id === stepId);
    if (
      !row ||
      !step ||
      !['running', 'submitted'].includes(row.state) ||
      row.reservation_state !== 'reserved' ||
      digest(step) !== digest(row.definition) ||
      digest(row.body) !== row.digest ||
      row.max_attempts !== step.limits.max_attempts + step.max_rework_count ||
      row.max_turns !== step.limits.max_turns ||
      row.max_tool_calls !== step.limits.max_tool_calls
    )
      return null;
    const artifacts = await this.inputs(client, context, current, step, seen);
    if (!artifacts) return null;
    const order = sealTeamChildWorkOrder({
      missionId: row.child_mission_id,
      stepId,
      rootGeneration: current.row.generation,
      approved: current.order,
      artifacts,
    });
    return validateTeamChildWorkOrder(order) && order.digest === row.digest ? order : null;
  }
  /** Database events/confirmed stops advance the graph. No model turn or open transaction waits for a worker. */
  async advance(context: Context, teamId: string): Promise<Result> {
    if (!id(teamId) || !this.knowledge) return { status: 'denied' };
    return this.transaction(context, async (client) => {
      await lockMissionWorkerAdmission(client);
      const current = await this.root(client, context, teamId);
      if (!current) return { status: 'denied' };
      const rows = (
        await client.query(
          'SELECT * FROM cos.mission_team_steps WHERE scope_id=$1 AND team_id=$2 ORDER BY step_id FOR UPDATE',
          [context.scopeId, teamId],
        )
      ).rows;
      if (
        rows.length !== current.order.body.request.steps.length ||
        rows.some(
          (r) => digest(r.definition) !== digest(current.order.body.request.steps.find((s) => s.step_id === r.step_id)),
        )
      )
        return { status: 'denied' };
      const changes: Array<{ stepId: string; state: string; provenance: Record<string, unknown> }> = [];
      const retries: Array<{
        stepId: string;
        missionId: string;
        generation: number;
        attemptId: string;
        order: TeamChildWorkOrder;
        provenance: Record<string, unknown>;
      }> = [];
      for (const row of rows) {
        if (row.state !== 'running') {
          if (['ready', 'blocked'].includes(row.state) && !row.child_mission_id) {
            const step = current.order.body.request.steps.find((s) => s.step_id === row.step_id)!;
            const deadline = new Date(
              Date.parse(current.order.body.issuedAt) + step.limits.wall_seconds * 1000,
            ).toISOString();
            if (
              !(await client.query('SELECT $1::timestamptz > clock_timestamp() AS current', [deadline])).rows[0].current
            )
              changes.push({ stepId: row.step_id, state: 'failed', provenance: { failure_reason: 'deadline' } });
          }
          continue;
        }
        const attempt = (
          await client.query(
            `SELECT m.state,m.generation,m.provenance,a.id AS attempt_id,a.state AS attempt_state,a.allocation FROM cos.missions m
          JOIN cos.mission_attempts a ON a.scope_id=m.scope_id AND a.mission_id=m.id AND a.generation=m.generation
          WHERE m.scope_id=$1 AND m.id=$2 FOR UPDATE OF m`,
            [context.scopeId, row.child_mission_id],
          )
        ).rows[0];
        if (!attempt || attempt.allocation.stop_confirmed !== true) continue;
        if (attempt.state === 'awaiting_review' && attempt.attempt_state === 'submitted') {
          const order = await this.childOrder(client, context, current, row.step_id);
          if (!order) return { status: 'denied' };
          const submission = (
            await client.query(
              'SELECT id FROM cos.mission_result_submissions WHERE scope_id=$1 AND mission_id=$2 AND generation=$3',
              [context.scopeId, row.child_mission_id, attempt.generation],
            )
          ).rows[0];
          if (!submission) return { status: 'denied' };
          const verified = await readVerifiedSubmission(
            client,
            this.knowledge!.artifacts,
            context.scopeId,
            row.child_mission_id,
            submission.id,
            attempt.generation,
            order,
            true,
          );
          if (!verified) return { status: 'denied' };
          const missing = validMissionResult(verified.result) && verified.result.outcome === 'blocked';
          changes.push({
            stepId: row.step_id,
            state: missing ? 'failed' : 'submitted',
            provenance: {
              submission_id: submission.id,
              result_digest: verified.submission.digest,
              artifact_id: verified.submission.artifact_id,
              ...(missing ? { failure_reason: 'missing_coverage' } : {}),
            },
          });
        } else if (attempt.state === 'failed' && attempt.attempt_state === 'failed') {
          const definition = current.order.body.request.steps.find((s) => s.step_id === row.step_id)!;
          const counts = (
            await client.query(
              'SELECT kind,count(*)::int AS n FROM cos.mission_budget_reservations WHERE scope_id=$1 AND mission_id=$2 GROUP BY kind',
              [context.scopeId, row.child_mission_id],
            )
          ).rows;
          const usage = {
            attempt: counts.find((c) => c.kind === 'attempt')?.n ?? 0,
            model: counts.find((c) => c.kind === 'model')?.n ?? 0,
            tool: counts.find((c) => c.kind === 'tool')?.n ?? 0,
          };
          if (usage.attempt >= definition.limits.max_attempts)
            changes.push({ stepId: row.step_id, state: 'failed', provenance: { failure_reason: 'worker_failed' } });
          else if (usage.model >= definition.limits.max_turns || usage.tool >= definition.limits.max_tool_calls)
            changes.push({ stepId: row.step_id, state: 'failed', provenance: { failure_reason: 'budget_exhausted' } });
          else {
            const order = await this.childOrder(client, context, current, row.step_id);
            if (!order) return { status: 'denied' };
            if (
              !(await client.query('SELECT $1::timestamptz > clock_timestamp() AS current', [order.body.deadlineAt]))
                .rows[0].current
            )
              changes.push({ stepId: row.step_id, state: 'failed', provenance: { failure_reason: 'deadline' } });
            else
              retries.push({
                stepId: row.step_id,
                missionId: row.child_mission_id,
                generation: attempt.generation,
                attemptId: attempt.attempt_id,
                order,
                provenance: attempt.provenance,
              });
          }
        }
      }
      for (const change of changes) {
        await client.query(
          'UPDATE cos.mission_team_steps SET state=$4,provenance=provenance||$5::jsonb,version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND team_id=$2 AND step_id=$3',
          [context.scopeId, teamId, change.stepId, change.state, JSON.stringify(change.provenance)],
        );
        const row = rows.find((r) => r.step_id === change.stepId)!;
        row.state = change.state;
      }
      const failedRequired = rows.some((r) => r.state === 'failed' && r.definition.required);
      if (failedRequired && current.order.body.request.partial_policy === 'block') {
        await client.query(
          "UPDATE cos.mission_team_roots SET state='blocked',provenance=provenance||$3::jsonb,version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2 AND state<>'blocked'",
          [context.scopeId, teamId, JSON.stringify({ failure_reason: 'required_step_failed' })],
        );
        return { status: 'ok', team_id: teamId, state: 'blocked' };
      }
      const occupancy = await missionWorkerOccupancy(client);
      const rootActive = (
        await client.query(
          `SELECT count(*)::int AS n FROM cos.mission_attempts a JOIN cos.mission_team_steps s ON s.scope_id=a.scope_id AND s.child_mission_id=a.mission_id
        WHERE s.scope_id=$1 AND s.team_id=$2 AND a.allocation->>'stop_confirmed' IS DISTINCT FROM 'true'`,
          [context.scopeId, teamId],
        )
      ).rows[0].n;
      let available = Math.max(
        0,
        Math.min(
          this.workerCapacity - occupancy.active,
          current.order.body.request.limits.max_concurrent_workers - rootActive,
        ),
      );
      let queuedRetry = false;
      for (const retry of retries) {
        if (available <= 0) break;
        const pending = await client.query(
          "SELECT 1 FROM cos.mission_attempts WHERE scope_id=$1 AND mission_id=$2 AND allocation->>'stop_confirmed' IS DISTINCT FROM 'true' LIMIT 1",
          [context.scopeId, retry.missionId],
        );
        if (pending.rowCount) continue;
        await queueMissionAttempt(client, context.scopeId, retry.missionId, retry.generation + 1, retry.order.digest, {
          ...retry.provenance,
          retry_of: retry.attemptId,
        });
        available--;
        queuedRetry = true;
      }
      for (const row of rows) {
        if (row.state !== 'blocked') continue;
        const definition = current.order.body.request.steps.find((s) => s.step_id === row.step_id)!;
        if (
          definition.depends_on.every((d) =>
            rows.some((r) => r.step_id === d && ['submitted', 'failed'].includes(r.state)),
          )
        )
          await client.query(
            "UPDATE cos.mission_team_steps SET state='ready',version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND team_id=$2 AND step_id=$3 AND state='blocked'",
            [context.scopeId, teamId, row.step_id],
          );
      }
      const state = rows.every((r) => ['submitted', 'failed'].includes(r.state))
        ? 'awaiting_review'
        : queuedRetry
          ? 'running'
          : current.row.state;
      if (state !== current.row.state)
        await client.query(
          'UPDATE cos.mission_team_roots SET state=$3,version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2',
          [context.scopeId, teamId, state],
        );
      return { status: 'ok', team_id: teamId, state };
    });
  }
  /** Denial-only owner control: available after pause, expired consent or source revocation. */
  private async retainedRoot(client: PoolClient, context: Context, teamId: string) {
    const row = (
      await client.query(
        `SELECT r.*,w.body,w.digest FROM cos.mission_team_roots r
      JOIN cos.mission_team_work_orders w ON w.scope_id=r.scope_id AND w.id=r.id
      WHERE r.scope_id=$1 AND r.id=$2 FOR UPDATE OF r`,
        [context.scopeId, teamId],
      )
    ).rows[0];
    const origin = row?.body?.origin;
    return row &&
      digest(row.body) === row.digest &&
      origin?.scopeId === context.scopeId &&
      origin.ownerId === context.ownerId &&
      origin.agentGroupId === context.agentGroupId &&
      origin.sessionId === context.sessionId
      ? row
      : null;
  }
  async cancel(context: Context, teamId: string): Promise<Result> {
    if (!id(teamId) || context.origin) return { status: 'denied' };
    return this.transaction(
      context,
      async (client) => {
        const root = await this.retainedRoot(client, context, teamId);
        if (!root || ['completed', 'partial'].includes(root.state)) return { status: 'denied' };
        const attempts = (
          await client.query(
            `SELECT a.* FROM cos.mission_team_steps s
        JOIN cos.mission_attempts a ON a.scope_id=s.scope_id AND a.mission_id=s.child_mission_id
        WHERE s.scope_id=$1 AND s.team_id=$2 ORDER BY a.mission_id,a.id`,
            [context.scopeId, teamId],
          )
        ).rows;
        const identities = attempts.map((a) => ({
          scopeId: a.scope_id,
          missionId: a.mission_id,
          attemptId: a.id,
          generation: a.generation,
          agentGroupId: a.agent_group_id,
          sessionId: a.session_id,
          provider: 'codex' as const,
        }));
        if (!identities.every(validCosMissionIdentity)) return { status: 'denied' };
        if (['cancelling', 'cancelled'].includes(root.state))
          return { status: 'ok', team_id: teamId, state: root.state, identities };
        await client.query(
          `UPDATE cos.mission_attempts a SET state='cancelled',lease_owner=NULL,lease_until=NULL,
        version=a.version+1,updated_at=clock_timestamp() FROM cos.mission_team_steps s
        WHERE s.scope_id=$1 AND s.team_id=$2 AND a.scope_id=s.scope_id AND a.mission_id=s.child_mission_id AND a.state<>'cancelled'`,
          [context.scopeId, teamId],
        );
        await client.query(
          `UPDATE cos.missions m SET state=CASE WHEN EXISTS(SELECT 1 FROM cos.mission_attempts a
        WHERE a.scope_id=m.scope_id AND a.mission_id=m.id AND a.allocation->>'stop_confirmed' IS DISTINCT FROM 'true') THEN 'cancelling' ELSE 'cancelled' END,
        generation=m.generation+1,version=m.version+1,updated_at=clock_timestamp() FROM cos.mission_team_steps s
        WHERE s.scope_id=$1 AND s.team_id=$2 AND m.scope_id=s.scope_id AND m.id=s.child_mission_id AND m.state NOT IN ('cancelling','cancelled')`,
          [context.scopeId, teamId],
        );
        await client.query(
          "UPDATE cos.mission_team_steps SET state='cancelled',version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND team_id=$2 AND state<>'cancelled'",
          [context.scopeId, teamId],
        );
        const state = attempts.some((a) => a.allocation.stop_confirmed !== true) ? 'cancelling' : 'cancelled';
        await client.query(
          'UPDATE cos.mission_team_roots SET state=$3,generation=generation+1,version=version+1,provenance=provenance||$4::jsonb,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2',
          [
            context.scopeId,
            teamId,
            state,
            JSON.stringify({
              cancelled_generation: root.generation,
              cancel_owner_id: context.ownerId,
              cancel_ingress_id: context.ingressId,
            }),
          ],
        );
        await client.query(
          "UPDATE cos.proposals SET state=CASE WHEN state='pending' THEN 'rejected' ELSE 'conflict' END,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2 AND state IN ('pending','approved')",
          [context.scopeId, root.proposal_id],
        );
        await client.query(
          "UPDATE cos.outbox SET delivered_at=clock_timestamp() WHERE scope_id=$1 AND payload->>'proposal_id'=$2 AND kind IN ('approval_preview','proposal_apply') AND delivered_at IS NULL",
          [context.scopeId, root.proposal_id],
        );
        return { status: 'ok', team_id: teamId, state, identities };
      },
      false,
    );
  }
  /** Called only after exact native stops have been independently recorded by MissionRunStore.confirmStopped. */
  async confirmCancellation(context: Context, teamId: string): Promise<Result> {
    if (!id(teamId) || context.origin) return { status: 'denied' };
    return this.transaction(
      context,
      async (client) => {
        const root = await this.retainedRoot(client, context, teamId);
        if (!root || !['cancelling', 'cancelled'].includes(root.state)) return { status: 'denied' };
        const pending = await client.query(
          `SELECT 1 FROM cos.mission_team_steps s JOIN cos.mission_attempts a
        ON a.scope_id=s.scope_id AND a.mission_id=s.child_mission_id WHERE s.scope_id=$1 AND s.team_id=$2
        AND a.allocation->>'stop_confirmed' IS DISTINCT FROM 'true' LIMIT 1`,
          [context.scopeId, teamId],
        );
        if (pending.rowCount) return { status: 'ok', team_id: teamId, state: 'cancelling' };
        const reservations = (
          await client.query(
            `SELECT b.*,s.child_mission_id FROM cos.mission_team_reservations b
        JOIN cos.mission_team_steps s ON s.scope_id=b.scope_id AND s.team_id=b.team_id AND s.step_id=b.step_id
        WHERE b.scope_id=$1 AND b.team_id=$2 ORDER BY b.step_id FOR UPDATE OF b`,
            [context.scopeId, teamId],
          )
        ).rows;
        const prepared = [];
        for (const reservation of reservations) {
          if (reservation.state === 'cancelled') continue;
          if (reservation.state !== 'reserved') return { status: 'denied' };
          const counts = (
            await client.query(
              'SELECT kind,count(*)::int AS n FROM cos.mission_budget_reservations WHERE scope_id=$1 AND mission_id=$2 GROUP BY kind',
              [context.scopeId, reservation.child_mission_id],
            )
          ).rows;
          const usage = {
            attempt: counts.find((c) => c.kind === 'attempt')?.n ?? 0,
            model: counts.find((c) => c.kind === 'model')?.n ?? 0,
            tool: counts.find((c) => c.kind === 'tool')?.n ?? 0,
          };
          const unused = {
            attempt: reservation.max_attempts - usage.attempt,
            model: reservation.max_turns - usage.model,
            tool: reservation.max_tool_calls - usage.tool,
          };
          if (Object.values(unused).some((n) => !Number.isSafeInteger(n) || n < 0)) return { status: 'denied' };
          prepared.push({ stepId: reservation.step_id, usage, unused });
        }
        for (const { stepId, usage, unused } of prepared) {
          const body = {
            generation: root.provenance.cancelled_generation,
            usage,
            unused,
            confirmed_stopped: true,
            provider_usage: usage.model ? 'uncertain' : 'no_model_calls',
          };
          await client.query(
            "INSERT INTO cos.mission_team_budget_events(scope_id,team_id,step_id,id,kind,body) VALUES($1,$2,$3,$4,'released',$5) ON CONFLICT DO NOTHING",
            [
              context.scopeId,
              teamId,
              stepId,
              'team-release-' + digest({ team: teamId, step: stepId }),
              JSON.stringify(body),
            ],
          );
          if (usage.model)
            await client.query(
              "INSERT INTO cos.mission_team_budget_events(scope_id,team_id,step_id,id,kind,body) VALUES($1,$2,$3,$4,'uncertain',$5) ON CONFLICT DO NOTHING",
              [
                context.scopeId,
                teamId,
                stepId,
                'team-uncertain-' + digest({ team: teamId, step: stepId }),
                JSON.stringify({ generation: body.generation, model_reservations: usage.model, billed_tokens: null }),
              ],
            );
          await client.query(
            "UPDATE cos.mission_team_reservations SET state='cancelled',usage=$4,updated_at=clock_timestamp() WHERE scope_id=$1 AND team_id=$2 AND step_id=$3 AND state='reserved'",
            [context.scopeId, teamId, stepId, JSON.stringify(body)],
          );
        }
        await client.query(
          "UPDATE cos.mission_team_roots SET state='cancelled',version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2 AND state='cancelling'",
          [context.scopeId, teamId],
        );
        return { status: 'ok', team_id: teamId, state: 'cancelled' };
      },
      false,
    );
  }
}
