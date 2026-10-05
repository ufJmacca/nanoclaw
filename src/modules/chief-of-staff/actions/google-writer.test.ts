import { describe, expect, it } from 'vitest';
import { digest } from '../domain/contracts.js';
import { createActionIntent } from './intent.js';
import { matchesActionEvent } from './event.js';
import { GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE, type CalendarWriterAccess } from './writer.js';
import { googleCalendarWriter, writerAccountFingerprint } from './google-writer.js';

const now = Date.parse('2026-10-05T21:00:00Z'),
  binding = '11111111-1111-4111-8111-111111111111';
const request = {
  kind: 'calendar_block' as const,
  binding_id: binding,
  calendar_id: 'owner@example.test',
  start: '2026-10-05T22:00:00Z',
  end: '2026-10-05T23:00:00Z',
  time_zone: 'Australia/Sydney',
  title: 'Focus work',
  description: '',
  project_id: null,
  mission_id: null,
  attendees: [] as [],
};
const intent = createActionIntent({
  request,
  requestId: binding,
  now,
  context: { scopeId: 'scope', ownerId: 'owner', agentGroupId: 'group', sessionId: 'session', ingressId: 'ingress' },
  destination: { instanceId: 'fixture', channelId: 'private-channel' },
  resources: [
    { kind: 'writer_binding', id: binding, version: 1, digest: 'a'.repeat(64), observed_at: '2026-10-05T21:00:00Z' },
    {
      kind: 'availability',
      id: 'availability-' + 'b'.repeat(64),
      version: 1,
      digest: 'c'.repeat(64),
      observed_at: '2026-10-05T21:00:00Z',
    },
  ],
});
const approved = digest(intent);
function fixture() {
  let admitted = true,
    lease = true,
    mode = 'success';
  let onToken = () => {},
    onAccess = () => {};
  let access: CalendarWriterAccess = {
    generation: 'fixture-generation',
    accountFingerprint: writerAccountFingerprint('owner@example.test'),
    calendarId: request.calendar_id,
    auth: 'ready',
    scopes: [GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE],
    writeEnabled: true,
  };
  const calls: Array<{ url: URL; init: RequestInit }> = [],
    remote = new Map<string, unknown>();
  const primary: Record<string, unknown> = {
    id: 'owner@example.test',
    primary: true,
    accessRole: 'owner',
    etag: '"metadata-1"',
    timeZone: 'Australia/Sydney',
  };
  const selected: Record<string, unknown> = { ...primary };
  let items: unknown[] = [];
  const writer = googleCalendarWriter({
    access: async () => {
      onAccess();
      if (mode === 'access_failure') throw new Error('private-fixture-account-diagnostic');
      return structuredClone(access);
    },
    admitted: () => admitted,
    token: async () => {
      onToken();
      if (mode === 'token_failure') throw new Error('private-fixture-token-diagnostic');
      if (mode === 'pause_in_token') admitted = false;
      if (mode === 'lease_in_token') lease = false;
      return 'fixture-access-token';
    },
    now: () => now,
    fetch: async (url, init) => {
      const u = new URL(url);
      calls.push({ url: u, init });
      expect(u.origin).toBe('https://www.googleapis.com');
      expect(init.redirect).toBe('error');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fixture-access-token');
      if (u.pathname.endsWith('/calendarList/primary')) return Response.json(primary);
      if (u.pathname.includes('/calendarList/')) return Response.json(selected);
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        remote.set(body.id, { ...body, etag: '"created-1"', status: 'confirmed' });
        if (mode === 'timeout_after_success') throw new Error('private-fixture-provider-diagnostic');
        if (mode === 'server_error_after_success')
          return new Response('private-fixture-provider-diagnostic', { status: 500 });
        return Response.json(remote.get(body.id));
      }
      if (u.pathname.endsWith('/events'))
        return Response.json({
          accessRole: mode === 'reader_role' ? 'reader' : 'owner',
          items,
          ...(mode === 'pagination_loop' ? { nextPageToken: 'same-page' } : {}),
        });
      const id = u.pathname.split('/').at(-1)!;
      return remote.has(id) ? Response.json(remote.get(id)) : new Response('', { status: 404 });
    },
  });
  return {
    writer,
    calls,
    remote,
    primary,
    selected,
    get access() {
      return access;
    },
    set access(v) {
      access = v;
    },
    set admitted(v: boolean) {
      admitted = v;
    },
    set lease(v: boolean) {
      lease = v;
    },
    set mode(v: string) {
      mode = v;
    },
    set items(v: unknown[]) {
      items = v;
    },
    set onToken(v: () => void) {
      onToken = v;
    },
    set onAccess(v: () => void) {
      onAccess = v;
    },
    permit: async () => ({ valid: () => lease, inspection: await writer.inspect(request) }),
  };
}

describe('S09 separate narrow Google Calendar writer', () => {
  it('retains the approved private copy across asynchronous token work', async () => {
    const f = fixture(),
      permit = await f.permit(),
      mutable = structuredClone(intent);
    f.onToken = () => {
      mutable.payload.summary = 'Unapproved change';
      mutable.request.calendar_id = 'other@example.test';
    };
    await f.writer.create(mutable, approved, permit);
    const post = f.calls.find((call) => call.init.method === 'POST')!;
    expect(post.url.pathname).toBe('/calendar/v3/calendars/owner%40example.test/events');
    expect(JSON.parse(String(post.init.body))).toEqual(intent.payload);
  });
  it('pins the original calendar/event before asynchronous read-back access checks', async () => {
    const f = fixture(),
      mutable = structuredClone(intent);
    f.onAccess = () => {
      mutable.request.calendar_id = 'other@example.test';
      mutable.eventId = 'f'.repeat(64);
    };
    await f.writer.get(mutable, approved);
    expect(f.calls.at(-1)!.url.pathname).toBe('/calendar/v3/calendars/owner%40example.test/events/' + intent.eventId);
  });
  it('verifies the actual authenticated account and ownership again before reconciliation reads', async () => {
    const f = fixture();
    f.remote.set(intent.eventId, { ...intent.payload, etag: '"fixture-version"' });
    f.primary.id = 'another-account@example.test';
    await expect(f.writer.get(intent, approved)).rejects.toMatchObject({ outcome: 'read_unavailable' });
    expect(f.calls.some((call) => call.url.pathname.endsWith('/events/' + intent.eventId))).toBe(false);
  });
  it.each(['token_failure', 'access_failure'])(
    'does not expose private credential diagnostics from %s',
    async (mode) => {
      const f = fixture();
      f.mode = mode;
      await expect(f.writer.inspect(request)).rejects.toMatchObject({
        code: 'writer_credentials_unavailable',
        outcome: 'not_sent',
      });
      expect(f.calls.filter((call) => call.init.method === 'POST')).toHaveLength(0);
    },
  );
  it('checks actual ownership and complete fresh availability, then sends one fixed private payload and reads its ID back', async () => {
    const f = fixture(),
      permit = await f.permit();
    expect(permit.inspection.complete).toBe(true);
    expect(permit.inspection.busy).toEqual([]);
    await f.writer.create(intent, approved, permit);
    const posts = f.calls.filter((call) => call.init.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].url.pathname).toBe('/calendar/v3/calendars/owner%40example.test/events');
    expect(posts[0].url.searchParams.get('sendUpdates')).toBe('none');
    expect(JSON.parse(String(posts[0].init.body))).toEqual(intent.payload);
    expect(matchesActionEvent(intent, approved, request.calendar_id, await f.writer.get(intent, approved))).toBe(true);
    expect(f.calls.at(-1)!.url.pathname.endsWith('/events/' + intent.eventId)).toBe(true);
  });
  it.each(['timeout_after_success', 'server_error_after_success'])(
    'S09-T05 does not retry POST after %s; the original ID remains reconcilable',
    async (mode) => {
      const f = fixture(),
        permit = await f.permit();
      f.mode = mode;
      await expect(f.writer.create(intent, approved, permit)).rejects.toMatchObject({ outcome: 'uncertain' });
      expect(f.calls.filter((call) => call.init.method === 'POST')).toHaveLength(1);
      expect(f.remote.size).toBe(1);
      expect(f.remote.has(intent.eventId)).toBe(true);
      f.mode = 'success';
      expect(matchesActionEvent(intent, approved, request.calendar_id, await f.writer.get(intent, approved))).toBe(
        true,
      );
      expect(f.calls.filter((call) => call.init.method === 'POST')).toHaveLength(1);
    },
  );
  it('S09-T06 returns unresolved absence without a new-ID create', async () => {
    const f = fixture();
    expect(await f.writer.get(intent, approved)).toBeNull();
    expect(f.calls.filter((call) => call.init.method === 'POST')).toHaveLength(0);
  });
  it('S09-T07 rejects a new conflict and changed resource observations before POST', async () => {
    const f = fixture(),
      permit = await f.permit();
    f.items = [
      {
        id: 'busy',
        etag: '"busy-1"',
        start: intent.payload.start,
        end: intent.payload.end,
        summary: 'Private fixture',
      },
    ];
    await expect(f.writer.create(intent, approved, permit)).rejects.toMatchObject({ outcome: 'not_sent' });
    expect(f.calls.filter((call) => call.init.method === 'POST')).toHaveLength(0);
    const other = fixture(),
      original = await other.permit();
    other.primary.etag = '"metadata-2"';
    await expect(other.writer.create(intent, approved, original)).rejects.toMatchObject({ outcome: 'not_sent' });
    expect(other.calls.filter((call) => call.init.method === 'POST')).toHaveLength(0);
  });
  it('uses the selected calendar timezone for all-day conflicts even when the proposed display timezone differs', async () => {
    const f = fixture();
    f.items = [{ id: 'all-day', etag: '"day-1"', start: { date: '2026-10-06' }, end: { date: '2026-10-07' } }];
    expect((await f.writer.inspect({ ...request, time_zone: 'UTC' })).busy).toHaveLength(1);
  });
  it('does not confuse manager access with secondary calendar data ownership', async () => {
    const f = fixture();
    f.access = { ...f.access, calendarId: 'secondary@group.calendar.google.com' };
    Object.assign(f.selected, { id: f.access.calendarId, primary: false, dataOwner: 'someone-else@example.test' });
    await expect(f.writer.inspect({ ...request, calendar_id: f.access.calendarId })).rejects.toMatchObject({
      outcome: 'not_sent',
    });
    expect(f.calls.filter((call) => call.init.method === 'POST')).toHaveLength(0);
  });
  it('admits an explicitly selected secondary calendar belonging to the independently authenticated owner', async () => {
    const f = fixture();
    f.access = { ...f.access, calendarId: 'secondary@group.calendar.google.com' };
    Object.assign(f.selected, { id: f.access.calendarId, primary: false, dataOwner: 'owner@example.test' });
    const inspection = await f.writer.inspect({ ...request, calendar_id: f.access.calendarId });
    expect(inspection.calendarId).toBe(f.access.calendarId);
    expect(inspection.accountFingerprint).toBe(writerAccountFingerprint('owner@example.test'));
    expect(inspection.busy).toEqual([]);
  });
  it('refuses partial pagination, insufficient event access, revoked credentials and an unselected calendar', async () => {
    for (const mode of ['pagination_loop', 'reader_role']) {
      const f = fixture();
      f.mode = mode;
      await expect(f.writer.inspect(request)).rejects.toMatchObject({ outcome: 'not_sent' });
      expect(f.calls.filter((call) => call.init.method === 'POST')).toHaveLength(0);
    }
    for (const patch of [
      { auth: 'revoked' as const },
      { scopes: ['https://www.googleapis.com/auth/calendar.events.readonly'] },
      { calendarId: 'other@example.test' },
      { accountFingerprint: 'e'.repeat(64) },
    ]) {
      const f = fixture();
      f.access = { ...f.access, ...patch };
      await expect(f.writer.inspect(request)).rejects.toMatchObject({ outcome: 'not_sent' });
      expect(f.calls.filter((call) => call.init.method === 'POST')).toHaveLength(0);
    }
  });
  it('S09-PG02/T09 rechecks lease, local pause and writer admission immediately before sending', async () => {
    for (const mode of ['pause_in_token', 'lease_in_token']) {
      const f = fixture(),
        permit = await f.permit();
      f.mode = mode;
      await expect(f.writer.create(intent, approved, permit)).rejects.toMatchObject({ outcome: 'not_sent' });
      expect(f.calls.filter((call) => call.init.method === 'POST')).toHaveLength(0);
    }
    const f = fixture(),
      permit = await f.permit();
    f.access = { ...f.access, writeEnabled: false };
    await expect(f.writer.create(intent, approved, permit)).rejects.toMatchObject({ outcome: 'not_sent' });
    expect(f.calls.filter((call) => call.init.method === 'POST')).toHaveLength(0);
  });
  it('rejects changed approval, account generation and arbitrary provider payload additions', async () => {
    const f = fixture(),
      permit = await f.permit();
    await expect(
      f.writer.create(
        { ...intent, payload: { ...intent.payload, attendees: ['guest'] } } as unknown as typeof intent,
        approved,
        permit,
      ),
    ).rejects.toMatchObject({ outcome: 'not_sent' });
    f.access = { ...f.access, generation: 'different-generation' };
    await expect(f.writer.create(intent, approved, permit)).rejects.toMatchObject({ outcome: 'not_sent' });
    expect(f.calls.filter((call) => call.init.method === 'POST')).toHaveLength(0);
  });
});
