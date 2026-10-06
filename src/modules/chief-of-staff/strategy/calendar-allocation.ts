import type { CalendarTime } from '../calendar/normalization.js';
import { Temporal } from '@js-temporal/polyfill';
/** Scheduled allocation only; never an observation of effort or outcome. */
export function scheduledMinutes(
  start: CalendarTime,
  end: CalendarTime,
  zone: string,
  minimum: string,
  maximum: string,
): number {
  const instant = (time: CalendarTime) =>
    time.kind === 'instant'
      ? Temporal.Instant.from(time.instant)
      : Temporal.PlainDate.from(time.date).toZonedDateTime(zone).toInstant();
  const first = Math.max(instant(start).epochMilliseconds, Temporal.Instant.from(minimum).epochMilliseconds),
    last = Math.min(instant(end).epochMilliseconds, Temporal.Instant.from(maximum).epochMilliseconds);
  return Math.floor(Math.max(0, last - first) / 60000);
}
