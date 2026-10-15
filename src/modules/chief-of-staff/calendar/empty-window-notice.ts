import type { PoolClient } from 'pg';
import { Temporal } from '@js-temporal/polyfill';
import type { KnowledgeContext } from '../knowledge/store.js';
import { digest } from '../domain/contracts.js';
import { validCalendarEmptyWindow, type CalendarEmptyWindow } from '../contracts/answer-protocol.js';
import { validateCalendarWindow, type CalendarEvent, type CalendarTime } from './normalization.js';
import { calendarEventOverlaps } from './window.js';
import { hasCalendarReadScope } from './reader.js';
import type { CalendarAnswerNotice } from './answer-notice.js';

/** Host-only proof. No model claim or cached read receipt can establish an empty window. */
export async function calendarEmptyWindowNotice(
  client: PoolClient,
  context: KnowledgeContext,
  request: CalendarEmptyWindow,
  options: { enabled(): boolean; access(scope: string, binding: string): boolean },
): Promise<CalendarAnswerNotice | null> {
  const open = () => options.enabled() && options.access(context.scopeId, request.binding_id);
  try {
    if (!validCalendarEmptyWindow(request) || !open()) return null;
    const row = (
      await client.query(
        `SELECT b.id,b.version,b.auth,b.selected_calendar_ids,b.processing_providers,b.permission_scopes,b.time_zone,
       s.current_snapshot,s.last_attempt,s.last_success_at,s.last_attempt_at,g.coverage_window,
       g.binding_version,g.status AS snapshot_status,g.result AS snapshot_result,a.status AS attempt_status
       FROM cos.calendar_bindings b
       JOIN cos.calendar_states s ON s.scope_id=b.scope_id AND s.binding_id=b.id AND s.calendar_id=$3
       JOIN cos.calendar_snapshots g ON g.scope_id=s.scope_id AND g.binding_id=s.binding_id AND g.id=s.current_snapshot
       JOIN cos.calendar_snapshots a ON a.scope_id=s.scope_id AND a.binding_id=s.binding_id AND a.id=s.last_attempt
       WHERE b.scope_id=$1 AND b.id=$2`,
        [context.scopeId, request.binding_id, request.calendar_id],
      )
    ).rows[0];
    if (
      !row ||
      row.auth !== 'ready' ||
      !row.selected_calendar_ids.includes(request.calendar_id) ||
      !row.processing_providers.includes(context.provider) ||
      !hasCalendarReadScope(row.permission_scopes) ||
      row.current_snapshot !== row.last_attempt ||
      row.snapshot_status !== 'complete' ||
      row.attempt_status !== 'complete' ||
      row.binding_version !== row.version ||
      !row.last_success_at ||
      !row.last_attempt_at
    )
      return null;
    const window = { timeMin: request.time_min, timeMax: request.time_max, timeZone: String(row.time_zone) };
    validateCalendarWindow(window);
    validateCalendarWindow(row.coverage_window);
    if (
      row.coverage_window.timeZone !== window.timeZone ||
      Temporal.Instant.compare(window.timeMin, row.coverage_window.timeMin) < 0 ||
      Temporal.Instant.compare(window.timeMax, row.coverage_window.timeMax) > 0
    )
      return null;
    // Include quarantined/retired rows: disappearance or hidden evidence must never become an empty result.
    const rows = (
      await client.query(
        `SELECT provider_event_id,event,version,lifecycle FROM cos.calendar_observations
       WHERE scope_id=$1 AND binding_id=$2 AND calendar_id=$3 AND last_snapshot=$4
       ORDER BY provider_event_id LIMIT 5001`,
        [context.scopeId, request.binding_id, request.calendar_id, row.current_snapshot],
      )
    ).rows;
    if (
      rows.length > 5000 ||
      !Number.isSafeInteger(row.snapshot_result?.event_count) ||
      row.snapshot_result.event_count !== rows.length
    )
      return null;
    const instant = (time: CalendarTime) => {
      if (time.kind === 'instant') return Temporal.Instant.from(time.instant);
      if (time.kind === 'date') return Temporal.PlainDate.from(time.date).toZonedDateTime(window.timeZone).toInstant();
      throw Error('invalid_calendar_time');
    };
    for (const observed of rows) {
      const event = observed.event as CalendarEvent;
      if (observed.lifecycle === 'cancelled' && event.status === 'cancelled') continue;
      if (
        observed.lifecycle !== 'current' ||
        !['confirmed', 'tentative'].includes(event.status) ||
        !event.start ||
        !event.end ||
        event.start.kind !== event.end.kind ||
        Temporal.Instant.compare(instant(event.start), instant(event.end)) >= 0 ||
        calendarEventOverlaps(event, window)
      )
        return null;
    }
    if (!open()) return null;
    const display = (value: string | Date) =>
      new Intl.DateTimeFormat('en-AU', {
        dateStyle: 'long',
        timeStyle: 'long',
        timeZone: window.timeZone,
      }).format(new Date(value));
    const label = (value: string) => value.replace(/[\\`*_{}[\]<>]/g, (c) => '\\' + c);
    const text = [
      `No observed meetings in calendar ${label(request.calendar_id)} for the requested window.`,
      `Window: ${display(window.timeMin)} to ${display(window.timeMax)} (end exclusive; ${label(window.timeZone)}).`,
      `Last successful calendar refresh: ${display(row.last_success_at)}.`,
      'This is a stored snapshot, not a live availability check. Coverage is complete for this selected calendar and window as of that refresh.',
    ].join('\n\n');
    return {
      text,
      fingerprint: digest({
        request,
        binding: {
          ...row,
          last_success_at: new Date(row.last_success_at).toISOString(),
          last_attempt_at: new Date(row.last_attempt_at).toISOString(),
        },
        observations: digest(rows),
      }),
    };
    // eslint-disable-next-line no-catch-all/no-catch-all -- Private proof failures deny publication without leaking database, path or event diagnostics.
  } catch {
    // A malformed, inaccessible or changing snapshot cannot support an empty-window claim.
    return null;
  }
}
