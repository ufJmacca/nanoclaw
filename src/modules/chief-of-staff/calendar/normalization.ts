import { Temporal } from '@js-temporal/polyfill';
import { digest } from '../domain/contracts.js';

export type CalendarTime = { kind: 'date'; date: string } | { kind: 'instant'; instant: string; timeZone: string };
export type CalendarWindow = { timeMin: string; timeMax: string; timeZone: string };
export type CalendarEvent = {
  providerEventId: string;
  providerVersion: string | null;
  updatedAt: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
  summary: string | null;
  description: string | null;
  location: string | null;
  start: CalendarTime | null;
  end: CalendarTime | null;
  recurringEventId: string | null;
  originalStart: CalendarTime | null;
  transparent: boolean;
  endTimeUnspecified: boolean;
  contentDigest: string;
};
export const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function calendarText(value: unknown, maximum: number, optional = false): string | null {
  if (value === undefined && optional) return null;
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    (!optional && !value.length) ||
    hasCalendarControl(value, true)
  )
    throw new Error('calendar_invalid_event');
  return value;
}
export function calendarZone(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 80 || /^[+-]/.test(value))
    throw new Error('calendar_invalid_zone');
  new Intl.DateTimeFormat('en', { timeZone: value });
  return value;
}
function normalizeTime(value: unknown, displayZone: string): CalendarTime {
  if (!object(value)) throw new Error('calendar_invalid_event');
  if (value.date !== undefined) {
    if (value.dateTime !== undefined || typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date))
      throw new Error('calendar_invalid_event');
    return { kind: 'date', date: Temporal.PlainDate.from(value.date, { overflow: 'reject' }).toString() };
  }
  const text = calendarText(value.dateTime, 80)!;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/.test(text) ||
    text.endsWith('-00:00')
  )
    throw new Error('calendar_invalid_event');
  const hasOffset = /(?:Z|[+-]\d{2}:\d{2})$/.test(text);
  let instant: Temporal.Instant;
  if (value.timeZone !== undefined) {
    const zone = calendarZone(value.timeZone);
    // Never guess which side of a DST overlap/gap the provider meant. Explicit offsets must agree with the zone.
    instant = Temporal.ZonedDateTime.from(text + '[' + zone + ']', {
      disambiguation: 'reject',
      offset: 'reject',
      overflow: 'reject',
    }).toInstant();
  } else {
    if (!hasOffset) throw new Error('calendar_invalid_event');
    instant = Temporal.Instant.from(text);
  }
  return { kind: 'instant', instant: instant.toString(), timeZone: displayZone };
}

/** Bounded selected fields only; arbitrary provider metadata never becomes executable authority. */
export function normalizeEvent(value: unknown, timeZone: string): CalendarEvent {
  try {
    calendarZone(timeZone);
    if (!object(value) || value.recurrence !== undefined) throw new Error('calendar_invalid_event');
    const status = value.status ?? 'confirmed';
    if (status !== 'confirmed' && status !== 'tentative' && status !== 'cancelled')
      throw new Error('calendar_invalid_event');
    const cancelled = status === 'cancelled';
    const recurringEventId = calendarText(value.recurringEventId, 1024, true);
    const originalStart =
      value.originalStartTime === undefined ? null : normalizeTime(value.originalStartTime, timeZone);
    if (!!recurringEventId !== !!originalStart) throw new Error('calendar_invalid_event');
    const start = cancelled ? null : normalizeTime(value.start, timeZone);
    const end = cancelled ? null : normalizeTime(value.end, timeZone);
    if (start && end) {
      if (
        start.kind !== end.kind ||
        (start.kind === 'date' && end.kind === 'date' && Temporal.PlainDate.compare(start.date, end.date) >= 0) ||
        (start.kind === 'instant' &&
          end.kind === 'instant' &&
          Temporal.Instant.compare(start.instant, end.instant) >= 0)
      )
        throw new Error('calendar_invalid_event');
    }
    const normalized: Omit<CalendarEvent, 'contentDigest'> = {
      providerEventId: calendarText(value.id, 1024)!,
      providerVersion: calendarText(value.etag, 1024, cancelled),
      updatedAt:
        value.updated === undefined ? null : Temporal.Instant.from(calendarText(value.updated, 80)!).toString(),
      status,
      summary: cancelled ? null : calendarText(value.summary, 2000, true),
      description: cancelled ? null : calendarText(value.description, 16000, true),
      location: cancelled ? null : calendarText(value.location, 2000, true),
      start,
      end,
      recurringEventId,
      originalStart,
      transparent: value.transparency === 'transparent',
      endTimeUnspecified: value.endTimeUnspecified === true,
    };
    return { ...normalized, contentDigest: digest(normalized) };
  } catch (_error) {
    // Temporal exceptions can contain provider text; only this fixed code may leave the adapter.
    // eslint-disable-next-line preserve-caught-error -- A cause would disclose provider-controlled text.
    throw new Error('calendar_invalid_event');
  }
}

export function snapshotWindow(now: string, timeZone: string, pastDays = 30, futureDays = 90): CalendarWindow {
  try {
    calendarZone(timeZone);
    if (
      !Number.isInteger(pastDays) ||
      !Number.isInteger(futureDays) ||
      pastDays < 0 ||
      pastDays > 365 ||
      futureDays < 1 ||
      futureDays > 365
    )
      throw new Error('calendar_invalid_window');
    const today = Temporal.Instant.from(now).toZonedDateTimeISO(timeZone).toPlainDate();
    return {
      timeMin: today.subtract({ days: pastDays }).toZonedDateTime(timeZone).toInstant().toString(),
      timeMax: today.add({ days: futureDays }).toZonedDateTime(timeZone).toInstant().toString(),
      timeZone,
    };
  } catch (_error) {
    // eslint-disable-next-line preserve-caught-error -- Do not attach raw dates or timezone input.
    throw new Error('calendar_invalid_window');
  }
}

export function validateCalendarWindow(value: CalendarWindow): void {
  try {
    if (!object(value) || Object.keys(value).sort().join(',') !== 'timeMax,timeMin,timeZone')
      throw new Error('calendar_invalid_window');
    calendarZone(value.timeZone);
    const start = Temporal.Instant.from(value.timeMin),
      end = Temporal.Instant.from(value.timeMax);
    if (
      end.epochMilliseconds <= start.epochMilliseconds ||
      end.epochMilliseconds - start.epochMilliseconds > 732 * 86400000
    )
      throw new Error('calendar_invalid_window');
  } catch (_error) {
    // eslint-disable-next-line preserve-caught-error -- Provider/user time text must not escape in a cause.
    throw new Error('calendar_invalid_window');
  }
}

export function hasCalendarControl(text: string, allowWhitespace = false): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0)!;
    return (code < 32 && !(allowWhitespace && [9, 10, 13].includes(code))) || (code >= 127 && code <= 159);
  });
}
