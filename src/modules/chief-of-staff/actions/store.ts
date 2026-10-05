import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { digest, type Context, type Result } from '../domain/contracts.js';
import {
  validActionId,
  validCalendarActionChange,
  validCalendarActionRequest,
  type CalendarActionChange,
  type CalendarActionRequest,
} from '../contracts/action-protocol.js';
import { BoundedDatabase, DatabaseUnavailable } from '../store/client.js';
import type { KnowledgeStore } from '../knowledge/store.js';
import type { ActionAuthority, ActionAuthorityResolver } from './authority.js';
import { createActionIntent, validActionIntent, type ActionIntent, type ActionResourceObservation } from './intent.js';
import { validWriterBinding, writerAccessMatches, type ActionWriterBinding } from './binding.js';
import { CalendarWriteError, type CalendarActionWriter, type CalendarWriterInspection } from './writer.js';
import type { EffectWitness } from './witness.js';
import { ActionRunStore } from './run-store.js';
import { ActionExecutor } from './executor.js';

export type ActionDependencies = {
  witness?: EffectWitness;
  authority: ActionAuthorityResolver;
  writer(context: Context, id: string, binding: ActionWriterBinding): CalendarActionWriter | null;
};
type BindingRow = { id: string; version: number; body: ActionWriterBinding; digest: string };
export type PreparedAction = { binding: BindingRow; inspection: CalendarWriterInspection; authority: ActionAuthority };
export type StoredAction = {
  body: ActionIntent;
  digest: string;
  authority: ActionAuthority;
  proposal_id: string;
  state: string;
};
const instant = (now: Date) => new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
export const availabilityObservationDigest = (inspection: CalendarWriterInspection) =>
  digest({ ownershipDigest: inspection.ownershipDigest, availabilityDigest: inspection.availabilityDigest });
export function actionPreview(intent: ActionIntent, hash: string): CalendarActionChange {
  return {
    kind: 'calendar_action',
    action_id: intent.actionId,
    intent_digest: hash,
    request: intent.request,
    event_id: intent.eventId,
    expires_at: intent.expiresAt,
  };
}

/** Host-only intent/approval queue. Provider inspection happens after releasing the PostgreSQL client. */
export class ActionStore {
  readonly runs = new ActionRunStore(this);
  readonly executor = new ActionExecutor(this);
  constructor(
    readonly database: BoundedDatabase,
    readonly knowledge?: KnowledgeStore,
    readonly dependencies?: ActionDependencies,
  ) {}

  async transaction(operation: (client: PoolClient) => Promise<Result>, mutation = false): Promise<Result> {
    try {
      return await this.database.run(async (client) => {
        await client.query('BEGIN');
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      }, mutation);
    } catch (error) {
      if (error instanceof DatabaseUnavailable) return { status: error.code === 'pending' ? 'pending' : 'unavailable' };
      throw error;
    }
  }
  async scopeCurrent(client: PoolClient, context: Context): Promise<boolean> {
    if (context.origin) return false;
    return (
      (
        await client.query(
          "SELECT id FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 AND status='active' FOR SHARE",
          [context.scopeId, context.ownerId, context.agentGroupId],
        )
      ).rowCount === 1
    );
  }
  async binding(client: PoolClient, context: Context, id: string): Promise<BindingRow | null> {
    const authority = this.dependencies?.authority(context);
    if (!authority || !(await this.scopeCurrent(client, context))) return null;
    const row = (
      await client.query(
        `SELECT b.id,b.version,r.body,r.digest FROM cos.action_writer_bindings b
      JOIN cos.action_writer_revisions r ON r.scope_id=b.scope_id AND r.binding_id=b.id AND r.version=b.version
      JOIN cos.scopes s ON s.id=b.scope_id
      WHERE b.scope_id=$1 AND b.id=$2 AND b.owner_id=$3 AND b.session_id=$4 AND b.state='enabled'
      AND r.body->>'instanceId'=s.instance_id AND r.body->>'channelId'=s.channel_id`,
        [context.scopeId, id, context.ownerId, context.sessionId],
      )
    ).rows[0] as BindingRow | undefined;
    return row &&
      validWriterBinding(row.body) &&
      digest(row.body) === row.digest &&
      row.body.bindingDigest === authority.bindingDigest
      ? row
      : null;
  }
  /** The returned observation is private host data, never a model-supplied authority field. */
  async observe(context: Context, request: CalendarActionRequest): Promise<Result> {
    if (!this.dependencies) return { status: 'unavailable', reason: 'writer_not_configured' };
    const pinned = structuredClone(request),
      authority = this.dependencies.authority(context);
    if (!validCalendarActionRequest(pinned) || context.origin || !authority) return { status: 'denied' };
    const read = await this.transaction(async (client) => {
      const binding = await this.binding(client, context, pinned.binding_id);
      return binding ? { status: 'ok', binding } : { status: 'denied' };
    });
    if (read.status !== 'ok') return read;
    const binding = read.binding as BindingRow,
      writer = this.dependencies.writer(context, pinned.binding_id, binding.body);
    if (!writer || binding.body.calendarId !== pinned.calendar_id) return { status: 'denied' };
    try {
      if (!writerAccessMatches(binding.body, await writer.access())) return { status: 'denied' };
      const inspection = await writer.inspect(pinned);
      if (
        inspection.complete !== true ||
        inspection.calendarId !== pinned.calendar_id ||
        inspection.accountFingerprint !== binding.body.accountFingerprint ||
        inspection.generation !== binding.body.credentialGeneration ||
        digest(this.dependencies.authority(context) ?? null) !== digest(authority)
      )
        return { status: 'denied' };
      if (inspection.busy.length) return { status: 'conflict', reason: 'calendar_conflict' };
      return { status: 'ok', prepared: structuredClone({ binding, inspection, authority }) };
    } catch (error) {
      if (error instanceof CalendarWriteError) return { status: 'unavailable', reason: error.code };
      throw error;
    }
  }
  private async related(
    client: PoolClient,
    context: Context,
    request: CalendarActionRequest,
    authority: ActionAuthority,
    observedAt: string,
  ): Promise<ActionResourceObservation[] | null> {
    const resources: ActionResourceObservation[] = [];
    if (
      this.knowledge &&
      !(await this.knowledge.actionContextCurrent(client, {
        ...context,
        provider: 'codex',
        generation: authority.contextGeneration,
      }))
    )
      return null;
    if (request.project_id) {
      const row = (
        await client.query(
          "SELECT id,version,title,description FROM cos.records WHERE scope_id=$1 AND id=$2 AND kind='project' AND lifecycle='active' FOR SHARE",
          [context.scopeId, request.project_id],
        )
      ).rows[0];
      if (!row) return null;
      resources.push({
        kind: 'project',
        id: row.id,
        version: row.version,
        digest: digest(row),
        observed_at: observedAt,
      });
    }
    if (request.mission_id) {
      const row = (
        await client.query(
          `SELECT m.version,m.state,w.body,w.digest FROM cos.missions m JOIN cos.mission_work_orders w ON w.scope_id=m.scope_id AND w.id=m.id
        WHERE m.scope_id=$1 AND m.id=$2 AND m.state IN ('running','awaiting_review','completed','partial') FOR SHARE OF m`,
          [context.scopeId, request.mission_id],
        )
      ).rows[0];
      const origin = row?.body?.origin;
      if (
        !row ||
        digest(row.body) !== row.digest ||
        !origin ||
        origin.scopeId !== context.scopeId ||
        origin.ownerId !== context.ownerId ||
        origin.sessionId !== context.sessionId ||
        origin.agentGroupId !== context.agentGroupId ||
        origin.bindingDigest !== authority.bindingDigest ||
        origin.contextGeneration !== authority.contextGeneration ||
        row.body.provider.model !== authority.provider.model ||
        row.body.provider.policyDigest !== authority.provider.policyDigest ||
        !this.knowledge
      )
        return null;
      const selected = row.body.request?.sources;
      if (
        !(await this.knowledge.missionSourcesCurrent(
          client,
          { ...context, provider: 'codex', generation: authority.contextGeneration },
          selected,
        ))
      )
        return null;
      resources.push({
        kind: 'mission',
        id: request.mission_id,
        version: row.version,
        digest: digest({ version: row.version, state: row.state, digest: row.digest }),
        observed_at: observedAt,
      });
      for (const source of selected) {
        const current = (
          await client.query(
            'SELECT id,version,current_revision_id FROM cos.sources WHERE scope_id=$1 AND id=$2 FOR SHARE',
            [context.scopeId, source.source_id],
          )
        ).rows[0];
        if (!current) return null;
        resources.push({
          kind: 'source',
          id: current.id,
          version: current.version,
          digest: digest(current),
          observed_at: observedAt,
        });
      }
    }
    return resources;
  }
  /** Called only after the unique request insertion, so provider IDs are allocated once inside its transaction. */
  async prepare(
    client: PoolClient,
    context: Context,
    requestId: string,
    request: CalendarActionRequest,
    prepared: PreparedAction,
    proposalId: string,
  ): Promise<CalendarActionChange | null> {
    const authority = this.dependencies?.authority(context),
      binding = await this.binding(client, context, request.binding_id);
    const clock = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    if (
      !binding ||
      !authority ||
      digest(authority) !== digest(prepared.authority) ||
      digest(binding) !== digest(prepared.binding) ||
      Date.parse(prepared.inspection.observedAt) < clock.getTime() - 30000 ||
      Date.parse(prepared.inspection.observedAt) > clock.getTime() + 2000 ||
      Date.parse(request.start) <= clock.getTime() ||
      Date.parse(request.start) - clock.getTime() > 90 * 86400000
    )
      return null;
    const related = await this.related(client, context, request, authority, instant(clock));
    if (!related || related.length > 10) return null;
    const resources: ActionResourceObservation[] = [
      {
        kind: 'writer_binding',
        id: request.binding_id,
        version: binding.version,
        digest: digest({ revision: binding.digest, authority }),
        observed_at: instant(clock),
      },
      {
        kind: 'availability',
        id: 'availability-' + digest({ calendarId: request.calendar_id, start: request.start, end: request.end }),
        version: 1,
        digest: availabilityObservationDigest(prepared.inspection),
        observed_at: prepared.inspection.observedAt,
      },
      ...related,
    ];
    const body = createActionIntent({
        context,
        request,
        requestId,
        destination: { instanceId: binding.body.instanceId, channelId: binding.body.channelId },
        resources,
        now: clock.getTime(),
      }),
      hash = digest(body);
    await client.query(
      'INSERT INTO cos.action_intents(scope_id,id,body,digest,authority,proposal_id,binding_id,calendar_id,event_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        context.scopeId,
        body.actionId,
        JSON.stringify(body),
        hash,
        JSON.stringify(authority),
        proposalId,
        request.binding_id,
        request.calendar_id,
        body.eventId,
        body.expiresAt,
      ],
    );
    await client.query("INSERT INTO cos.actions(scope_id,id,state) VALUES($1,$2,'waiting_approval')", [
      context.scopeId,
      body.actionId,
    ]);
    return actionPreview(body, hash);
  }
  async row(client: PoolClient, context: Context, id: string): Promise<StoredAction | null> {
    const row = (
      await client.query(
        'SELECT i.body,i.digest,i.authority,i.proposal_id,a.state FROM cos.action_intents i JOIN cos.actions a ON a.scope_id=i.scope_id AND a.id=i.id WHERE i.scope_id=$1 AND i.id=$2',
        [context.scopeId, id],
      )
    ).rows[0] as StoredAction | undefined;
    return row &&
      validActionIntent(row.body, row.digest) &&
      row.body.context.scopeId === context.scopeId &&
      row.body.context.ownerId === context.ownerId &&
      row.body.context.agentGroupId === context.agentGroupId &&
      row.body.context.sessionId === context.sessionId
      ? row
      : null;
  }
  async current(client: PoolClient, context: Context, row: StoredAction): Promise<boolean> {
    const authority = this.dependencies?.authority(context),
      binding = await this.binding(client, context, row.body.request.binding_id);
    if (
      !authority ||
      !binding ||
      digest(authority) !== digest(row.authority) ||
      row.body.resources.find((r) => r.kind === 'writer_binding')?.digest !==
        digest({ revision: binding.digest, authority }) ||
      row.body.resources.find((r) => r.kind === 'writer_binding')?.version !== binding.version
    )
      return false;
    const related = await this.related(client, context, row.body.request, authority, row.body.resources[0].observed_at);
    if (!related) return false;
    const summaries = (rs: ActionResourceObservation[]) =>
      rs.filter((r) => ['project', 'mission', 'source'].includes(r.kind)).map(({ observed_at: _at, ...r }) => r);
    return (
      digest(summaries(related)) === digest(summaries(row.body.resources)) &&
      digest(this.dependencies?.authority(context) ?? null) === digest(authority)
    );
  }
  async validateChange(client: PoolClient, context: Context, change: CalendarActionChange): Promise<boolean> {
    if (!validCalendarActionChange(change)) return false;
    const row = await this.row(client, context, change.action_id);
    return (
      !!row &&
      ['waiting_approval', 'queued'].includes(row.state) &&
      digest(actionPreview(row.body, row.digest)) === digest(change) &&
      (await client.query('SELECT $1::timestamptz>clock_timestamp() AS current', [row.body.expiresAt])).rows[0]
        .current &&
      (await this.current(client, context, row))
    );
  }
  async applyApproved(
    client: PoolClient,
    context: Context,
    proposal: { id: string; decision_ingress_id: string },
    change: CalendarActionChange,
  ): Promise<Result> {
    const row = await this.row(client, context, change.action_id);
    if (
      !row ||
      row.proposal_id !== proposal.id ||
      !proposal.decision_ingress_id ||
      !(await this.validateChange(client, context, change))
    )
      return { status: 'conflict' };
    const result = await client.query(
      "UPDATE cos.actions SET state='queued',updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2 AND state='waiting_approval' AND NOT cancel_requested RETURNING id",
      [context.scopeId, change.action_id],
    );
    return result.rowCount === 1 ? { status: 'ok', record_id: change.action_id } : { status: 'conflict' };
  }
  async inspect(context: Context, id: string): Promise<Result> {
    if (!validActionId(id) || context.origin) return { status: 'denied' };
    return this.transaction(async (client) => {
      if (!(await this.scopeCurrent(client, context))) return { status: 'denied' };
      const row = await this.row(client, context, id);
      if (!row) return { status: 'denied' };
      const head = (
        await client.query('SELECT state,reason,result,cancel_requested FROM cos.actions WHERE scope_id=$1 AND id=$2', [
          context.scopeId,
          id,
        ])
      ).rows[0];
      return {
        status: 'ok',
        action_id: id,
        ...head,
        request: row.body.request,
        event_id: row.body.eventId,
        expires_at: row.body.expiresAt,
      };
    });
  }
  async cancel(context: Context, id: string): Promise<Result> {
    if (!validActionId(id) || context.origin) return { status: 'denied' };
    return this.transaction(async (client) => {
      if (!(await this.scopeCurrent(client, context))) return { status: 'denied' };
      const row = await this.row(client, context, id);
      if (!row) return { status: 'denied' };
      const head = (
        await client.query('SELECT state FROM cos.actions WHERE scope_id=$1 AND id=$2 FOR UPDATE', [
          context.scopeId,
          id,
        ])
      ).rows[0];
      if (['verified', 'blocked', 'failed', 'cancelled'].includes(head.state))
        return { status: 'ok', action_id: id, state: head.state, deleted: false };
      this.dependencies?.witness?.cancel(row.body, row.digest);
      const started =
        (
          await client.query('SELECT 1 FROM cos.action_request_starts WHERE scope_id=$1 AND action_id=$2', [
            context.scopeId,
            id,
          ])
        ).rowCount === 1 || !!this.dependencies?.witness?.find(id);
      await client.query(
        'UPDATE cos.actions SET cancel_requested=true,state=$3,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2',
        [context.scopeId, id, started ? 'outcome_uncertain' : 'cancelled'],
      );
      await client.query('INSERT INTO cos.action_receipts(scope_id,id,action_id,kind,body) VALUES($1,$2,$3,$4,$5)', [
        context.scopeId,
        randomUUID(),
        id,
        started ? 'cancel_requested' : 'cancelled',
        JSON.stringify({ ownerId: context.ownerId, ingressId: context.ingressId, deleted: false }),
      ]);
      return { status: 'ok', action_id: id, state: started ? 'outcome_uncertain' : 'cancelled', deleted: false };
    }, true);
  }
}
