import type { CalendarEvent, CalendarTime } from './normalization.js';
// PostgreSQL JSONB may reorder keys. Keep cited preview serialization independent of storage ordering.
const time = (value: CalendarTime | null): CalendarTime | null =>
  value === null
    ? null
    : value.kind === 'date'
      ? { kind: 'date', date: value.date }
      : { kind: 'instant', instant: value.instant, timeZone: value.timeZone };
/** This bounded preview is also the first cited source chunk. Full provider details remain separately retrievable. */
export function calendarPreview(event: CalendarEvent) {
  return {
    summary: [...(event.summary ?? 'Untitled event')].slice(0, 300).join(''),
    start: time(event.start),
    end: time(event.end),
    status: event.status,
    recurring: !!event.recurringEventId,
    original_start: time(event.originalStart),
    end_time_unspecified: event.endTimeUnspecified,
    transparent: event.transparent,
  };
}
