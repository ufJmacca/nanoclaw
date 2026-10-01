import type { PoolClient } from 'pg';
import { BoundedDatabase, DatabaseUnavailable } from '../store/client.js';
import { isArtifactIdentity } from '../knowledge/artifacts.js';
import { digest } from '../domain/contracts.js';
import type { Context, Result } from '../domain/contracts.js';
import { planBriefOccurrence } from './schedule-policy.js';
import { randomUUID } from 'node:crypto';
import { snapshotWindow } from '../calendar/normalization.js';
import { hasCalendarReadScope } from '../calendar/reader.js';
import type { BriefRefreshPlan, BriefRefreshTarget } from './brief-refresh.js';
const instant = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();
const safeRun = (run: Record<string, unknown>) => ({
  ...run,
  deadline_at: instant(run.deadline_at),
  intended_at: instant(run.intended_at),
});
const id = (value: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export type BriefArtifactReference = {
  artifact_id: string;
  output_digest: string;
  context_generation: string;
  provider: string;
};
export type BriefDeliveryOutcome =
  | { state: 'delivered'; platform_receipt: string }
  | { state: 'uncertain' }
  | { state: 'failed'; reason: 'admission_denied' | 'provider_rejected' };
const validReference = (value: unknown): value is BriefArtifactReference => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as BriefArtifactReference;
  return (
    Object.keys(v).length === 4 &&
    Object.keys(v).every((k) => ['artifact_id', 'output_digest', 'context_generation', 'provider'].includes(k)) &&
    typeof v.artifact_id === 'string' &&
    isArtifactIdentity(v.artifact_id) &&
    typeof v.output_digest === 'string' &&
    /^[a-f0-9]{64}$/.test(v.output_digest) &&
    typeof v.context_generation === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.context_generation) &&
    ['codex', 'claude'].includes(v.provider)
  );
};
export class BriefRunStore {
  constructor(
    readonly database: BoundedDatabase,
    readonly options: { clock?: () => Date } = {},
  ) {}
  private async transaction(
    context: Context,
    operation: (client: PoolClient) => Promise<Result>,
    signal?: AbortSignal,
  ): Promise<Result> {
    try {
      return await this.database.run(
        async (client) => {
          await client.query('BEGIN');
          const allowed = await client.query(
            "SELECT 1 FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 AND status='active' FOR SHARE",
            [context.scopeId, context.ownerId, context.agentGroupId],
          );
          const result = allowed.rowCount ? await operation(client) : { status: 'denied' as const };
          if (signal?.aborted) throw new DatabaseUnavailable('pending');
          await client.query('COMMIT');
          return result;
        },
        true,
        signal,
      );
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
  private async artifactCurrent(
    client: PoolClient,
    context: Context,
    runId: string,
    generation: number,
    reference: unknown,
  ): Promise<boolean> {
    if (!validReference(reference)) return false;
    const row = (
      await client.query(
        "SELECT provenance FROM cos.artifacts WHERE scope_id=$1 AND id=$2 AND kind='summary' AND lifecycle='published'",
        [context.scopeId, reference.artifact_id],
      )
    ).rows[0];
    const p = row?.provenance;
    return (
      !!p &&
      p.format === 'cos-brief/v1' &&
      p.owner_id === context.ownerId &&
      p.session_id === context.sessionId &&
      p.processing_provider === reference.provider &&
      p.context_generation === reference.context_generation &&
      p.output_digest === reference.output_digest &&
      p.origin_run?.id === runId &&
      p.origin_run?.generation === generation
    );
  }
  /** Store only the protected artifact reference, never another copy of source-derived text. */
  async prepare(
    context: Context,
    runId: string,
    generation: number,
    reference: BriefArtifactReference,
  ): Promise<Result> {
    if (!id(runId) || !Number.isSafeInteger(generation) || generation < 1 || !validReference(reference))
      return { status: 'denied' };
    const captured = structuredClone(reference);
    return this.transaction(context, async (client) => {
      const run = await this.currentRun(client, context, runId);
      if (
        !run ||
        !['dispatched', 'prepared'].includes(run.state) ||
        !run.lease_current ||
        run.generation !== generation ||
        !(await this.artifactCurrent(client, context, runId, generation, captured))
      )
        return { status: 'denied' };
      if (run.state === 'prepared')
        return digest(run.snapshot) === digest(captured) ? { status: 'ok', run_id: runId } : { status: 'conflict' };
      const notification = (
        await client.query('SELECT state FROM cos.brief_notifications WHERE scope_id=$1 AND run_id=$2 FOR UPDATE', [
          context.scopeId,
          runId,
        ])
      ).rows[0];
      if (notification?.state !== 'queued') return { status: 'denied' };
      await client.query(
        "UPDATE cos.brief_runs SET state='prepared',snapshot=$3,version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
        [context.scopeId, runId, JSON.stringify(captured)],
      );
      await client.query(
        'UPDATE cos.brief_notifications SET payload=$3,version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND run_id=$2',
        [context.scopeId, runId, JSON.stringify(captured)],
      );
      return { status: 'ok', run_id: runId };
    });
  }
  /** Only a newly committed transition permits one transport invocation; replays never permit another. */
  async beginDelivery(context: Context, runId: string, generation: number, attemptId: string): Promise<Result> {
    if (!id(runId) || !id(attemptId) || !Number.isSafeInteger(generation) || generation < 1)
      return { status: 'denied' };
    return this.transaction(context, async (client) => {
      const run = await this.currentRun(client, context, runId);
      if (
        !run ||
        run.state !== 'prepared' ||
        !run.lease_current ||
        run.generation !== generation ||
        !(await this.artifactCurrent(client, context, runId, generation, run.snapshot))
      )
        return { status: 'denied' };
      const notification = (
        await client.query(
          'SELECT id,state,payload FROM cos.brief_notifications WHERE scope_id=$1 AND run_id=$2 FOR UPDATE',
          [context.scopeId, runId],
        )
      ).rows[0];
      if (notification?.state !== 'queued' || digest(notification.payload) !== digest(run.snapshot))
        return { status: 'denied' };
      await client.query(
        "UPDATE cos.brief_notifications SET state='delivering',attempt_id=$3,started_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND run_id=$2",
        [context.scopeId, runId, attemptId],
      );
      return { status: 'ok', notification_id: notification.id, attempt_id: attemptId, reference: run.snapshot };
    });
  }
  async deliveryCurrent(context: Context, runId: string, generation: number, attemptId: string): Promise<Result> {
    if (!id(runId) || !id(attemptId) || !Number.isSafeInteger(generation) || generation < 1)
      return { status: 'denied' };
    return this.transaction(context, async (client) => {
      const run = await this.currentRun(client, context, runId);
      if (
        !run ||
        run.state !== 'prepared' ||
        !run.lease_current ||
        run.generation !== generation ||
        !(await this.artifactCurrent(client, context, runId, generation, run.snapshot))
      )
        return { status: 'denied' };
      const row = (
        await client.query(
          "SELECT payload FROM cos.brief_notifications WHERE scope_id=$1 AND run_id=$2 AND state='delivering' AND attempt_id=$3",
          [context.scopeId, runId, attemptId],
        )
      ).rows[0];
      return row && digest(row.payload) === digest(run.snapshot) ? { status: 'ok' } : { status: 'denied' };
    });
  }
  /** A late verified receipt records an already-performed effect even if its lease has since ended. */
  async finishDelivery(
    context: Context,
    runId: string,
    generation: number,
    attemptId: string,
    outcome: BriefDeliveryOutcome,
  ): Promise<Result> {
    if (
      !id(runId) ||
      !id(attemptId) ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      !outcome ||
      !['delivered', 'uncertain', 'failed'].includes(outcome.state) ||
      (outcome.state === 'delivered' && !/^[a-zA-Z0-9_-]{1,128}$/.test(outcome.platform_receipt)) ||
      (outcome.state === 'failed' && !['admission_denied', 'provider_rejected'].includes(outcome.reason))
    )
      return { status: 'denied' };
    const receipt = structuredClone(outcome);
    return this.transaction(context, async (client) => {
      await this.schedule(client, context);
      const run = (
        await client.query(
          'SELECT id FROM cos.brief_runs WHERE scope_id=$1 AND id=$2 AND generation=$3 AND owner_id=$4 AND session_id=$5 AND agent_group_id=$6 FOR UPDATE',
          [context.scopeId, runId, generation, context.ownerId, context.sessionId, context.agentGroupId],
        )
      ).rows[0];
      if (!run) return { status: 'denied' };
      const notification = (
        await client.query(
          'SELECT state,attempt_id,receipt FROM cos.brief_notifications WHERE scope_id=$1 AND run_id=$2 FOR UPDATE',
          [context.scopeId, runId],
        )
      ).rows[0];
      if (!notification || notification.attempt_id !== attemptId) return { status: 'denied' };
      if (notification.state === outcome.state && digest(notification.receipt) === digest(receipt))
        return { status: 'ok', state: outcome.state };
      if (
        notification.state !== 'delivering' &&
        !(notification.state === 'uncertain' && ['uncertain', 'delivered'].includes(outcome.state))
      )
        return { status: 'denied' };
      await client.query(
        'UPDATE cos.brief_notifications SET state=$3,receipt=$4,version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND run_id=$2',
        [context.scopeId, runId, outcome.state, JSON.stringify(receipt)],
      );
      await client.query(
        'UPDATE cos.brief_runs SET state=$3,version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2',
        [context.scopeId, runId, outcome.state],
      );
      return { status: 'ok', state: outcome.state };
    });
  }
  async inspect(context: Context, runId: string): Promise<Result> {
    if (!id(runId)) return { status: 'denied' };
    return this.transaction(context, async (client) => {
      const run = (
        await client.query(
          'SELECT * FROM cos.brief_runs WHERE scope_id=$1 AND id=$2 AND owner_id=$3 AND session_id=$4 AND agent_group_id=$5',
          [context.scopeId, runId, context.ownerId, context.sessionId, context.agentGroupId],
        )
      ).rows[0];
      if (!run) return { status: 'denied' };
      const notification = (
        await client.query(
          'SELECT id,state,payload,receipt,attempt_id FROM cos.brief_notifications WHERE scope_id=$1 AND run_id=$2',
          [context.scopeId, runId],
        )
      ).rows[0];
      return { status: 'ok', run: safeRun(run), notification };
    });
  }
  private async refreshRun(client: PoolClient, context: Context, runId: string, generation: number) {
    const run = await this.currentRun(client, context, runId);
    return run?.state === 'dispatched' && run.lease_current && run.generation === generation ? run : null;
  }
  private async saveRefresh(client: PoolClient, context: Context, runId: string, refresh: BriefRefreshPlan) {
    await client.query(
      "UPDATE cos.brief_runs SET provenance=jsonb_set(provenance,'{refresh}',$3::jsonb),version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
      [context.scopeId, runId, JSON.stringify(refresh)],
    );
  }
  /** This persisted deadline is never recreated by a native retry or host restart. */
  async beginRefresh(
    context: Context,
    runId: string,
    generation: number,
    provider: string,
    signal?: AbortSignal,
  ): Promise<Result> {
    if (!id(runId) || !Number.isSafeInteger(generation) || generation < 1 || !['codex', 'claude'].includes(provider))
      return { status: 'denied' };
    return this.transaction(
      context,
      async (client) => {
        const run = await this.refreshRun(client, context, runId, generation);
        if (!run) return { status: 'denied' };
        const now = (await client.query('SELECT clock_timestamp() AS at')).rows[0].at as Date;
        let refresh = run.provenance.refresh as BriefRefreshPlan | undefined;
        if (refresh && (refresh.provider !== provider || refresh.generation !== generation))
          return { status: 'denied' };
        if (!refresh) {
          const seconds = run.limits.refresh_seconds;
          if (!Number.isInteger(seconds) || seconds < 0 || seconds > 30) return { status: 'denied' };
          const rows =
            seconds === 0
              ? []
              : (
                  await client.query(
                    `SELECT b.id,b.version,b.time_zone,b.auth,b.permission_scopes,c.calendar_id FROM cos.calendar_bindings b CROSS JOIN LATERAL unnest(b.selected_calendar_ids) AS c(calendar_id) WHERE b.scope_id=$1 AND $2=ANY(b.processing_providers) ORDER BY b.id,c.calendar_id LIMIT 11`,
                    [context.scopeId, provider],
                  )
                ).rows;
          const targets: BriefRefreshTarget[] = rows
            .slice(0, 10)
            .filter((row) => row.auth === 'ready' && hasCalendarReadScope(row.permission_scopes))
            .map((row) => ({
              binding_id: row.id,
              binding_version: row.version,
              calendar_id: row.calendar_id,
              snapshot_id: randomUUID(),
              window: snapshotWindow(now.toISOString(), row.time_zone),
              state: 'pending',
            }));
          refresh = {
            version: 1,
            provider,
            generation,
            started_at: now.toISOString(),
            deadline_at: new Date(Math.min(run.deadline_at.getTime(), now.getTime() + seconds * 1000)).toISOString(),
            state: seconds === 0 || rows.length === 0 ? 'not_requested' : targets.length ? 'running' : 'failed',
            truncated: rows.length > 10,
            unavailable: Math.min(rows.length, 10) - targets.length,
            targets,
          };
          await this.saveRefresh(client, context, runId, refresh);
        }
        const remaining = Math.max(0, Date.parse(refresh.deadline_at) - now.getTime());
        if (refresh.state === 'running' && remaining === 0) {
          refresh.state = 'timed_out';
          await this.saveRefresh(client, context, runId, refresh);
        }
        return { status: 'ok', refresh, remaining_ms: remaining };
      },
      signal,
    );
  }
  async recordRefreshTarget(
    context: Context,
    runId: string,
    generation: number,
    snapshotId: string,
    outcome: 'complete' | 'failed' | 'uncertain',
    signal?: AbortSignal,
  ): Promise<Result> {
    if (
      !id(runId) ||
      !id(snapshotId) ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      !['complete', 'failed', 'uncertain'].includes(outcome)
    )
      return { status: 'denied' };
    return this.transaction(
      context,
      async (client) => {
        const run = await this.refreshRun(client, context, runId, generation),
          refresh = run?.provenance.refresh as BriefRefreshPlan | undefined;
        const target = refresh?.targets.find((t) => t.snapshot_id === snapshotId);
        if (!refresh || refresh.state !== 'running' || !target) return { status: 'denied' };
        const snapshot = (
          await client.query(
            'SELECT status,coverage_window,completed_at FROM cos.calendar_snapshots WHERE scope_id=$1 AND binding_id=$2 AND calendar_id=$3 AND id=$4 AND binding_version=$5',
            [context.scopeId, target.binding_id, target.calendar_id, snapshotId, target.binding_version],
          )
        ).rows[0];
        const complete = snapshot?.status === 'complete' && digest(snapshot.coverage_window) === digest(target.window);
        if (outcome === 'complete' && !complete) return { status: 'denied' };
        if (target.state !== 'complete') {
          target.state = complete ? 'complete' : outcome;
          if (complete) target.completed_at = instant(snapshot.completed_at);
        }
        await this.saveRefresh(client, context, runId, refresh);
        return { status: 'ok', refresh };
      },
      signal,
    );
  }
  async finishRefresh(
    context: Context,
    runId: string,
    generation: number,
    forced?: 'failed' | 'timed_out',
    signal?: AbortSignal,
  ): Promise<Result> {
    if (
      !id(runId) ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      (forced !== undefined && !['failed', 'timed_out'].includes(forced))
    )
      return { status: 'denied' };
    return this.transaction(
      context,
      async (client) => {
        const run = await this.refreshRun(client, context, runId, generation),
          refresh = run?.provenance.refresh as BriefRefreshPlan | undefined;
        if (!refresh) return { status: 'denied' };
        if (refresh.state !== 'running') return { status: 'ok', refresh };
        const now = (await client.query('SELECT clock_timestamp() AS at')).rows[0].at as Date;
        if (
          refresh.targets.some((t) => t.state === 'pending') &&
          !forced &&
          Date.parse(refresh.deadline_at) > now.getTime()
        )
          return { status: 'denied' };
        refresh.state =
          refresh.targets.every(
            (t) =>
              t.state === 'complete' &&
              !!t.completed_at &&
              Date.parse(t.completed_at) <= Date.parse(refresh.deadline_at),
          ) &&
          !refresh.truncated &&
          !refresh.unavailable
            ? 'complete'
            : forced === 'timed_out' || Date.parse(refresh.deadline_at) <= now.getTime()
              ? 'timed_out'
              : 'failed';
        await this.saveRefresh(client, context, runId, refresh);
        return { status: 'ok', refresh };
      },
      signal,
    );
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
