import { Temporal } from '@js-temporal/polyfill';
import { digest } from '../domain/contracts.js';
import { CalendarReadError, hasCalendarReadScope, type CalendarReader, type CalendarAccess } from './reader.js';
import {
  normalizeEvent,
  validateCalendarWindow,
  type CalendarEvent,
  type CalendarWindow,
  type CalendarTime,
} from './normalization.js';

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

/** Synthetic host fixture only; this object has no account credentials or network capability. */
export function fixtureCalendarReader(options: {
  access: CalendarAccess;
  calendars: Record<string, unknown[]>;
  pageSize?: number;
}): {
  reader: CalendarReader;
  setAccess(access: CalendarAccess): void;
  replace(calendarId: string, events: unknown[]): void;
  failPage(page: number | null): void;
} {
  let access = structuredClone(options.access),
    revision = 1,
    failedPage: number | null = null;
  const calendars = new Map(Object.entries(structuredClone(options.calendars)));
  const pageSize = options.pageSize ?? 250;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 250) throw new Error('calendar_invalid_fixture');
  const selected = (calendarId: string) => {
    if (access.auth !== 'ready') throw new CalendarReadError('calendar_auth_' + access.auth);
    if (!access.calendarIds.includes(calendarId)) throw new CalendarReadError('calendar_not_selected');
    if (!hasCalendarReadScope(access.scopes)) throw new CalendarReadError('calendar_scope_denied');
    const raw = calendars.get(calendarId);
    if (!raw) throw new CalendarReadError('calendar_access_revoked');
    return raw;
  };
  const reader: CalendarReader = Object.freeze({
    access: async () => structuredClone(access),
    list: async (calendarId: string, window: CalendarWindow, pageToken?: string) => {
      validateCalendarWindow(window);
      const raw = selected(calendarId);
      const events = raw
        .map((event) => normalizeEvent(event, window.timeZone))
        .filter((event) => calendarEventOverlaps(event, window));
      const key = digest({ revision, access, calendarId, window, pageSize });
      const page = pageToken === undefined ? 0 : Number(pageToken.split(':')[1]);
      if (
        pageToken !== undefined &&
        (!Number.isSafeInteger(page) || page < 1 || pageToken !== key + ':' + page || page * pageSize >= events.length)
      )
        throw new CalendarReadError('calendar_invalid_page');
      if (page + 1 === failedPage) throw new CalendarReadError('calendar_unavailable');
      return {
        events: events.slice(page * pageSize, (page + 1) * pageSize),
        nextPageToken: (page + 1) * pageSize < events.length ? key + ':' + (page + 1) : null,
        accessRole: 'reader',
      };
    },
    get: async (calendarId: string, eventId: string, timeZone: string) => {
      const event = selected(calendarId)
        .map((value) => normalizeEvent(value, timeZone))
        .find((value) => value.providerEventId === eventId);
      if (!event) throw new CalendarReadError('calendar_event_missing');
      return event;
    },
  });
  return {
    reader,
    setAccess(value) {
      access = structuredClone(value);
      revision++;
    },
    replace(calendarId, events) {
      calendars.set(calendarId, structuredClone(events));
      revision++;
    },
    failPage(page) {
      failedPage = page;
    },
  };
}
