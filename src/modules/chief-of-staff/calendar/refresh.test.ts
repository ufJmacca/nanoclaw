import { describe, expect, it, vi } from 'vitest';
import { refreshCalendar } from './refresh.js';
import { fixtureCalendarReader } from './fixture-reader.js';
import { GOOGLE_EVENT_READ_SCOPE, CalendarReadError } from './reader.js';
import type { CalendarStore } from './store.js';
const context = {
  scopeId: 'scope',
  ownerId: 'owner',
  sessionId: 'session',
  agentGroupId: 'group',
  ingressId: 'ingress',
};
const window = { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-10T00:00:00Z', timeZone: 'UTC' };
const setup = () => {
  const fixture = fixtureCalendarReader({
    access: { generation: 'binding:1', calendarIds: ['selected'], scopes: [GOOGLE_EVENT_READ_SCOPE], auth: 'ready' },
    calendars: {
      selected: [
        { id: 'one', etag: 'v1', start: { date: '2026-10-02' }, end: { date: '2026-10-03' } },
        { id: 'two', etag: 'v1', start: { date: '2026-10-03' }, end: { date: '2026-10-04' } },
      ],
    },
    pageSize: 1,
  });
  const store = {
    start: vi.fn<CalendarStore['start']>(async () => ({ status: 'ok', snapshot_status: 'collecting' })),
    publish: vi.fn<CalendarStore['publish']>(async () => ({ status: 'ok', snapshot_id: 'snapshot' })),
    fail: vi.fn<CalendarStore['fail']>(async () => ({ status: 'ok' })),
    setAuth: vi.fn<CalendarStore['setAuth']>(async () => ({ status: 'ok' })),
  };
  const options = {
    store,
    context,
    reader: fixture.reader,
    bindingId: 'binding',
    calendarId: 'selected',
    snapshotId: 'snapshot',
    window,
    accessLoss: vi.fn(async () => {}),
  };
  return { fixture, store, options };
};
describe('S03 host calendar refresh orchestration', () => {
  it('checks the durable binding before any provider call', async () => {
    const s = setup();
    s.store.start.mockResolvedValue({ status: 'denied' });
    const access = vi.fn(s.options.reader.access);
    s.options.reader = { ...s.options.reader, access };
    expect((await refreshCalendar(s.options)).result.status).toBe('denied');
    expect(access).not.toHaveBeenCalled();
    expect(s.store.publish).not.toHaveBeenCalled();
  });
  it('publishes once only after every page succeeds and sends no host environment to the reader', async () => {
    const s = setup();
    const result = await refreshCalendar(s.options);
    expect(result.result).toEqual({ status: 'ok', snapshot_id: 'snapshot' });
    expect(s.store.publish).toHaveBeenCalledOnce();
    expect(s.store.publish.mock.calls[0]).toMatchObject([
      context,
      'binding',
      'snapshot',
      { pages: 2, events: [{ providerEventId: 'one' }, { providerEventId: 'two' }] },
    ]);
    expect(result.prepared).toBeUndefined();
  });
  it('records partial failure without publishing or fabricating an empty complete snapshot', async () => {
    const s = setup();
    s.fixture.failPage(2);
    expect((await refreshCalendar(s.options)).result.status).toBe('unavailable');
    expect(s.store.publish).not.toHaveBeenCalled();
    expect(s.store.fail).toHaveBeenCalledWith(context, 'binding', 'snapshot', 'calendar_unavailable');
  });
  it.each(['calendar_auth_revoked', 'calendar_access_revoked', 'calendar_scope_denied', 'calendar_not_selected'])(
    'durably fences access loss before changing database state: %s',
    async (code) => {
      const s = setup();
      s.options.reader = {
        ...s.options.reader,
        list: async () => {
          throw new CalendarReadError(code);
        },
      };
      const order: string[] = [];
      s.options.accessLoss.mockImplementation(async () => {
        order.push('fence');
      });
      s.store.setAuth.mockImplementation(async () => {
        order.push('database');
        return { status: 'ok' };
      });
      const result = await refreshCalendar(s.options);
      expect(result.result.status).toBe('denied');
      expect(order).toEqual(['fence', 'database']);
      expect(s.options.accessLoss).toHaveBeenCalledWith('revoked');
      expect(s.store.publish).not.toHaveBeenCalled();
    },
  );
  it('retains the prepared snapshot after an uncertain commit so recovery does not refetch', async () => {
    const s = setup();
    s.store.publish.mockResolvedValue({ status: 'pending', snapshot_id: 'snapshot' });
    const result = await refreshCalendar(s.options);
    expect(result.result.status).toBe('pending');
    expect(result.prepared).toMatchObject({ bindingId: 'binding', snapshotId: 'snapshot', snapshot: { pages: 2 } });
    expect(s.store.fail).not.toHaveBeenCalled();
  });
  it('reconciles an already committed identity without another provider request', async () => {
    const s = setup();
    s.store.start.mockResolvedValue({
      status: 'ok',
      snapshot_status: 'complete',
      result: { status: 'ok', snapshot_id: 'snapshot' },
    });
    const access = vi.fn(s.options.reader.access);
    s.options.reader = { ...s.options.reader, access };
    expect((await refreshCalendar(s.options)).result).toEqual({ status: 'ok', snapshot_id: 'snapshot' });
    expect(access).not.toHaveBeenCalled();
    expect(s.store.publish).not.toHaveBeenCalled();
  });
  it('redacts unexpected provider errors before failure persistence or result delivery', async () => {
    const s = setup();
    s.options.reader = {
      ...s.options.reader,
      list: async () => {
        throw new Error('PRIVATE_CREDENTIAL_CANARY');
      },
    };
    const result = await refreshCalendar(s.options);
    expect(result.result.status).toBe('unavailable');
    expect(JSON.stringify([result, s.store.fail.mock.calls])).not.toContain('PRIVATE_CREDENTIAL_CANARY');
    expect(s.store.fail).toHaveBeenCalledWith(context, 'binding', 'snapshot', 'calendar_refresh_failed');
  });
  it('returns incomplete persistence when the access-loss database update is unavailable', async () => {
    const s = setup();
    s.options.reader = {
      ...s.options.reader,
      list: async () => {
        throw new CalendarReadError('calendar_auth_revoked');
      },
    };
    s.store.setAuth.mockResolvedValue({ status: 'pending' });
    const result = await refreshCalendar(s.options);
    expect(result.result.status).toBe('pending');
    expect(s.options.accessLoss).toHaveBeenCalledOnce();
    expect(result.prepared).toBeUndefined();
  });
});
