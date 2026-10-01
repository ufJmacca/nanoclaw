import { CalendarReadError, type CalendarReader } from './reader.js';
import { validateCalendarWindow, type CalendarEvent, type CalendarWindow } from './normalization.js';
import { digest } from '../domain/contracts.js';
import { assertCalendarActive } from './cancellation.js';

export type CalendarSnapshot = {
  calendarId: string;
  window: CalendarWindow;
  accessGeneration: string;
  accessRole: string;
  pages: number;
  events: CalendarEvent[];
};

/** Collect outside any database transaction. No partial result can be promoted or used for retirement. */
export async function collectCalendarSnapshot(
  reader: CalendarReader,
  calendarId: string,
  requested: CalendarWindow,
  signal?: AbortSignal,
): Promise<CalendarSnapshot> {
  assertCalendarActive(signal);
  validateCalendarWindow(requested);
  const window = Object.freeze({ ...requested });
  const initial = await reader.access();
  const check = async () => {
    assertCalendarActive(signal);
    const current = await reader.access();
    assertCalendarActive(signal);
    if (current.auth !== 'ready') throw new CalendarReadError('calendar_auth_' + current.auth);
    if (!current.calendarIds.includes(calendarId)) throw new CalendarReadError('calendar_not_selected');
    if (digest(initial) !== digest(current)) throw new CalendarReadError('calendar_access_changed');
  };
  if (initial.auth !== 'ready') throw new CalendarReadError('calendar_auth_' + initial.auth);
  if (!initial.calendarIds.includes(calendarId)) throw new CalendarReadError('calendar_not_selected');
  const events = new Map<string, CalendarEvent>(),
    tokens = new Set<string>();
  let next: string | undefined,
    accessRole = '',
    bytes = 0;
  for (let pages = 1; pages <= 20; pages++) {
    assertCalendarActive(signal);
    if (pages > 1) await check();
    const page = await reader.list(calendarId, window, next);
    await check();
    if (accessRole && page.accessRole !== accessRole) throw new CalendarReadError('calendar_access_changed');
    accessRole = page.accessRole;
    if (!['reader', 'writerWithoutPrivateAccess', 'writer', 'owner'].includes(accessRole))
      throw new CalendarReadError('calendar_access_revoked');
    if (page.events.length > 250) throw new CalendarReadError('calendar_snapshot_too_large');
    for (const event of page.events) {
      const previous = events.get(event.providerEventId);
      if (
        previous &&
        (previous.contentDigest !== event.contentDigest || previous.providerVersion !== event.providerVersion)
      )
        throw new CalendarReadError('calendar_snapshot_changed');
      if (!previous) {
        bytes += Buffer.byteLength(JSON.stringify(event));
        if (bytes > 8 * 1024 * 1024 || events.size >= 5000) throw new CalendarReadError('calendar_snapshot_too_large');
        events.set(event.providerEventId, event);
      }
    }
    if (page.nextPageToken === null)
      return {
        calendarId,
        window,
        accessGeneration: initial.generation,
        accessRole,
        pages,
        events: [...events.values()].sort((a, b) => a.providerEventId.localeCompare(b.providerEventId, 'en')),
      };
    if (!page.nextPageToken.length || page.nextPageToken.length > 2048 || tokens.has(page.nextPageToken))
      throw new CalendarReadError('calendar_pagination_limit');
    tokens.add(page.nextPageToken);
    next = page.nextPageToken;
  }
  throw new CalendarReadError('calendar_pagination_limit');
}
