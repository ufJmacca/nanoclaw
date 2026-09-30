import { describe, expect, it, vi } from 'vitest';
import { googleCalendarReader } from './google-reader.js';
import { GOOGLE_EVENT_READ_SCOPE, type CalendarAccess } from './reader.js';
const window = { timeMin: '2026-09-01T00:00:00Z', timeMax: '2027-01-01T00:00:00Z', timeZone: 'Australia/Sydney' };
const rawEvent = {
  id: 'alpha',
  etag: '"v1"',
  summary: 'Prepare',
  start: { date: '2026-10-02' },
  end: { date: '2026-10-03' },
};
const grant = (): CalendarAccess => ({
  generation: 'binding-v1',
  calendarIds: ['selected@example.test'],
  auth: 'ready',
  scopes: [GOOGLE_EVENT_READ_SCOPE],
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const setup = (responses: Response[] = [json({ accessRole: 'reader', items: [rawEvent] })]) => {
  const requests: { url: string; init: RequestInit }[] = [];
  const access = vi.fn(async () => grant());
  const token = vi.fn(async () => 'fixture-access-token');
  const sleep = vi.fn(async (_milliseconds: number) => {});
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return responses.shift()!;
  });
  return {
    reader: googleCalendarReader({
      access,
      token,
      fetch,
      sleep,
      now: () => Date.parse('2026-10-01T00:00:00Z'),
      random: () => 0,
    }),
    access,
    token,
    sleep,
    fetch,
    requests,
  };
};
describe('S03 Google read-only transport', () => {
  it('freezes the caller window before an asynchronous credential request', async () => {
    const s = setup([
      json({
        accessRole: 'reader',
        items: [
          { ...rawEvent, start: { dateTime: '2026-10-02T00:00:00Z' }, end: { dateTime: '2026-10-02T01:00:00Z' } },
        ],
      }),
    ]);
    const selected = { ...window };
    const pending = s.reader.list('selected@example.test', selected);
    selected.timeZone = 'UTC';
    expect((await pending).events[0].start).toMatchObject({ timeZone: 'Australia/Sydney' });
  });
  it('does not dispatch after credential acquisition consumes the deadline', async () => {
    let clock = 0;
    const fetch = vi.fn(async () => json({ accessRole: 'reader', items: [] }));
    const r = googleCalendarReader({
      access: async () => grant(),
      token: async () => {
        clock = 31000;
        return 'fixture';
      },
      now: () => clock,
      fetch,
    });
    await expect(r.list('selected@example.test', window)).rejects.toThrow('calendar_unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('S03-T08: hides transport cleanup failures as well as provider error bodies', async () => {
    const body = new ReadableStream({
      cancel() {
        throw new Error('private-cleanup-canary');
      },
    });
    const s = setup([new Response(body, { status: 401 })]);
    await expect(s.reader.list('selected@example.test', window)).rejects.toThrow(/^calendar_unavailable$/);
  });
  it('S03-T01/T06: fixes the endpoint, method and window and follows only an opaque page token', async () => {
    const s = setup([
      json({ accessRole: 'reader', items: [rawEvent], nextPageToken: 'page-2/+=' }),
      json({ accessRole: 'reader', items: [] }),
    ]);
    const first = await s.reader.list('selected@example.test', window);
    expect(first.events).toHaveLength(1);
    expect(first.nextPageToken).toBe('page-2/+=');
    await s.reader.list('selected@example.test', window, first.nextPageToken!);
    for (const [i, r] of s.requests.entries()) {
      const u = new URL(r.url);
      expect(u.origin).toBe('https://www.googleapis.com');
      expect(u.pathname).toBe('/calendar/v3/calendars/selected%40example.test/events');
      expect(u.searchParams.get('timeMin')).toBe(window.timeMin);
      expect(u.searchParams.get('timeMax')).toBe(window.timeMax);
      expect(u.searchParams.get('singleEvents')).toBe('true');
      expect(u.searchParams.get('showDeleted')).toBe('true');
      expect(u.searchParams.get('syncToken')).toBeNull();
      expect(u.searchParams.get('pageToken')).toBe(i ? 'page-2/+=' : null);
      expect(r.init.method).toBe('GET');
      expect(r.init.redirect).toBe('error');
      expect(r.init.body).toBeUndefined();
      expect(r.init.headers).toEqual({ Authorization: 'Bearer fixture-access-token', Accept: 'application/json' });
    }
  });
  it('S03-T04: an unselected calendar is refused before obtaining a token or making a request', async () => {
    const s = setup();
    await expect(s.reader.list('unselected@example.test', window)).rejects.toThrow('calendar_not_selected');
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.token).not.toHaveBeenCalled();
  });
  it('S03-T05: expired credentials stop reads and return no source text', async () => {
    const s = setup();
    s.access.mockResolvedValue({ ...grant(), auth: 'expired' });
    await expect(s.reader.list('selected@example.test', window)).rejects.toThrow('calendar_auth_expired');
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it('S03-T04: broader tokens still expose only list/get, never a generic write or URL operation', async () => {
    const s = setup();
    s.access.mockResolvedValue({ ...grant(), scopes: ['https://www.googleapis.com/auth/calendar'] });
    await s.reader.list('selected@example.test', window);
    expect(Object.keys(s.reader).sort()).toEqual(['access', 'get', 'list']);
    expect(s.requests[0].init.method).toBe('GET');
  });
  it('S03-T06: rejects unknown request fields, traversal and provider redirects', async () => {
    const s = setup([new Response(null, { status: 302, headers: { Location: 'https://attacker.example' } })]);
    await expect(
      s.reader.list('selected@example.test', { ...window, method: 'DELETE' } as typeof window),
    ).rejects.toThrow('calendar_invalid_window');
    await expect(s.reader.get('selected@example.test', '../other', 'UTC')).rejects.toThrow('calendar_invalid_request');
    await expect(s.reader.list('selected@example.test', window)).rejects.toThrow('calendar_unavailable');
    expect(s.requests).toHaveLength(1);
  });
  it('S03-T07: honors Retry-After with a finite retry ceiling', async () => {
    const s = setup([
      json({}, 429, { 'Retry-After': '2' }),
      json({}, 503),
      json({ accessRole: 'owner', items: [rawEvent] }),
    ]);
    expect((await s.reader.list('selected@example.test', window)).events).toHaveLength(1);
    expect(s.sleep.mock.calls.map((c) => c[0])).toEqual([2000, 1000]);
    expect(s.requests).toHaveLength(3);
    const exhausted = setup([json({}, 429), json({}, 429), json({}, 429)]);
    await expect(exhausted.reader.list('selected@example.test', window)).rejects.toThrow('calendar_rate_limited');
    expect(exhausted.requests).toHaveLength(3);
  });
  it('S03-T07: a retry hint beyond the operation budget stops without retrying early', async () => {
    const s = setup([json({}, 429, { 'Retry-After': '3600' })]);
    await expect(s.reader.list('selected@example.test', window)).rejects.toThrow('calendar_rate_limited');
    expect(s.sleep).not.toHaveBeenCalled();
    expect(s.requests).toHaveLength(1);
  });
  it('S03-T05/T08: revocation and error bodies are reduced to safe codes', async () => {
    const s = setup([json({ error: { message: 'secret-body-canary' } }, 401)]);
    await expect(s.reader.list('selected@example.test', window)).rejects.toThrow(/^calendar_auth_revoked$/);
    expect(s.requests).toHaveLength(1);
  });
  it('revalidates the binding after the response before returning content', async () => {
    const s = setup();
    s.access.mockResolvedValueOnce(grant()).mockResolvedValueOnce({ ...grant(), generation: 'changed' });
    await expect(s.reader.list('selected@example.test', window)).rejects.toThrow('calendar_access_changed');
  });
  it('rejects an oversized provider body and inadequate calendar access', async () => {
    const s = setup([
      json({ items: [], private: 'x'.repeat(1024 * 1024 + 1) }),
      json({ accessRole: 'freeBusyReader', items: [rawEvent] }),
    ]);
    await expect(s.reader.list('selected@example.test', window)).rejects.toThrow('calendar_response_too_large');
    await expect(s.reader.list('selected@example.test', window)).rejects.toThrow('calendar_access_revoked');
  });
  it('S03-T02: fetches and verifies only the requested event', async () => {
    const s = setup([json(rawEvent), json({ ...rawEvent, id: 'other' })]);
    expect((await s.reader.get('selected@example.test', 'alpha', window.timeZone)).providerEventId).toBe('alpha');
    expect(new URL(s.requests[0].url).pathname.endsWith('/events/alpha')).toBe(true);
    await expect(s.reader.get('selected@example.test', 'alpha', window.timeZone)).rejects.toThrow(
      'calendar_invalid_response',
    );
  });
});
