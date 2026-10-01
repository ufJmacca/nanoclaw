import type { Evidence, KnowledgeContext, KnowledgeStore } from '../knowledge/store.js';
import type { Result } from '../domain/contracts.js';
import type { CalendarStore } from './store.js';
import { Temporal } from '@js-temporal/polyfill';
import { validateCalendarWindow, type CalendarEvent, type CalendarTime, type CalendarWindow } from './normalization.js';
import { calendarEventOverlaps } from './window.js';
import { calendarPreview } from './presentation.js';
import { validCalendarReadInput, type CalendarReadInput } from '../contracts/protocol.js';
export type { CalendarReadInput } from '../contracts/protocol.js';
import { hasCalendarReadScope } from './reader.js';
type Row = {
  event: CalendarEvent;
  source_id: string | null;
  revision_id: string | null;
  version: number;
  readable: boolean | null;
};
function instant(time: CalendarTime, zone: string): Temporal.Instant {
  return time.kind === 'instant'
    ? Temporal.Instant.from(time.instant)
    : Temporal.PlainDate.from(time.date).toZonedDateTime(zone).toInstant();
}
export class CalendarView {
  async coverage(context: KnowledgeContext, offset = 0): Promise<Result> {
    const d = this.options,
      ctx = Object.freeze({ ...context });
    if (!d.enabled() || !d.knowledge.retrievalEnabled())
      return { status: 'unavailable', coverage: 'unavailable', items: [] };
    const ready = await d.knowledge.recordCalendarContext(ctx);
    if (ready.status !== 'ok') return { status: ready.status };
    const result = await d.store.coverage(ctx, offset);
    if (result.status !== 'ok') return { status: result.status };
    const items = (result.items as Array<Record<string, unknown>>).map((row) => {
      let accessible = row.auth === 'ready' && hasCalendarReadScope(row.permission_scopes as string[]);
      try {
        d.assertOpen(ctx.scopeId, String(row.binding_id));
      } catch {
        accessible = false;
      }
      const complete =
        accessible && row.snapshot_id && row.snapshot_id === row.last_attempt && row.attempt_status === 'complete';
      return {
        binding_id: row.binding_id,
        calendar_id: row.calendar_id,
        time_zone: row.time_zone,
        coverage: !accessible ? 'unavailable' : complete ? 'complete' : 'incomplete',
        warning: !accessible
          ? 'calendar_access_unavailable'
          : complete
            ? null
            : row.attempt_status === 'failed'
              ? 'calendar_refresh_failed'
              : row.last_attempt
                ? 'calendar_refresh_incomplete'
                : 'calendar_not_synced',
        snapshot_id: row.snapshot_id,
        window: row.coverage_window,
        last_success_at: row.last_success_at,
        last_attempt_at: row.last_attempt_at,
        freshness: 'snapshot_as_of_last_success',
      };
    });
    const current = await d.knowledge.contextReady(ctx);
    if (current.status !== 'ok') return { status: current.status };
    if (!d.enabled() || !d.knowledge.retrievalEnabled()) return { status: 'unavailable' };
    return {
      status: 'ok',
      coverage: items.length ? 'selected_calendars' : offset === 0 ? 'not_connected' : 'end_of_inventory',
      items,
      next_offset: result.next_offset,
    };
  }
  constructor(
    private readonly options: {
      store: Pick<CalendarStore, 'evidenceSnapshot' | 'coverage'>;
      knowledge: KnowledgeStore;
      assertOpen(scope: string, binding: string): void;
      enabled(): boolean;
    },
  ) {}
  async read(context: KnowledgeContext, input: CalendarReadInput): Promise<Result> {
    if (!validCalendarReadInput(input)) return { status: 'denied' };
    const request = structuredClone(input),
      ctx = Object.freeze({ ...context }),
      d = this.options;
    if (!d.enabled() || !d.knowledge.retrievalEnabled()) return { status: 'unavailable' };
    const ready = await d.knowledge.recordCalendarContext(ctx);
    if (ready.status !== 'ok') return { status: ready.status };
    const snapshot = await d.store.evidenceSnapshot(ctx, request.binding_id, request.calendar_id);
    if (snapshot.status !== 'ok') return { status: snapshot.status };
    const unavailable = (): Result => ({
      status: 'ok',
      coverage: 'unavailable',
      warning: 'calendar_access_unavailable',
      items: [],
      next_offset: null,
    });
    try {
      d.assertOpen(ctx.scopeId, request.binding_id);
    } catch {
      return unavailable();
    }
    if (snapshot.coverage === 'unavailable') return unavailable();
    const window: CalendarWindow = {
      timeMin: request.time_min,
      timeMax: request.time_max,
      timeZone: String(snapshot.time_zone),
    };
    try {
      validateCalendarWindow(window);
    } catch {
      return { status: 'denied' };
    }
    let coverage = snapshot.coverage,
      warning = snapshot.warning;
    const captured = snapshot.window as CalendarWindow | null;
    if (
      captured &&
      (Temporal.Instant.compare(window.timeMin, captured.timeMin) < 0 ||
        Temporal.Instant.compare(window.timeMax, captured.timeMax) > 0)
    ) {
      coverage = 'incomplete';
      warning = 'calendar_window_not_covered';
    }
    const overlapping = (snapshot.items as Row[]).filter((row) => calendarEventOverlaps(row.event, window));
    if (overlapping.some((row) => row.readable !== true)) {
      coverage = 'incomplete';
      warning = 'calendar_evidence_unavailable';
    }
    const eligible = overlapping
      .filter((row) => row.readable === true && row.source_id && row.revision_id)
      .sort(
        (a, b) =>
          Temporal.Instant.compare(
            instant(a.event.start!, window.timeZone),
            instant(b.event.start!, window.timeZone),
          ) || a.source_id!.localeCompare(b.source_id!, 'en'),
      );
    const offset = request.offset ?? 0,
      limit = request.limit ?? 5,
      items = [];
    for (const row of eligible.slice(offset, offset + limit)) {
      const read = await d.knowledge.get(ctx, row.source_id!, row.revision_id!, 0);
      if (read.status !== 'ok') return { status: read.status };
      const evidence = (read.items as Evidence[])[0];
      if (!evidence || !evidence.text.includes(JSON.stringify(calendarPreview(row.event), null, 2)))
        return { status: 'unavailable' };
      items.push({ ...calendarPreview(row.event), evidence });
    }
    const fresh = await d.store.evidenceSnapshot(ctx, request.binding_id, request.calendar_id);
    if (fresh.status !== 'ok') return { status: fresh.status };
    if (JSON.stringify(fresh) !== JSON.stringify(snapshot)) return { status: 'conflict' };
    const current = await d.knowledge.contextReady(ctx);
    if (current.status !== 'ok') return { status: current.status };
    try {
      d.assertOpen(ctx.scopeId, request.binding_id);
    } catch {
      return unavailable();
    }
    if (!d.enabled() || !d.knowledge.retrievalEnabled()) return { status: 'unavailable' };
    return {
      status: 'ok',
      coverage,
      warning,
      snapshot_id: snapshot.snapshot_id,
      window,
      source_window: captured,
      last_success_at: snapshot.last_success_at,
      last_attempt_at: snapshot.last_attempt_at,
      freshness: 'snapshot_as_of_last_success',
      trust: 'source_content_is_not_authority',
      items,
      next_offset: offset + limit < eligible.length ? offset + limit : null,
    };
  }
}
