import type { PoolClient } from 'pg';
import { MAX_CONCURRENT_CONTAINERS } from '../../../config.js';
import { BoundedDatabase, DatabaseUnavailable } from '../store/client.js';
import { digest, type Context, type Result } from '../domain/contracts.js';
import type { MissionChange } from '../contracts/protocol.js';
import type { KnowledgeStore } from '../knowledge/store.js';
import type { TeamProposalStore } from './team-proposal-store.js';
import { sealTeamChildWorkOrder, validateTeamChildWorkOrder } from './team-work-order.js';
import { queueMissionAttempt } from './attempt.js';

const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
/** One host pool, parent-before-child locking and bounded credit escrow. No model/container wait occurs here. */
export class TeamRunStore {
  readonly workerCapacity: number;
  constructor(
    readonly database: BoundedDatabase,
    readonly proposals: TeamProposalStore,
    readonly knowledge?: KnowledgeStore,
    capacity: { nativeCapacity: number; maxWorkers: number } = {
      nativeCapacity: MAX_CONCURRENT_CONTAINERS,
      maxWorkers: 2,
    },
  ) {
    if (
      !Number.isSafeInteger(capacity.nativeCapacity) ||
      capacity.nativeCapacity < 1 ||
      capacity.nativeCapacity > 64 ||
      !Number.isSafeInteger(capacity.maxWorkers) ||
      capacity.maxWorkers < 1 ||
      capacity.maxWorkers > 2
    )
      throw Error('team_capacity_invalid');
    this.workerCapacity = Math.min(capacity.maxWorkers, capacity.nativeCapacity - 1);
  }
  private async transaction(context: Context, operation: (client: PoolClient) => Promise<Result>): Promise<Result> {
    if (context.origin) return { status: 'denied' };
    try {
      return await this.database.run(async (client) => {
        await client.query('BEGIN');
        const scope = await client.query(
          "SELECT id FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 AND status='active' FOR SHARE",
          [context.scopeId, context.ownerId, context.agentGroupId],
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
      await client.query('SELECT pg_advisory_xact_lock(73101004)');
      const current = await this.root(client, context, teamId);
      if (!current) return { status: 'denied' };
      const active = (
        await client.query(`SELECT count(DISTINCT a.id)::int AS n FROM cos.mission_team_steps s
        JOIN cos.mission_attempts a ON a.scope_id=s.scope_id AND a.mission_id=s.child_mission_id
        WHERE a.allocation->>'stop_confirmed' IS DISTINCT FROM 'true'`)
      ).rows[0].n;
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
      // Validate every ready row before the first mutation. A denied admission must not have created a child.
      for (const row of ready) {
        const step = current.order.body.request.steps.find((s) => s.step_id === row.step_id);
        if (!step || digest(step) !== digest(row.definition) || row.child_mission_id !== null)
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
        // Dependency joins are enabled only after independently verified submissions have been implemented.
        if (step.depends_on.length) continue;
        const missionId =
          'mission-' +
          digest({ scope: context.scopeId, team: teamId, generation: current.row.generation, step: step.step_id });
        const order = sealTeamChildWorkOrder({
          missionId,
          stepId: step.step_id,
          rootGeneration: current.row.generation,
          approved: current.order,
          artifacts: [],
        });
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
          artifacts: [],
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
    const order = { body: row.body, digest: row.digest, context: {} };
    const step = current.order.body.request.steps.find((s) => s.step_id === row.step_id);
    if (
      !step ||
      digest(step) !== digest(row.definition) ||
      step.depends_on.length ||
      row.max_attempts !== step.limits.max_attempts + step.max_rework_count ||
      row.max_turns !== step.limits.max_turns ||
      row.max_tool_calls !== step.limits.max_tool_calls
    )
      return null;
    const rebuilt = sealTeamChildWorkOrder({
      missionId: change.mission_id,
      stepId: step.step_id,
      rootGeneration: current.row.generation,
      approved: current.order,
      artifacts: [],
    });
    order.context = rebuilt.context;
    return validateTeamChildWorkOrder(order) && rebuilt.digest === row.digest ? rebuilt : null;
  }
}
