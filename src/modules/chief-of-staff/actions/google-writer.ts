import { digest } from '../domain/contracts.js';
import { validCalendarActionRequest, type CalendarActionRequest } from '../contracts/action-protocol.js';
import { calendarZone, hasCalendarControl, object, type CalendarWindow } from '../calendar/normalization.js';
import { googleCalendarReader } from '../calendar/google-reader.js';
import { collectCalendarSnapshot } from '../calendar/snapshot.js';
import { calendarEventOverlaps } from '../calendar/window.js';
import { calendarRequestSignal } from '../calendar/cancellation.js';
import { validActionIntent, type ActionIntent } from './intent.js';
import {
  CalendarWriteError,
  GOOGLE_CALENDAR_METADATA_SCOPE,
  GOOGLE_OWNED_EVENT_WRITE_SCOPE,
  type CalendarActionWriter,
  type CalendarWriterAccess,
  type CalendarWriterInspection,
  type CalendarWritePermit,
} from './writer.js';

type Options = {
  access(): Promise<CalendarWriterAccess>;
  token(): Promise<string>;
  admitted(): boolean;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  signal?: AbortSignal;
};
const opaque = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 1024 &&
  !hasCalendarControl(value) &&
  !/\s/u.test(value) &&
  !['.', '..'].includes(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (code: string, outcome: CalendarWriteError['outcome']): never => {
  throw new CalendarWriteError(code, outcome);
};
export function writerAccountFingerprint(primaryCalendarId: string): string {
  if (!opaque(primaryCalendarId) || primaryCalendarId === 'primary') return fail('writer_account_unknown', 'not_sent');
  return digest({ provider: 'google', primary_calendar_id: primaryCalendarId });
}

async function boundedJson(
  response: Response,
  signal: AbortSignal,
  outcome: CalendarWriteError['outcome'],
): Promise<Record<string, unknown>> {
  const maximum = 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel().catch(() => {});
    return fail('writer_response_too_large', outcome);
  }
  const reader = response.body?.getReader();
  if (!reader) return fail('writer_invalid_response', outcome);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      if (signal.aborted) return fail('writer_request_timed_out', outcome);
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        return fail('writer_response_too_large', outcome);
      }
      chunks.push(next.value);
    }
    if (signal.aborted) return fail('writer_request_timed_out', outcome);
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!object(value)) return fail('writer_invalid_response', outcome);
    return value;
  } catch (error) {
    if (error instanceof CalendarWriteError) throw error;
    // Provider diagnostics can contain account/token data; only a fixed category may escape.
    return fail('writer_invalid_response', outcome);
  } finally {
    reader.releaseLock();
  }
}

/** A separate host-only profile: fixed Google endpoints, selected owned calendar, one POST and no automatic retry. */
export function googleCalendarWriter(options: Options): CalendarActionWriter {
  const fetch = options.fetch ?? globalThis.fetch,
    now = options.now ?? Date.now;
  const access = async (outcome: CalendarWriteError['outcome'] = 'not_sent'): Promise<CalendarWriterAccess> => {
    let a: CalendarWriterAccess;
    try {
      a = await options.access();
      // eslint-disable-next-line no-catch-all/no-catch-all -- Host credential diagnostics may contain secrets.
    } catch (_error) {
      return fail('writer_credentials_unavailable', outcome);
    }
    if (
      !a ||
      !opaque(a.generation) ||
      a.generation.length > 200 ||
      !hash(a.accountFingerprint) ||
      !opaque(a.calendarId) ||
      a.calendarId === 'primary' ||
      !['ready', 'expired', 'revoked', 'disconnected'].includes(a.auth) ||
      typeof a.writeEnabled !== 'boolean' ||
      !Array.isArray(a.scopes) ||
      a.scopes.length !== 2 ||
      new Set(a.scopes).size !== 2 ||
      !a.scopes.includes(GOOGLE_OWNED_EVENT_WRITE_SCOPE) ||
      !a.scopes.includes(GOOGLE_CALENDAR_METADATA_SCOPE)
    )
      return fail('writer_invalid_binding', outcome);
    return structuredClone(a);
  };
  const credentials = async (outcome: CalendarWriteError['outcome']): Promise<string> => {
    let token: string;
    try {
      token = await options.token();
      // eslint-disable-next-line no-catch-all/no-catch-all -- Token failures must expose only a fixed category.
    } catch (_error) {
      return fail('writer_credentials_unavailable', outcome);
    }
    if (typeof token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(token))
      return fail('writer_credentials_unavailable', outcome);
    return token;
  };
  const admit = async (
    calendarId: string,
    expected?: CalendarWriterAccess,
    outcome: CalendarWriteError['outcome'] = 'not_sent',
  ) => {
    if (!options.admitted() || options.signal?.aborted) return fail('writer_admission_closed', outcome);
    const a = await access(outcome);
    if (a.auth !== 'ready' || a.calendarId !== calendarId || (expected && digest(a) !== digest(expected)))
      return fail('writer_access_changed', outcome);
    if (!options.admitted()) return fail('writer_admission_closed', outcome);
    return a;
  };
  const request = async (
    url: URL,
    a: CalendarWriterAccess,
    signal: AbortSignal,
    outcome: CalendarWriteError['outcome'],
    body?: unknown,
    permit?: CalendarWritePermit,
  ): Promise<Record<string, unknown> | null> => {
    await admit(a.calendarId, a, body === undefined ? outcome : 'not_sent');
    if (signal.aborted || (permit && !permit.valid()))
      return fail('writer_lease_expired', body === undefined ? outcome : 'not_sent');
    const token = await credentials(body === undefined ? outcome : 'not_sent');
    await admit(a.calendarId, a, body === undefined ? outcome : 'not_sent');
    if (signal.aborted || !options.admitted() || (permit && !permit.valid()))
      return fail('writer_admission_closed', body === undefined ? outcome : 'not_sent');
    let response: Response;
    try {
      // No asynchronous boundary separates the final local/lease fence from this fixed request.
      response = await fetch(url.href, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // eslint-disable-next-line no-catch-all/no-catch-all -- Fetch diagnostics can include credentials and account data.
    } catch (_error) {
      // Never expose fetch diagnostics or attach a secret-bearing cause.
      return fail('writer_request_unavailable', outcome);
    }
    if (body === undefined && response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (![200, 201].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      return fail('writer_request_rejected', outcome);
    }
    const value = await boundedJson(response, signal, outcome);
    if (body === undefined) await admit(a.calendarId, a, outcome);
    return value;
  };
  const ownedCalendar = async (
    a: CalendarWriterAccess,
    signal: AbortSignal,
    outcome: CalendarWriteError['outcome'],
  ) => {
    const metadata = (id: string) =>
      new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList/' + encodeURIComponent(id));
    const primary = await request(metadata('primary'), a, signal, outcome);
    if (
      !primary ||
      !opaque(primary.id) ||
      primary.primary !== true ||
      primary.accessRole !== 'owner' ||
      primary.deleted === true ||
      writerAccountFingerprint(primary.id) !== a.accountFingerprint
    )
      return fail('writer_account_unknown', outcome);
    const selected = primary.id === a.calendarId ? primary : await request(metadata(a.calendarId), a, signal, outcome);
    if (
      !selected ||
      selected.id !== a.calendarId ||
      selected.deleted === true ||
      selected.accessRole !== 'owner' ||
      !opaque(selected.etag) ||
      (selected.primary === true ? selected.id !== primary.id : selected.dataOwner !== primary.id)
    )
      return fail('writer_calendar_not_owned', outcome);
    let calendarTimeZone: string;
    try {
      calendarTimeZone = calendarZone(selected.timeZone);
      // eslint-disable-next-line no-catch-all/no-catch-all -- Untrusted provider metadata is categorised without its contents.
    } catch (_error) {
      return fail('writer_calendar_timezone_unknown', outcome);
    }
    return { selected, calendarTimeZone };
  };
  const inspect = async (proposed: CalendarActionRequest): Promise<CalendarWriterInspection> => {
    if (!validCalendarActionRequest(proposed)) return fail('writer_invalid_request', 'not_sent');
    const requested = structuredClone(proposed),
      a = await admit(requested.calendar_id),
      signal = calendarRequestSignal(options.signal, 30000);
    const { selected, calendarTimeZone } = await ownedCalendar(a, signal, 'not_sent');
    const window: CalendarWindow = { timeMin: requested.start, timeMax: requested.end, timeZone: calendarTimeZone };
    const reader = googleCalendarReader({
      access: async () => {
        const current = await admit(a.calendarId, a);
        return {
          generation: current.generation,
          auth: current.auth,
          calendarIds: [current.calendarId],
          scopes: current.scopes,
        };
      },
      token: async () => {
        const token = await credentials('not_sent');
        await admit(a.calendarId, a);
        return token;
      },
      fetch,
      signal,
      now,
    });
    let snapshot: Awaited<ReturnType<typeof collectCalendarSnapshot>>;
    try {
      snapshot = await collectCalendarSnapshot(reader, a.calendarId, window, signal);
      // eslint-disable-next-line no-catch-all/no-catch-all -- Reader diagnostics must not reveal account content.
    } catch (_error) {
      return fail('writer_availability_unavailable', 'not_sent');
    }
    if (
      snapshot.accessRole !== 'owner' ||
      snapshot.events.some((event) => event.status !== 'cancelled' && event.endTimeUnspecified)
    )
      return fail('writer_coverage_incomplete', 'not_sent');
    await admit(a.calendarId, a);
    const ownershipDigest = digest({
      accountFingerprint: a.accountFingerprint,
      generation: a.generation,
      calendarId: a.calendarId,
      selectedVersion: selected.etag,
      calendarTimeZone,
      dataOwnershipVerified: true,
    });
    return {
      complete: true,
      calendarId: a.calendarId,
      calendarTimeZone,
      accountFingerprint: a.accountFingerprint,
      generation: a.generation,
      ownershipDigest,
      availabilityDigest: digest({ ownershipDigest, window, events: snapshot.events }),
      busy: snapshot.events
        .filter((event) => event.status !== 'cancelled' && !event.transparent && calendarEventOverlaps(event, window))
        .map((event) => ({ start: event.start!, end: event.end!, eventDigest: event.contentDigest })),
      observedAt: new Date(Math.floor(now() / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
    };
  };
  const endpoint = (intent: ActionIntent, event = false) =>
    new URL(
      'https://www.googleapis.com/calendar/v3/calendars/' +
        encodeURIComponent(intent.request.calendar_id) +
        '/events' +
        (event ? '/' + intent.eventId : ''),
    );
  return Object.freeze({
    access,
    inspect,
    async create(intent: ActionIntent, approvedDigest: string, permit: CalendarWritePermit) {
      if (!validActionIntent(intent, approvedDigest) || !permit.valid())
        return fail('writer_invalid_authority', 'not_sent');
      // Pin caller-owned objects before yielding; PostgreSQL JSON is not necessarily frozen.
      const pinned = structuredClone(intent),
        inspection = structuredClone(permit.inspection);
      const a = await admit(pinned.request.calendar_id);
      if (!a.writeEnabled) return fail('writer_disabled', 'not_sent');
      const current = await inspect(pinned.request);
      if (
        current.busy.length ||
        !permit.valid() ||
        current.ownershipDigest !== inspection.ownershipDigest ||
        current.availabilityDigest !== inspection.availabilityDigest ||
        current.generation !== inspection.generation ||
        current.accountFingerprint !== inspection.accountFingerprint
      )
        return fail('writer_observations_changed', 'not_sent');
      const url = endpoint(pinned);
      url.searchParams.set('sendUpdates', 'none');
      return request(url, a, calendarRequestSignal(options.signal, 10000), 'uncertain', pinned.payload, permit);
    },
    async get(intent: ActionIntent, approvedDigest: string) {
      if (!validActionIntent(intent, approvedDigest)) return fail('writer_invalid_authority', 'read_unavailable');
      const pinned = structuredClone(intent);
      const a = await admit(pinned.request.calendar_id, undefined, 'read_unavailable');
      const signal = calendarRequestSignal(options.signal, 10000);
      await ownedCalendar(a, signal, 'read_unavailable');
      const url = endpoint(pinned, true);
      url.searchParams.set('timeZone', pinned.request.time_zone);
      return request(url, a, signal, 'read_unavailable');
    },
  });
}
