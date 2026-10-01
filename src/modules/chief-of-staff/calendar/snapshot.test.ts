import { describe, expect, it, vi } from 'vitest';
import { collectCalendarSnapshot } from './snapshot.js';
import { normalizeEvent } from './normalization.js';
import { GOOGLE_EVENT_READ_SCOPE, type CalendarAccess, type CalendarPage, type CalendarReader } from './reader.js';
const window = { timeMin: '2026-09-01T00:00:00Z', timeMax: '2027-01-01T00:00:00Z', timeZone: 'Australia/Sydney' };
const event = (id: string) =>
  normalizeEvent(
    { id, etag: '"v1"', summary: id, start: { date: '2026-10-02' }, end: { date: '2026-10-03' } },
    window.timeZone,
  );
const access: CalendarAccess = {
  generation: 'binding-1',
  calendarIds: ['selected'],
  auth: 'ready',
  scopes: [GOOGLE_EVENT_READ_SCOPE],
};
const reader = (pages: CalendarPage[]) =>
  ({
    access: vi.fn(async () => structuredClone(access)),
    list: vi.fn(async () => pages.shift()!),
    get: vi.fn(async () => event('a')),
  }) satisfies CalendarReader;
describe('S03 bounded snapshot collection', () => {
  it('S03-T01: follows every page, including an empty page, using one frozen window', async () => {
    const r = reader([
      { events: [event('a')], accessRole: 'reader', nextPageToken: 'page2' },
      { events: [], accessRole: 'reader', nextPageToken: 'page3' },
      { events: [event('b')], accessRole: 'reader', nextPageToken: null },
    ]);
    const snapshot = await collectCalendarSnapshot(r, 'selected', window);
    expect(snapshot.events.map((e: { providerEventId: string }) => e.providerEventId)).toEqual(['a', 'b']);
    expect(snapshot.window).toEqual(window);
    expect(snapshot.pages).toBe(3);
    expect(snapshot.accessGeneration).toBe('binding-1');
    expect(r.list.mock.calls).toEqual([
      ['selected', window, undefined],
      ['selected', window, 'page2'],
      ['selected', window, 'page3'],
    ]);
  });
  it('S03-T01: partial provider failure returns no complete snapshot', async () => {
    const r = reader([]);
    r.list
      .mockResolvedValueOnce({ events: [event('a')], accessRole: 'reader', nextPageToken: 'next' })
      .mockRejectedValueOnce(new Error('calendar_unavailable'));
    await expect(collectCalendarSnapshot(r, 'selected', window)).rejects.toThrow('calendar_unavailable');
    expect(r.list).toHaveBeenCalledTimes(2);
  });
  it('S03-T03: identical duplicates collapse, conflicting page revisions fail', async () => {
    const duplicate = event('a');
    const r = reader([
      { events: [duplicate], accessRole: 'reader', nextPageToken: 'next' },
      { events: [duplicate], accessRole: 'reader', nextPageToken: null },
    ]);
    expect((await collectCalendarSnapshot(r, 'selected', window)).events).toHaveLength(1);
    const conflict = reader([
      { events: [duplicate], accessRole: 'reader', nextPageToken: 'next' },
      { events: [{ ...duplicate, contentDigest: 'f'.repeat(64) }], accessRole: 'reader', nextPageToken: null },
    ]);
    await expect(collectCalendarSnapshot(conflict, 'selected', window)).rejects.toThrow('calendar_snapshot_changed');
  });
  it('S03-T01: repeated pagination tokens and excessive pages fail closed', async () => {
    const r = reader([]);
    r.list.mockResolvedValue({ events: [], accessRole: 'reader', nextPageToken: 'repeated' });
    await expect(collectCalendarSnapshot(r, 'selected', window)).rejects.toThrow('calendar_pagination_limit');
    expect(r.list).toHaveBeenCalledTimes(2);
    const many = reader(
      Array.from({ length: 20 }, (_, i) => ({ events: [], accessRole: 'reader', nextPageToken: 'page-' + i })),
    );
    await expect(collectCalendarSnapshot(many, 'selected', window)).rejects.toThrow('calendar_pagination_limit');
    expect(many.list).toHaveBeenCalledTimes(20);
  });
  it('S03-T04/T05: checks selected calendar and current authority throughout collection', async () => {
    const denied = reader([]);
    await expect(collectCalendarSnapshot(denied, 'other', window)).rejects.toThrow('calendar_not_selected');
    expect(denied.list).not.toHaveBeenCalled();
    const revoked = reader([{ events: [event('a')], accessRole: 'reader', nextPageToken: null }]);
    revoked.access.mockResolvedValueOnce(access).mockResolvedValue({ ...access, auth: 'revoked' });
    await expect(collectCalendarSnapshot(revoked, 'selected', window)).rejects.toThrow('calendar_auth_revoked');
  });
  it('discards accumulated content on an access-role downgrade', async () => {
    const r = reader([
      { events: [event('a')], accessRole: 'owner', nextPageToken: 'next' },
      { events: [event('b')], accessRole: 'reader', nextPageToken: null },
    ]);
    await expect(collectCalendarSnapshot(r, 'selected', window)).rejects.toThrow('calendar_access_changed');
  });
  it('bounds accumulated provider content even across individually valid pages', async () => {
    const large = { ...event('a'), description: 'x'.repeat(16000) };
    const r = reader(
      Array.from({ length: 20 }, (_, i) => ({
        events: Array.from({ length: 250 }, (_, j) => ({ ...large, providerEventId: `event-${i}-${j}` })),
        accessRole: 'reader',
        nextPageToken: i === 19 ? null : 'page-' + i,
      })),
    );
    await expect(collectCalendarSnapshot(r, 'selected', window)).rejects.toThrow('calendar_snapshot_too_large');
  });
});
