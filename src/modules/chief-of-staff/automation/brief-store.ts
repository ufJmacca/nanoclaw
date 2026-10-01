import type { PoolClient } from 'pg';
import { BoundedDatabase, DatabaseUnavailable } from '../store/client.js';
import type { Context, Result } from '../domain/contracts.js';
import { planBriefOccurrence } from './schedule-policy.js';
const instant = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();
const safeRun = (run: Record<string, unknown>) => ({
  ...run,
  deadline_at: instant(run.deadline_at),
  intended_at: instant(run.intended_at),
});
const id = (value: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export class BriefRunStore {
  constructor(
    readonly database: BoundedDatabase,
    readonly options: { clock?: () => Date } = {},
  ) {}
  private async transaction(context: Context, operation: (client: PoolClient) => Promise<Result>): Promise<Result> {
    try {
      return await this.database.run(async (client) => {
        await client.query('BEGIN');
        const allowed = await client.query(
          "SELECT 1 FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 AND status='active' FOR SHARE",
          [context.scopeId, context.ownerId, context.agentGroupId],
        );
        const result = allowed.rowCount ? await operation(client) : { status: 'denied' as const };
        await client.query('COMMIT');
        return result;
      }, true);
    } catch (error) {
      if (error instanceof DatabaseUnavailable) return { status: error.code === 'pending' ? 'pending' : 'unavailable' };
      throw error;
    }
  }
  private async schedule(client: PoolClient, context: Context) {
    return (
      await client.query(
        'SELECT *,last_local_date::text AS local_date_text FROM cos.brief_schedules WHERE scope_id=$1 AND owner_id=$2 AND session_id=$3 AND agent_group_id=$4 FOR UPDATE',
        [context.scopeId, context.ownerId, context.sessionId, context.agentGroupId],
      )
    ).rows[0];
  }
  private async settle(client: PoolClient, scopeId: string, runId: string, state: 'failed' | 'cancelled') {
    const notification = (
      await client.query('SELECT state FROM cos.brief_notifications WHERE scope_id=$1 AND run_id=$2 FOR UPDATE', [
        scopeId,
        runId,
      ])
    ).rows[0];
    const outcome =
      notification?.state === 'delivered'
        ? 'delivered'
        : ['delivering', 'uncertain'].includes(notification?.state)
          ? 'uncertain'
          : state;
    await client.query(
      'UPDATE cos.brief_runs SET state=$3,version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2',
      [scopeId, runId, outcome],
    );
    await client.query(
      "UPDATE cos.brief_notifications SET state=CASE WHEN state='delivering' THEN 'uncertain' ELSE $3 END,version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND run_id=$2 AND state IN ('queued','delivering')",
      [scopeId, runId, state],
    );
  }
  async reserveDue(context: Context): Promise<Result> {
    return this.transaction(context, async (client) => {
      const schedule = await this.schedule(client, context);
      if (!schedule) return { status: 'ok', run: null, next_wake_at: null };
      const obsolete = (
        await client.query(
          "SELECT id FROM cos.brief_runs WHERE scope_id=$1 AND schedule_id=$2 AND (schedule_version<>$3 OR $4::boolean) AND state IN ('queued','dispatched','prepared') ORDER BY created_at LIMIT 20 FOR UPDATE",
          [context.scopeId, schedule.id, schedule.version, schedule.policy.state !== 'active'],
        )
      ).rows;
      for (const run of obsolete) await this.settle(client, context.scopeId, run.id, 'cancelled');
      if (schedule.policy.state !== 'active') return { status: 'ok', run: null, next_wake_at: null };
      const now = (await client.query('SELECT clock_timestamp() AS at')).rows[0].at as Date;
      const existing = (
        await client.query(
          "SELECT * FROM cos.brief_runs WHERE scope_id=$1 AND schedule_id=$2 AND schedule_version=$3 AND state IN ('queued','dispatched','prepared') ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
          [context.scopeId, schedule.id, schedule.version],
        )
      ).rows[0];
      if (existing && existing.deadline_at > now) return { status: 'ok', run: safeRun(existing), next_wake_at: null };
      if (existing) await this.settle(client, context.scopeId, existing.id, 'failed');
      const plan = planBriefOccurrence(
        schedule.policy,
        {
          scopeId: context.scopeId,
          scheduleId: schedule.id,
          revision: schedule.version,
          activatedAt: schedule.activated_at.toISOString(),
          lastLocalDate: schedule.local_date_text,
        },
        (this.options.clock?.() ?? now).toISOString(),
      );
      if (!plan.due) return { status: 'ok', run: null, next_wake_at: plan.nextWakeAt };
      const run = (
        await client.query(
          `INSERT INTO cos.brief_runs(scope_id,id,schedule_id,schedule_version,owner_id,session_id,agent_group_id,intended_at,local_date,state,limits,deadline_at,provenance)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,clock_timestamp()+($11*interval '1 second'),$12) ON CONFLICT DO NOTHING RETURNING *`,
          [
            context.scopeId,
            plan.due.key,
            schedule.id,
            schedule.version,
            context.ownerId,
            context.sessionId,
            context.agentGroupId,
            plan.due.intendedAt,
            plan.due.localDate,
            JSON.stringify(schedule.limits),
            schedule.limits.deadline_seconds,
            JSON.stringify({
              schedule_revision: schedule.version,
              schedule_proposal: schedule.provenance.proposal_id,
              intended_local_date: plan.due.intendedLocalDate,
            }),
          ],
        )
      ).rows[0];
      if (!run) return { status: 'conflict' };
      await client.query("INSERT INTO cos.brief_notifications(scope_id,id,run_id,state) VALUES($1,$2,$3,'queued')", [
        context.scopeId,
        'brief-' + run.id,
        run.id,
      ]);
      await client.query(
        'UPDATE cos.brief_schedules SET last_local_date=$3,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2',
        [context.scopeId, schedule.id, plan.due.localDate],
      );
      return { status: 'ok', run: safeRun(run), next_wake_at: plan.nextWakeAt };
    });
  }
  private async currentRun(client: PoolClient, context: Context, runId: string) {
    const schedule = await this.schedule(client, context);
    if (!schedule || schedule.policy.state !== 'active') return null;
    return (
      (
        await client.query(
          `SELECT *,lease_until>clock_timestamp() AS lease_current FROM cos.brief_runs WHERE scope_id=$1 AND id=$2 AND schedule_id=$3 AND schedule_version=$4 AND owner_id=$5 AND session_id=$6 AND agent_group_id=$7 AND deadline_at>clock_timestamp() FOR UPDATE`,
          [
            context.scopeId,
            runId,
            schedule.id,
            schedule.version,
            context.ownerId,
            context.sessionId,
            context.agentGroupId,
          ],
        )
      ).rows[0] ?? null
    );
  }
  async claim(context: Context, runId: string, hostId: string): Promise<Result> {
    if (!id(runId) || !id(hostId)) return { status: 'denied' };
    return this.transaction(context, async (client) => {
      const run = await this.currentRun(client, context, runId);
      if (!run || !['queued', 'dispatched'].includes(run.state)) return { status: 'denied' };
      if (run.state === 'dispatched')
        return run.lease_owner === hostId && run.lease_current
          ? { status: 'ok', generation: run.generation, deadline_at: safeRun(run).deadline_at }
          : { status: 'denied' };
      const updated = (
        await client.query(
          "UPDATE cos.brief_runs SET state='dispatched',generation=generation+1,lease_owner=$3,lease_until=deadline_at,version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2 RETURNING generation,deadline_at",
          [context.scopeId, runId, hostId],
        )
      ).rows[0];
      return { status: 'ok', generation: updated.generation, deadline_at: updated.deadline_at.toISOString() };
    });
  }
  /** Fresh host admission, independent of any local projection or cached consent. */
  async authorize(context: Context, runId: string, generation: number): Promise<Result> {
    if (!id(runId) || !Number.isSafeInteger(generation) || generation < 1) return { status: 'denied' };
    return this.transaction(context, async (client) => {
      const run = await this.currentRun(client, context, runId);
      return run && ['dispatched', 'prepared'].includes(run.state) && run.lease_current && run.generation === generation
        ? { status: 'ok' }
        : { status: 'denied' };
    });
  }
  /** Owner preemption also reconciles obsolete revisions and ambiguous sends. */
  async cancel(context: Context, runId: string, generation: number): Promise<Result> {
    if (!id(runId) || !Number.isSafeInteger(generation) || generation < 1) return { status: 'denied' };
    return this.transaction(context, async (client) => {
      await this.schedule(client, context); // Same lock order as reservation, even when paused.
      const run = (
        await client.query(
          'SELECT state FROM cos.brief_runs WHERE scope_id=$1 AND id=$2 AND generation=$3 AND owner_id=$4 AND session_id=$5 AND agent_group_id=$6 FOR UPDATE',
          [context.scopeId, runId, generation, context.ownerId, context.sessionId, context.agentGroupId],
        )
      ).rows[0];
      if (!run) return { status: 'denied' };
      if (['queued', 'dispatched', 'prepared'].includes(run.state))
        await this.settle(client, context.scopeId, runId, 'cancelled');
      const current = (
        await client.query('SELECT state FROM cos.brief_runs WHERE scope_id=$1 AND id=$2', [context.scopeId, runId])
      ).rows[0];
      return { status: 'ok', state: current.state };
    });
  }
  async reserveCall(
    context: Context,
    runId: string,
    generation: number,
    kind: 'model' | 'tool',
    callId: string,
  ): Promise<Result> {
    if (
      !id(runId) ||
      !id(callId) ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      !['model', 'tool'].includes(kind)
    )
      return { status: 'denied' };
    return this.transaction(context, async (client) => {
      const run = await this.currentRun(client, context, runId);
      if (
        !run ||
        run.state !== 'dispatched' ||
        !run.lease_current ||
        run.generation !== generation ||
        (kind === 'model' ? run.model_calls >= run.limits.max_turns : run.tool_calls >= run.limits.max_tool_calls)
      )
        return { status: 'denied' };
      const reserved = await client.query(
        'INSERT INTO cos.brief_call_reservations(scope_id,run_id,call_id,kind,generation) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING call_id',
        [context.scopeId, runId, callId, kind, generation],
      );
      if (!reserved.rowCount) return { status: 'denied' }; // Unknown outcomes remain spent; no transparent replay.
      await client.query(
        `UPDATE cos.brief_runs SET model_calls=model_calls+$3,tool_calls=tool_calls+$4,version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2`,
        [context.scopeId, runId, kind === 'model' ? 1 : 0, kind === 'tool' ? 1 : 0],
      );
      return { status: 'ok', run_id: runId, generation };
    });
  }
}
