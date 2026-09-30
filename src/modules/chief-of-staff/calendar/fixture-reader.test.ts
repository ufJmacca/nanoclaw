import { describe, expect, it } from 'vitest';
import { fixtureCalendarReader } from './fixture-reader.js';
import { collectCalendarSnapshot } from './snapshot.js';
import { GOOGLE_EVENT_READ_SCOPE, type CalendarAccess } from './reader.js';

const window = { timeMin: '2026-10-03T14:00:00Z', timeMax: '2026-10-04T13:00:00Z', timeZone: 'Australia/Sydney' };
const grant = (): CalendarAccess => ({
  generation: 'binding-1',
  calendarIds: ['selected'],
  auth: 'ready',
  scopes: [GOOGLE_EVENT_READ_SCOPE],
});
const day = (id: string, date = '2026-10-04', end = '2026-10-05') => ({
  id,
  etag: 'v1',
  summary: id,
  start: { date },
  end: { date: end },
});
const setup = () =>
  fixtureCalendarReader({
    access: grant(),
    calendars: {
      selected: [day('all-day'), { id: 'cancelled', status: 'cancelled' }, day('outside', '2026-10-05', '2026-10-06')],
      foreign: [day('private')],
    },
    pageSize: 1,
  });

describe('S03 fixture CalendarReader', () => {
  it('collects all pages, includes cancellations and filters all-day events by local calendar boundaries', async () => {
    const s = setup();
    const result = await collectCalendarSnapshot(s.reader, 'selected', window);
    expect(result.pages).toBe(2);
    expect(result.events.map((e) => e.providerEventId)).toEqual(['all-day', 'cancelled']);
    expect(result.events[0].start).toEqual({ kind: 'date', date: '2026-10-04' });
  });
  it('filters timed overlaps using exclusive end and start bounds', async () => {
    const s = setup();
    const timed = (id: string, start: string, end: string) => ({
      id,
      etag: 'v1',
      start: { dateTime: start },
      end: { dateTime: end },
    });
    s.replace('selected', [
      timed('before', '2026-10-03T12:00:00Z', window.timeMin),
      timed('after', window.timeMax, '2026-10-04T14:00:00Z'),
      timed('overlap', '2026-10-03T13:00:00Z', '2026-10-03T15:00:00Z'),
    ]);
    expect((await collectCalendarSnapshot(s.reader, 'selected', window)).events.map((e) => e.providerEventId)).toEqual([
      'overlap',
    ]);
  });
  it('enforces selected calendars independently of a broadly scoped token', async () => {
    const s = setup();
    s.setAccess({ ...grant(), scopes: ['https://www.googleapis.com/auth/calendar'] });
    await expect(s.reader.list('foreign', window)).rejects.toThrow('calendar_not_selected');
    await expect(s.reader.get('foreign', 'private', window.timeZone)).rejects.toThrow('calendar_not_selected');
    expect((await s.reader.get('selected', 'all-day', window.timeZone)).summary).toBe('all-day');
  });
  it.each(['expired', 'revoked', 'disconnected'] as const)('stops reads when access becomes %s', async (auth) => {
    const s = setup();
    s.setAccess({ ...grant(), auth });
    await expect(s.reader.list('selected', window)).rejects.toThrow('calendar_auth_' + auth);
    await expect(s.reader.get('selected', 'all-day', window.timeZone)).rejects.toThrow('calendar_auth_' + auth);
  });
  it('rejects missing scopes and absent events with fixed errors', async () => {
    const s = setup();
    await expect(s.reader.get('selected', 'missing', window.timeZone)).rejects.toThrow('calendar_event_missing');
    s.setAccess({ ...grant(), scopes: [] });
    await expect(s.reader.list('selected', window)).rejects.toThrow('calendar_scope_denied');
  });
  it('binds pagination tokens to the frozen query, calendar and fixture revision', async () => {
    const s = setup();
    const first = await s.reader.list('selected', window);
    expect(first.nextPageToken).toBeTruthy();
    await expect(
      s.reader.list('selected', { ...window, timeMax: '2026-10-05T13:00:00Z' }, first.nextPageToken!),
    ).rejects.toThrow('calendar_invalid_page');
    s.replace('selected', [day('changed')]);
    await expect(s.reader.list('selected', window, first.nextPageToken!)).rejects.toThrow('calendar_invalid_page');
  });
  it('injects a later-page failure without returning a partial snapshot and can recover', async () => {
    const s = setup();
    s.failPage(2);
    await expect(collectCalendarSnapshot(s.reader, 'selected', window)).rejects.toThrow('calendar_unavailable');
    s.failPage(null);
    expect((await collectCalendarSnapshot(s.reader, 'selected', window)).events).toHaveLength(2);
  });
  it('isolates fixture state from mutable caller inputs and returned access', async () => {
    const a = grant(),
      events = [day('original')];
    const s = fixtureCalendarReader({ access: a, calendars: { selected: events } });
    a.calendarIds.length = 0;
    events[0].summary = 'changed';
    (await s.reader.access()).calendarIds.length = 0;
    expect((await s.reader.get('selected', 'original', window.timeZone)).summary).toBe('original');
  });
});
