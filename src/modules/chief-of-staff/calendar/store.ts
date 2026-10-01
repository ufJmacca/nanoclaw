import type { PoolClient } from 'pg';
import type { Context, Result } from '../domain/contracts.js';
import { digest } from '../domain/contracts.js';
import { BoundedDatabase, DatabaseUnavailable } from '../store/client.js';
import {
  calendarZone,
  hasCalendarControl,
  normalizeEvent,
  validateCalendarWindow,
  type CalendarEvent,
  type CalendarTime,
  type CalendarWindow,
} from './normalization.js';
import type { CalendarSnapshot } from './snapshot.js';
import { hasCalendarReadScope, type CalendarAccess } from './reader.js';
import { calendarEventOverlaps } from './window.js';
import type { CalendarEvidence, CalendarCapture } from './evidence.js';

export type CalendarBindingInput = {
  id: string;
  provider: 'google' | 'fixture';
  calendarIds: string[];
  scopes: string[];
  credentialRef?: string;
  timeZone: string;
  processingProviders: string[];
};
export type CalendarConnection = CalendarBindingInput & { version: number; auth: CalendarAccess['auth'] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validCalendarId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 1024 &&
  !hasCalendarControl(value) &&
  !value.includes(' ') &&
  value !== '.' &&
  value !== '..';
type Binding = {
  id: string;
  provider: string;
  selected_calendar_ids: string[];
  permission_scopes: string[];
  credential_ref: string | null;
  time_zone: string;
  processing_providers: string[];
  version: number;
  auth: CalendarAccess['auth'];
};
async function authorised(client: PoolClient, context: Context, mutation: boolean): Promise<boolean> {
  return (
    (
      await client.query(
        `SELECT id FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 AND status='active' FOR ${mutation ? 'UPDATE' : 'SHARE'}`,
        [context.scopeId, context.ownerId, context.agentGroupId],
      )
    ).rowCount === 1
  );
}
function bindingValid(input: CalendarBindingInput): boolean {
  if (
    !input ||
    Object.keys(input).some(
      (k) =>
        !['id', 'provider', 'calendarIds', 'scopes', 'credentialRef', 'timeZone', 'processingProviders'].includes(k),
    ) ||
    !uuid.test(input.id) ||
    !['google', 'fixture'].includes(input.provider)
  )
    return false;
  if (
    !Array.isArray(input.calendarIds) ||
    input.calendarIds.length < 1 ||
    input.calendarIds.length > 20 ||
    !input.calendarIds.every(validCalendarId) ||
    new Set(input.calendarIds).size !== input.calendarIds.length
  )
    return false;
  if (
    !Array.isArray(input.scopes) ||
    input.scopes.length > 50 ||
    !input.scopes.every((s) => typeof s === 'string' && s.length <= 200 && !hasCalendarControl(s)) ||
    !hasCalendarReadScope(input.scopes)
  )
    return false;
  if (
    !Array.isArray(input.processingProviders) ||
    input.processingProviders.length > 2 ||
    !input.processingProviders.every((p) => ['codex', 'claude'].includes(p)) ||
    new Set(input.processingProviders).size !== input.processingProviders.length
  )
    return false;
  if (
    (input.provider === 'google' && !input.credentialRef) ||
    (input.credentialRef !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(input.credentialRef))
  )
    return false;
  try {
    calendarZone(input.timeZone);
    return true;
  } catch {
    return false;
  }
}
function windowValid(window: CalendarWindow): boolean {
  try {
    validateCalendarWindow(window);
    return true;
  } catch {
    return false;
  }
}
/** Validate even host-created normalized data before it becomes durable evidence. */
function snapshotValid(value: CalendarSnapshot): boolean {
  try {
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'accessGeneration,accessRole,calendarId,events,pages,window' ||
      !validCalendarId(value.calendarId) ||
      !windowValid(value.window) ||
      !Number.isSafeInteger(value.pages) ||
      value.pages < 1 ||
      value.pages > 20 ||
      !['reader', 'writerWithoutPrivateAccess', 'writer', 'owner'].includes(value.accessRole) ||
      !Array.isArray(value.events) ||
      value.events.length > 5000 ||
      Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024
    )
      return false;
    const ids = new Set<string>();
    const rawTime = (time: CalendarTime | null) =>
      time === null ? undefined : time.kind === 'date' ? { date: time.date } : { dateTime: time.instant };
    for (const event of value.events) {
      if (!validCalendarId(event.providerEventId) || ids.has(event.providerEventId)) return false;
      ids.add(event.providerEventId);
      const normalized = normalizeEvent(
        {
          id: event.providerEventId,
          etag: event.providerVersion ?? undefined,
          updated: event.updatedAt ?? undefined,
          status: event.status,
          summary: event.summary ?? undefined,
          description: event.description ?? undefined,
          location: event.location ?? undefined,
          start: rawTime(event.start),
          end: rawTime(event.end),
          recurringEventId: event.recurringEventId ?? undefined,
          originalStartTime: rawTime(event.originalStart),
          transparency: event.transparent ? 'transparent' : 'opaque',
          endTimeUnspecified: event.endTimeUnspecified,
        },
        value.window.timeZone,
      );
      if (digest(normalized) !== digest(event) || !calendarEventOverlaps(normalized, value.window)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export class CalendarStore {
  /** Bounded metadata inventory for the current model-processing profile. No tokens or source text. */
  async coverage(context: Context & { provider: string }, offset = 0): Promise<Result> {
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) return { status: 'denied' };
    return this.transaction(context, false, async (client) => {
      const rows = (
        await client.query(
          `SELECT b.id AS binding_id,c.calendar_id,b.time_zone,b.auth,b.permission_scopes,
        s.current_snapshot AS snapshot_id,s.last_attempt,s.last_success_at,s.last_attempt_at,g.coverage_window,a.status AS attempt_status
        FROM cos.calendar_bindings b CROSS JOIN LATERAL unnest(b.selected_calendar_ids) AS c(calendar_id)
        LEFT JOIN cos.calendar_states s ON s.scope_id=b.scope_id AND s.binding_id=b.id AND s.calendar_id=c.calendar_id
        LEFT JOIN cos.calendar_snapshots g ON g.scope_id=s.scope_id AND g.binding_id=s.binding_id AND g.id=s.current_snapshot
        LEFT JOIN cos.calendar_snapshots a ON a.scope_id=s.scope_id AND a.binding_id=s.binding_id AND a.id=s.last_attempt
        WHERE b.scope_id=$1 AND $2=ANY(b.processing_providers) ORDER BY b.id,c.calendar_id LIMIT 11 OFFSET $3`,
          [context.scopeId, context.provider, offset],
        )
      ).rows;
      const more = rows.length > 10;
      if (more) rows.pop();
      return { status: 'ok', items: rows, next_offset: more ? offset + 10 : null };
    });
  }
  constructor(
    readonly database: BoundedDatabase,
    readonly hooks: { beforePublishCommit?(): Promise<void>; afterPublishCommit?(): Promise<void> } = {},
    readonly evidence?: CalendarEvidence,
  ) {}
  private async transaction(
    context: Context,
    mutation: boolean,
    operation: (client: PoolClient) => Promise<Result>,
    publishing = false,
    signal?: AbortSignal,
  ): Promise<Result> {
    try {
      return await this.database.run(
        async (client) => {
          await client.query('BEGIN');
          if (publishing && this.evidence) await client.query('SELECT pg_advisory_xact_lock(73101004)');
          if (!(await authorised(client, context, mutation))) {
            await client.query('COMMIT');
            return { status: 'denied' };
          }
          const result = await operation(client);
          if (publishing && result.status === 'ok') await this.hooks.beforePublishCommit?.();
          if (signal?.aborted) throw new DatabaseUnavailable(mutation ? 'pending' : 'unavailable');
          await client.query('COMMIT');
          if (publishing && result.status === 'ok') await this.hooks.afterPublishCommit?.();
          return result;
        },
        mutation,
        signal,
      );
    } catch (error) {
      if (error instanceof DatabaseUnavailable)
        return { status: mutation && error.code === 'pending' ? 'pending' : 'unavailable' };
      throw error;
    }
  }
  private async binding(client: PoolClient, context: Context, id: string): Promise<Binding | undefined> {
    return (
      await client.query('SELECT * FROM cos.calendar_bindings WHERE scope_id=$1 AND id=$2', [context.scopeId, id])
    ).rows[0];
  }
  /** Trusted connector host only. Credential references are never part of model RPC responses. */
  async connection(context: Context, id: string, signal?: AbortSignal): Promise<Result> {
    if (!uuid.test(id)) return { status: 'denied' };
    return this.transaction(
      context,
      false,
      async (client) => {
        const b = await this.binding(client, context, id);
        if (!b) return { status: 'denied' };
        const binding: CalendarConnection = {
          id: b.id,
          provider: b.provider as CalendarConnection['provider'],
          calendarIds: b.selected_calendar_ids,
          scopes: b.permission_scopes,
          ...(b.credential_ref ? { credentialRef: b.credential_ref } : {}),
          timeZone: b.time_zone,
          processingProviders: b.processing_providers,
          version: b.version,
          auth: b.auth,
        };
        return { status: 'ok', binding };
      },
      false,
      signal,
    );
  }
  /** Trusted operator only. Account linking and model processing permissions are never accepted from RPC. */
  async bind(context: Context, input: CalendarBindingInput): Promise<Result> {
    if (!bindingValid(input)) return { status: 'denied' };
    const data = structuredClone(input);
    return this.transaction(context, true, async (client) => {
      const old = await this.binding(client, context, data.id);
      const identity = {
        provider: data.provider,
        calendarIds: data.calendarIds,
        scopes: data.scopes,
        credentialRef: data.credentialRef ?? null,
        timeZone: data.timeZone,
        processingProviders: data.processingProviders,
      };
      if (old) {
        const previous = {
          provider: old.provider,
          calendarIds: old.selected_calendar_ids,
          scopes: old.permission_scopes,
          credentialRef: old.credential_ref,
          timeZone: old.time_zone,
          processingProviders: old.processing_providers,
        };
        return {
          status: old.auth === 'ready' && digest(previous) === digest(identity) ? 'ok' : 'conflict',
          binding_id: data.id,
          access_generation: data.id + ':' + old.version,
        };
      }
      await client.query(
        `INSERT INTO cos.calendar_bindings(scope_id,id,provider,selected_calendar_ids,permission_scopes,credential_ref,time_zone,processing_providers,auth,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ready',$9)`,
        [
          context.scopeId,
          data.id,
          data.provider,
          data.calendarIds,
          data.scopes,
          data.credentialRef ?? null,
          data.timeZone,
          data.processingProviders,
          JSON.stringify({
            owner_id: context.ownerId,
            ingress_id: context.ingressId,
            origin: 'operator_calendar_binding',
          }),
        ],
      );
      for (const calendar of data.calendarIds)
        await client.query('INSERT INTO cos.calendar_states(scope_id,binding_id,calendar_id) VALUES($1,$2,$3)', [
          context.scopeId,
          data.id,
          calendar,
        ]);
      return { status: 'ok', binding_id: data.id, access_generation: data.id + ':1' };
    });
  }
  async start(
    context: Context,
    bindingId: string,
    calendarId: string,
    id: string,
    requested: CalendarWindow,
    signal?: AbortSignal,
  ): Promise<Result> {
    if (!uuid.test(bindingId) || !uuid.test(id) || !validCalendarId(calendarId) || !windowValid(requested))
      return { status: 'denied' };
    const window = { ...requested };
    return this.transaction(
      context,
      true,
      async (client) => {
        const b = await this.binding(client, context, bindingId);
        if (
          !b ||
          b.auth !== 'ready' ||
          !b.selected_calendar_ids.includes(calendarId) ||
          b.time_zone !== window.timeZone ||
          !hasCalendarReadScope(b.permission_scopes)
        )
          return { status: 'denied' };
        const old = (
          await client.query('SELECT * FROM cos.calendar_snapshots WHERE scope_id=$1 AND binding_id=$2 AND id=$3', [
            context.scopeId,
            bindingId,
            id,
          ])
        ).rows[0];
        if (old) {
          if (
            old.calendar_id !== calendarId ||
            old.binding_version !== b.version ||
            digest(old.coverage_window) !== digest(window)
          )
            return { status: 'conflict' };
          return {
            status: old.status === 'superseded' ? 'conflict' : 'ok',
            snapshot_id: id,
            access_generation: bindingId + ':' + b.version,
            snapshot_status: old.status,
            ...(old.status === 'complete' ? { result: old.result } : {}),
          };
        }
        await client.query(
          `INSERT INTO cos.calendar_snapshots(scope_id,binding_id,calendar_id,id,binding_version,coverage_window,status) VALUES($1,$2,$3,$4,$5,$6,'collecting')`,
          [context.scopeId, bindingId, calendarId, id, b.version, JSON.stringify(window)],
        );
        await client.query(
          'UPDATE cos.calendar_states SET last_attempt=$4,last_attempt_at=clock_timestamp() WHERE scope_id=$1 AND binding_id=$2 AND calendar_id=$3',
          [context.scopeId, bindingId, calendarId, id],
        );
        return {
          status: 'ok',
          snapshot_id: id,
          access_generation: bindingId + ':' + b.version,
          snapshot_status: 'collecting',
        };
      },
      false,
      signal,
    );
  }
  async publish(
    context: Context,
    bindingId: string,
    id: string,
    input: CalendarSnapshot,
    signal?: AbortSignal,
  ): Promise<Result> {
    if (signal?.aborted) return { status: 'unavailable' };
    if (!uuid.test(bindingId) || !uuid.test(id) || !snapshotValid(input)) return { status: 'denied' };
    const snapshot = structuredClone(input),
      hash = digest(snapshot);
    const commit = (captured: CalendarCapture[]) =>
      this.publishCaptured(context, bindingId, id, snapshot, hash, captured, signal);
    if (!this.evidence) return commit([]);
    const admitted = await this.transaction(
      context,
      false,
      async (client) => {
        const binding = await this.binding(client, context, bindingId);
        return {
          status:
            binding?.auth === 'ready' &&
            binding.selected_calendar_ids.includes(snapshot.calendarId) &&
            snapshot.accessGeneration === bindingId + ':' + binding.version
              ? 'ok'
              : 'denied',
        };
      },
      false,
      signal,
    );
    if (admitted.status !== 'ok') return admitted;
    return this.evidence.capture(context, bindingId, snapshot, commit, signal);
  }
  private publishCaptured(
    context: Context,
    bindingId: string,
    id: string,
    snapshot: CalendarSnapshot,
    hash: string,
    captured: CalendarCapture[],
    signal?: AbortSignal,
  ): Promise<Result> {
    return this.transaction(
      context,
      true,
      async (client) => {
        const b = await this.binding(client, context, bindingId);
        if (
          !b ||
          b.auth !== 'ready' ||
          snapshot.accessGeneration !== bindingId + ':' + b.version ||
          !b.selected_calendar_ids.includes(snapshot.calendarId) ||
          !hasCalendarReadScope(b.permission_scopes)
        )
          return { status: 'denied' };
        const attempt = (
          await client.query('SELECT * FROM cos.calendar_snapshots WHERE scope_id=$1 AND binding_id=$2 AND id=$3', [
            context.scopeId,
            bindingId,
            id,
          ])
        ).rows[0];
        if (
          !attempt ||
          attempt.calendar_id !== snapshot.calendarId ||
          attempt.binding_version !== b.version ||
          digest(attempt.coverage_window) !== digest(snapshot.window)
        )
          return { status: 'conflict' };
        if (attempt.status === 'complete')
          return attempt.content_digest === hash ? attempt.result : { status: 'conflict' };
        const state = (
          await client.query(
            'SELECT last_attempt FROM cos.calendar_states WHERE scope_id=$1 AND binding_id=$2 AND calendar_id=$3',
            [context.scopeId, bindingId, snapshot.calendarId],
          )
        ).rows[0];
        if (state?.last_attempt !== id || attempt.status === 'superseded') {
          await client.query(
            "UPDATE cos.calendar_snapshots SET status='superseded' WHERE scope_id=$1 AND binding_id=$2 AND id=$3",
            [context.scopeId, bindingId, id],
          );
          return { status: 'conflict' };
        }
        const previous = (
          await client.query(
            'SELECT provider_event_id,event,content_digest,provider_version,version,lifecycle FROM cos.calendar_observations WHERE scope_id=$1 AND binding_id=$2 AND calendar_id=$3',
            [context.scopeId, bindingId, snapshot.calendarId],
          )
        ).rows as Array<{
          provider_event_id: string;
          event: CalendarEvent;
          content_digest: string;
          provider_version: string | null;
          version: number;
          lifecycle: string;
        }>;
        const old = new Map(previous.map((row) => [row.provider_event_id, row]));
        const observations = snapshot.events.map((event) => {
          const prev = old.get(event.providerEventId);
          const changed =
            !prev || prev.content_digest !== event.contentDigest || prev.provider_version !== event.providerVersion;
          return {
            provider_event_id: event.providerEventId,
            event,
            content_digest: event.contentDigest,
            provider_version: event.providerVersion,
            version: prev ? prev.version + (changed ? 1 : 0) : 1,
            lifecycle: event.status === 'cancelled' ? 'cancelled' : 'current',
            changed,
          };
        });
        const seen = new Set(snapshot.events.map((event) => event.providerEventId));
        const retired = previous
          .filter(
            (row) =>
              !seen.has(row.provider_event_id) &&
              row.lifecycle === 'current' &&
              calendarEventOverlaps(row.event, snapshot.window),
          )
          .map((row) => row.provider_event_id);
        await client.query(
          `INSERT INTO cos.calendar_observations(scope_id,binding_id,calendar_id,provider_event_id,event,content_digest,provider_version,version,lifecycle,last_snapshot)
        SELECT $1,$2,$3,x.provider_event_id,x.event,x.content_digest,x.provider_version,x.version,x.lifecycle,$4 FROM jsonb_to_recordset($5::jsonb) AS x(provider_event_id text,event jsonb,content_digest text,provider_version text,version integer,lifecycle text)
        ON CONFLICT(scope_id,binding_id,calendar_id,provider_event_id) DO UPDATE SET event=EXCLUDED.event,content_digest=EXCLUDED.content_digest,provider_version=EXCLUDED.provider_version,version=EXCLUDED.version,lifecycle=EXCLUDED.lifecycle,last_snapshot=EXCLUDED.last_snapshot,updated_at=clock_timestamp()`,
          [context.scopeId, bindingId, snapshot.calendarId, id, JSON.stringify(observations)],
        );
        await client.query(
          `INSERT INTO cos.calendar_event_revisions(scope_id,binding_id,calendar_id,provider_event_id,version,event,snapshot_id)
        SELECT $1,$2,$3,x.provider_event_id,x.version,x.event,$4 FROM jsonb_to_recordset($5::jsonb) AS x(provider_event_id text,version integer,event jsonb)`,
          [
            context.scopeId,
            bindingId,
            snapshot.calendarId,
            id,
            JSON.stringify(observations.filter((row) => row.changed)),
          ],
        );
        await client.query(
          "UPDATE cos.calendar_observations SET lifecycle='retired',updated_at=clock_timestamp() WHERE scope_id=$1 AND binding_id=$2 AND calendar_id=$3 AND provider_event_id=ANY($4)",
          [context.scopeId, bindingId, snapshot.calendarId, retired],
        );
        const result = {
          status: 'ok',
          snapshot_id: id,
          access_role: snapshot.accessRole,
          pages: snapshot.pages,
          event_count: observations.length,
          retired_count: retired.length,
        };
        await client.query(
          "UPDATE cos.calendar_snapshots SET status='complete',content_digest=$4,result=$5,failure_code=NULL,completed_at=clock_timestamp() WHERE scope_id=$1 AND binding_id=$2 AND id=$3",
          [context.scopeId, bindingId, id, hash, JSON.stringify(result)],
        );
        await client.query(
          'UPDATE cos.calendar_states SET current_snapshot=$4,last_success_at=clock_timestamp() WHERE scope_id=$1 AND binding_id=$2 AND calendar_id=$3',
          [context.scopeId, bindingId, snapshot.calendarId, id],
        );
        await this.evidence?.publish(client, context, bindingId, id, snapshot, b.processing_providers, captured);
        return result;
      },
      true,
      signal,
    );
  }
  async fail(context: Context, bindingId: string, id: string, code: string, signal?: AbortSignal): Promise<Result> {
    if (!uuid.test(bindingId) || !uuid.test(id)) return { status: 'denied' };
    const safe = [
      'calendar_unavailable',
      'calendar_rate_limited',
      'calendar_pagination_limit',
      'calendar_invalid_response',
      'calendar_snapshot_changed',
      'calendar_snapshot_too_large',
    ].includes(code)
      ? code
      : 'calendar_refresh_failed';
    return this.transaction(
      context,
      true,
      async (client) => {
        const result = await client.query(
          "UPDATE cos.calendar_snapshots SET status='failed',failure_code=$4 WHERE scope_id=$1 AND binding_id=$2 AND id=$3 AND status IN ('collecting','failed')",
          [context.scopeId, bindingId, id, safe],
        );
        return { status: result.rowCount ? 'ok' : 'conflict' };
      },
      false,
      signal,
    );
  }
  async setAuth(
    context: Context,
    bindingId: string,
    auth: CalendarAccess['auth'],
    signal?: AbortSignal,
  ): Promise<Result> {
    // Reconnection requires a newly authorised binding. This path can only reduce access.
    if (!uuid.test(bindingId) || !['expired', 'revoked', 'disconnected'].includes(auth)) return { status: 'denied' };
    return this.transaction(
      context,
      true,
      async (client) => {
        const b = await this.binding(client, context, bindingId);
        if (!b) return { status: 'denied' };
        if (b.auth === auth) return { status: 'ok' };
        await client.query(
          'UPDATE cos.calendar_bindings SET auth=$3,version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2',
          [context.scopeId, bindingId, auth],
        );
        await client.query(
          "UPDATE cos.calendar_observations SET lifecycle='quarantined',updated_at=clock_timestamp() WHERE scope_id=$1 AND binding_id=$2 AND lifecycle IN ('current','cancelled')",
          [context.scopeId, bindingId],
        );
        await this.evidence?.revoke(client, context, bindingId, b.version + 1);
        return { status: 'ok' };
      },
      false,
      signal,
    );
  }
  async read(context: Context & { provider: string }, bindingId: string, calendarId: string): Promise<Result> {
    return this.readSnapshot(context, bindingId, calendarId, false);
  }
  /** Private host selection input, never returned directly to a model. */
  async evidenceSnapshot(
    context: Context & { provider: string },
    bindingId: string,
    calendarId: string,
  ): Promise<Result> {
    return this.readSnapshot(context, bindingId, calendarId, true);
  }
  private async readSnapshot(
    context: Context & { provider: string },
    bindingId: string,
    calendarId: string,
    evidenceMode: boolean,
  ): Promise<Result> {
    if (!uuid.test(bindingId) || !validCalendarId(calendarId)) return { status: 'denied' };
    return this.transaction(context, false, async (client) => {
      const b = await this.binding(client, context, bindingId);
      if (!b || !b.selected_calendar_ids.includes(calendarId) || !b.processing_providers.includes(context.provider))
        return { status: 'denied' };
      if (b.auth !== 'ready')
        return {
          status: 'ok',
          coverage: 'unavailable',
          warning: 'calendar_auth_' + b.auth,
          time_zone: b.time_zone,
          items: [],
        };
      if (!hasCalendarReadScope(b.permission_scopes))
        return {
          status: 'ok',
          coverage: 'unavailable',
          warning: 'calendar_scope_denied',
          time_zone: b.time_zone,
          items: [],
        };
      const state = (
        await client.query(
          `SELECT s.*,g.coverage_window,a.status AS attempt_status FROM cos.calendar_states s
        LEFT JOIN cos.calendar_snapshots g ON g.scope_id=s.scope_id AND g.binding_id=s.binding_id AND g.id=s.current_snapshot
        LEFT JOIN cos.calendar_snapshots a ON a.scope_id=s.scope_id AND a.binding_id=s.binding_id AND a.id=s.last_attempt
        WHERE s.scope_id=$1 AND s.binding_id=$2 AND s.calendar_id=$3`,
          [context.scopeId, bindingId, calendarId],
        )
      ).rows[0];
      const complete =
        state?.current_snapshot && state.current_snapshot === state.last_attempt && state.attempt_status === 'complete';
      const rows = state?.current_snapshot
        ? (
            await client.query(
              evidenceMode
                ? `SELECT o.event,o.version,o.source_id,s.current_revision_id AS revision_id,
                (s.status IN ('current','stale') AND $5=ANY(s.processing_providers) AND a.lifecycle='published'
                 AND NOT EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=s.scope_id AND t.source_id=s.id)) AS readable
                FROM cos.calendar_observations o LEFT JOIN cos.sources s ON s.scope_id=o.scope_id AND s.id=o.source_id
                LEFT JOIN cos.source_revisions r ON r.scope_id=s.scope_id AND r.id=s.current_revision_id
                LEFT JOIN cos.artifacts a ON a.scope_id=r.scope_id AND a.id=r.artifact_id
                WHERE o.scope_id=$1 AND o.binding_id=$2 AND o.calendar_id=$3 AND o.last_snapshot=$4 AND o.lifecycle='current' ORDER BY o.provider_event_id LIMIT 5000`
                : "SELECT event,version FROM cos.calendar_observations WHERE scope_id=$1 AND binding_id=$2 AND calendar_id=$3 AND last_snapshot=$4 AND lifecycle='current' ORDER BY provider_event_id LIMIT 5000",
              [
                context.scopeId,
                bindingId,
                calendarId,
                state.current_snapshot,
                ...(evidenceMode ? [context.provider] : []),
              ],
            )
          ).rows
        : [];
      return {
        status: 'ok',
        coverage: complete ? 'complete' : 'incomplete',
        warning: complete
          ? null
          : state?.attempt_status === 'failed'
            ? 'calendar_refresh_failed'
            : state?.last_attempt
              ? 'calendar_refresh_incomplete'
              : 'calendar_not_synced',
        snapshot_id: state?.current_snapshot ?? null,
        time_zone: b.time_zone,
        window: state?.coverage_window ?? null,
        last_attempt_at: state?.last_attempt_at ?? null,
        last_success_at: state?.last_success_at ?? null,
        items: evidenceMode ? rows : rows.map((row) => ({ event: row.event, version: row.version })),
      };
    });
  }
}
