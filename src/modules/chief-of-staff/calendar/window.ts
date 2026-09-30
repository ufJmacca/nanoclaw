import { Temporal } from '@js-temporal/polyfill';
import type { CalendarEvent, CalendarWindow, CalendarTime } from './normalization.js';

/** Comparison only: an all-day event remains a date in all persisted and returned content. */
export function calendarEventOverlaps(event: CalendarEvent, window: CalendarWindow): boolean {
  if (event.status === 'cancelled') return true;
  const instant = (time: CalendarTime) =>
    time.kind === 'instant'
      ? Temporal.Instant.from(time.instant)
      : Temporal.PlainDate.from(time.date).toZonedDateTime(window.timeZone).toInstant();
  return (
    !!event.start &&
    !!event.end &&
    Temporal.Instant.compare(instant(event.end), window.timeMin) > 0 &&
    Temporal.Instant.compare(instant(event.start), window.timeMax) < 0
  );
}
