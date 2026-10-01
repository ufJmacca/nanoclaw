import { describe, expect, it, vi } from 'vitest';
import { CalendarConnector } from './connector.js';
import { CalendarReadError, GOOGLE_EVENT_READ_SCOPE } from './reader.js';
import { fixtureCalendarReader } from './fixture-reader.js';
import type { CalendarConnection, CalendarStore } from './store.js';
const context = {
  scopeId: 'scope',
  ownerId: 'owner',
  agentGroupId: 'group',
  sessionId: 'session',
  ingressId: 'ingress',
  provider: 'codex',
};
const window = { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-10T00:00:00Z', timeZone: 'UTC' };
const event = {
  id: 'event',
  etag: 'v1',
  summary: 'ConnectorFixtureCanary',
  start: { date: '2026-10-03' },
  end: { date: '2026-10-04' },
};
function setup(provider: 'google' | 'fixture' = 'google') {
  const binding: CalendarConnection = {
    id: 'binding',
    provider,
    calendarIds: ['selected'],
    scopes: [GOOGLE_EVENT_READ_SCOPE],
    credentialRef: provider === 'google' ? 'private-reference' : undefined,
    timeZone: 'UTC',
    processingProviders: ['codex'],
    version: 1,
    auth: 'ready',
  };
  const store = {
    connection: vi.fn<CalendarStore['connection']>(async () => ({ status: 'ok', binding: structuredClone(binding) })),
    start: vi.fn<CalendarStore['start']>(async () => ({ status: 'ok', snapshot_status: 'collecting' })),
    publish: vi.fn<CalendarStore['publish']>(async () => ({ status: 'ok', snapshot_id: 'snapshot' })),
    fail: vi.fn<CalendarStore['fail']>(async () => ({ status: 'ok' })),
    setAuth: vi.fn<CalendarStore['setAuth']>(async () => ({ status: 'ok' })),
  };
  const credentials = {
    inspect: vi.fn(async () => ({ auth: 'ready' as const, scopes: [GOOGLE_EVENT_READ_SCOPE], generation: 2 })),
    token: vi.fn(async () => 'PRIVATE_TOKEN_CANARY'),
  };
  let open = true;
  const fences = {
    runCheck: async <T>(_scope: string, _binding: string, operation: () => Promise<T>) => operation(),
    assertOpen: vi.fn(() => {
      if (!open) throw new CalendarReadError('calendar_auth_revoked');
    }),
    deny: vi.fn(() => {
      open = false;
    }),
  };
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify({ accessRole: 'reader', items: [event] }), { status: 200 }),
  );
  const fixture = fixtureCalendarReader({
    access: { generation: 'binding:1', auth: 'ready', calendarIds: ['selected'], scopes: [GOOGLE_EVENT_READ_SCOPE] },
    calendars: { selected: [event] },
  });
  const fixtureReader = vi.fn(() => fixture.reader);
  const options = {
    store,
    credentials,
    fences,
    fetch,
    fixtureReader,
    admitted: vi.fn(() => true),
    now: () => Date.parse('2026-10-05T01:00:00Z'),
  };
  const connector = new CalendarConnector(options);
  return { connector, options, store, binding, credentials, fences, fetch, fixture, fixtureReader };
}
describe('S03 trusted calendar connector', () => {
  it('uses the host credential owner and pinned Google reader after scoped admission', async () => {
    const s = setup();
    expect((await s.connector.refresh(context, 'binding', 'selected', 'snapshot', window)).result.status).toBe('ok');
    expect(s.credentials.token).toHaveBeenCalledWith('scope', 'binding', 'private-reference');
    const [url, request] = s.fetch.mock.calls[0]!;
    expect(new URL(url).origin + new URL(url).pathname).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/selected/events',
    );
    expect(new URL(url).searchParams.get('timeMin')).toBe(window.timeMin);
    expect(request).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: 'Bearer PRIVATE_TOKEN_CANARY' },
    });
    expect(s.store.publish.mock.calls[0]![3]).toMatchObject({
      accessGeneration: 'binding:1',
      events: [{ summary: 'ConnectorFixtureCanary' }],
    });
    expect(JSON.stringify(s.store.publish.mock.calls)).not.toContain('PRIVATE_TOKEN_CANARY');
    expect(s.fixtureReader).not.toHaveBeenCalled();
  });
  it('uses the same snapshot orchestration with an explicitly injected fixture reader and no credentials', async () => {
    const s = setup('fixture');
    expect((await s.connector.refresh(context, 'binding', 'selected', 'snapshot', window)).result.status).toBe('ok');
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.credentials.inspect).not.toHaveBeenCalled();
    expect(s.credentials.token).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'foreign', 'calendar', 'provider', 'fence'])(
    'denies %s access before credentials or provider requests',
    async (kind) => {
      const s = setup();
      if (kind === 'disabled') s.options.admitted.mockReturnValue(false);
      if (kind === 'foreign') s.store.connection.mockResolvedValue({ status: 'denied' });
      if (kind === 'calendar') s.binding.calendarIds = ['other'];
      if (kind === 'provider') s.binding.processingProviders = ['claude'];
      if (kind === 'fence') s.fences.deny();
      expect((await s.connector.refresh(context, 'binding', 'selected', 'snapshot', window)).result.status).toBe(
        'denied',
      );
      expect(s.credentials.token).not.toHaveBeenCalled();
      expect(s.fetch).not.toHaveBeenCalled();
      expect(s.store.start).not.toHaveBeenCalled();
    },
  );
  it('records permission loss durably before a database update, even if that update fails', async () => {
    const s = setup(),
      order: string[] = [];
    s.fetch.mockResolvedValue(new Response('', { status: 401 }));
    s.fences.deny.mockImplementation(() => {
      order.push('fence');
    });
    s.store.setAuth.mockImplementation(async () => {
      order.push('database');
      return { status: 'unavailable' };
    });
    expect((await s.connector.refresh(context, 'binding', 'selected', 'snapshot', window)).result).toMatchObject({
      status: 'unavailable',
      access_loss: 'revoked',
    });
    expect(order).toEqual(['fence', 'database']);
    expect(s.store.publish).not.toHaveBeenCalled();
  });
  it('checks the current binding again after network responses and never publishes after admission closes', async () => {
    const s = setup();
    s.fetch.mockImplementation(async () => {
      s.options.admitted.mockReturnValue(false);
      return new Response(JSON.stringify({ accessRole: 'reader', items: [event] }));
    });
    expect((await s.connector.refresh(context, 'binding', 'selected', 'snapshot', window)).result.status).toBe(
      'unavailable',
    );
    expect(s.store.publish).not.toHaveBeenCalled();
  });
  it('rejects scope loss in the credential owner without sending a request', async () => {
    const s = setup();
    s.credentials.inspect.mockResolvedValue({ auth: 'ready', scopes: [], generation: 2 });
    expect((await s.connector.refresh(context, 'binding', 'selected', 'snapshot', window)).result.status).toBe(
      'denied',
    );
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.fences.deny).toHaveBeenCalledWith('scope', 'binding', 'revoked');
  });
  it('reconciles a completed snapshot without reading or refreshing credentials', async () => {
    const s = setup();
    s.store.start.mockResolvedValue({
      status: 'ok',
      snapshot_status: 'complete',
      result: { status: 'ok', snapshot_id: 'snapshot' },
    });
    expect((await s.connector.refresh(context, 'binding', 'selected', 'snapshot', window)).result.status).toBe('ok');
    expect(s.credentials.inspect).not.toHaveBeenCalled();
    expect(s.credentials.token).not.toHaveBeenCalled();
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it('defaults to the bound time zone and 30/90-day window, rejecting caller zone changes', async () => {
    const s = setup();
    expect((await s.connector.refresh(context, 'binding', 'selected', 'snapshot')).result.status).toBe('ok');
    expect(s.store.start.mock.calls[0]![4]).toEqual({
      timeMin: '2026-09-05T00:00:00Z',
      timeMax: '2027-01-03T00:00:00Z',
      timeZone: 'UTC',
    });
    expect(
      (await s.connector.refresh(context, 'binding', 'selected', 'second', { ...window, timeZone: 'Europe/London' }))
        .result.status,
    ).toBe('denied');
  });
  it('operator disconnect validates ownership then writes local denial before the database', async () => {
    const s = setup(),
      order: string[] = [];
    s.fences.deny.mockImplementation(() => {
      order.push('fence');
    });
    s.store.setAuth.mockImplementation(async () => {
      order.push('database');
      return { status: 'pending' };
    });
    expect((await s.connector.disconnect(context, 'binding')).status).toBe('pending');
    expect(order).toEqual(['fence', 'database']);
    s.store.connection.mockResolvedValue({ status: 'denied' });
    expect((await s.connector.disconnect(context, 'binding')).status).toBe('denied');
    expect(order).toHaveLength(2);
  });
  it('keeps operator disconnect available while refresh admission is disabled', async () => {
    const s = setup();
    s.options.admitted.mockReturnValue(false);
    expect((await s.connector.disconnect(context, 'binding')).status).toBe('ok');
    expect(s.fences.deny).toHaveBeenCalled();
    expect(s.credentials.token).not.toHaveBeenCalled();
  });
  it('freezes the caller window before asynchronous binding checks', async () => {
    const s = setup(),
      selected = { ...window };
    s.store.connection.mockImplementation(async () => {
      selected.timeMax = '2026-11-01T00:00:00Z';
      return { status: 'ok', binding: structuredClone(s.binding) };
    });
    expect((await s.connector.refresh(context, 'binding', 'selected', 'snapshot', selected)).result.status).toBe('ok');
    expect(s.store.start.mock.calls[0]![4]).toEqual(window);
  });
  it('closes local disclosure and subsequent refresh if the durable denial write fails', async () => {
    const s = setup();
    s.fetch.mockResolvedValue(new Response('', { status: 401 }));
    s.fences.deny.mockImplementation(() => {
      throw new Error('PRIVATE_PATH_CANARY');
    });
    const first = await s.connector.refresh(context, 'binding', 'selected', 'snapshot', window);
    expect(first.result).toMatchObject({ status: 'unavailable', code: 'calendar_access_fence_failed' });
    expect(() => s.connector.assertOpen('scope', 'binding')).toThrow('calendar_auth_revoked');
    const attempts = s.fetch.mock.calls.length;
    expect((await s.connector.refresh(context, 'binding', 'selected', 'second', window)).result.status).toBe('denied');
    expect(s.fetch).toHaveBeenCalledTimes(attempts);
    expect(JSON.stringify(first)).not.toContain('PRIVATE_PATH_CANARY');
  });
});
