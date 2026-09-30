import { setTimeout as delay } from 'node:timers/promises';
import { digest } from '../domain/contracts.js';
import { calendarZone, normalizeEvent, object, hasCalendarControl, validateCalendarWindow } from './normalization.js';
import { GOOGLE_EVENT_READ_SCOPE, CalendarReadError, type CalendarAccess, type CalendarReader } from './reader.js';

type Options = {
  access: () => Promise<CalendarAccess>;
  token: () => Promise<string>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
};
const fail = (code: string): never => {
  throw new CalendarReadError(code);
};
const readScopes = new Set([
  GOOGLE_EVENT_READ_SCOPE,
  'https://www.googleapis.com/auth/calendar.events.owned.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.events.owned',
]);
const calendarIdValid = (id: unknown): id is string =>
  typeof id === 'string' &&
  id.length > 0 &&
  id.length <= 1024 &&
  !hasCalendarControl(id) &&
  !id.includes(' ') &&
  id !== '.' &&
  id !== '..';

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const maximum = 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel();
    return fail('calendar_response_too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) return fail('calendar_invalid_response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        return fail('calendar_response_too_large');
      }
      chunks.push(next.value);
    }
    const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!object(result)) return fail('calendar_invalid_response');
    return result;
  } catch (error) {
    if (error instanceof CalendarReadError) throw error;
    return fail('calendar_invalid_response');
  } finally {
    reader.releaseLock();
  }
}

/** Host-only read interface. The URL, methods, fields and retry budget are not caller-selectable. */
export function googleCalendarReader(options: Options): CalendarReader {
  const fetch = options.fetch ?? globalThis.fetch,
    sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now,
    random = options.random ?? Math.random;
  const access = async (): Promise<CalendarAccess> => {
    try {
      const a = await options.access();
      if (
        !a ||
        typeof a.generation !== 'string' ||
        !a.generation.length ||
        a.generation.length > 200 ||
        !['ready', 'expired', 'revoked', 'disconnected'].includes(a.auth) ||
        !Array.isArray(a.calendarIds) ||
        a.calendarIds.length > 20 ||
        !a.calendarIds.every(calendarIdValid) ||
        !Array.isArray(a.scopes) ||
        a.scopes.length > 50 ||
        !a.scopes.every((s) => typeof s === 'string' && s.length <= 200)
      )
        return fail('calendar_invalid_binding');
      return { generation: a.generation, calendarIds: [...a.calendarIds], auth: a.auth, scopes: [...a.scopes] };
    } catch (error) {
      if (error instanceof CalendarReadError) throw error;
      return fail('calendar_unavailable');
    }
  };
  const admit = async (calendarId: string, expected?: CalendarAccess): Promise<CalendarAccess> => {
    const a = await access();
    if (a.auth !== 'ready') return fail('calendar_auth_' + a.auth);
    if (!a.calendarIds.includes(calendarId)) return fail('calendar_not_selected');
    if (!a.scopes.some((s) => readScopes.has(s))) return fail('calendar_scope_denied');
    if (expected && digest(expected) !== digest(a)) return fail('calendar_access_changed');
    return a;
  };
  const request = async (calendarId: string, url: URL, isEvent: boolean): Promise<Record<string, unknown>> => {
    const allowed = await admit(calendarId),
      deadline = now() + 30000;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await admit(calendarId, allowed);
      if (now() >= deadline) return fail('calendar_unavailable');
      let response: Response;
      try {
        const token = await options.token();
        if (typeof token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(token)) return fail('calendar_auth_expired');
        if (now() >= deadline) return fail('calendar_unavailable');
        response = await fetch(url.href, {
          method: 'GET',
          redirect: 'error',
          headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
          signal: AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - now()))),
        });
      } catch (error) {
        if (error instanceof CalendarReadError) throw error;
        return fail('calendar_unavailable');
      }
      await admit(calendarId, allowed);
      if (response.status === 401) {
        await response.body?.cancel();
        return fail('calendar_auth_revoked');
      }
      if (response.status === 404 || response.status === 410) {
        await response.body?.cancel();
        return fail(isEvent ? 'calendar_event_missing' : 'calendar_access_revoked');
      }
      let body: Record<string, unknown> | undefined;
      if (response.status === 403) body = await boundedJson(response);
      const providerError = body && object(body.error) ? body.error : null;
      const reasons =
        providerError && Array.isArray(providerError.errors)
          ? providerError.errors.filter(object).map((e) => e.reason)
          : [];
      const limited =
        response.status === 429 ||
        (response.status === 403 && reasons.some((r) => r === 'rateLimitExceeded' || r === 'userRateLimitExceeded'));
      const retryable = limited || [500, 502, 503, 504].includes(response.status);
      if (retryable) {
        if (!body) await response.body?.cancel();
        const code = limited ? 'calendar_rate_limited' : 'calendar_unavailable';
        if (attempt === 2) return fail(code);
        const hint = response.headers.get('retry-after');
        const hintMs = hint === null ? NaN : /^\d+$/.test(hint) ? Number(hint) * 1000 : Date.parse(hint) - now();
        const backoff = 500 * 2 ** attempt + Math.floor(Math.max(0, Math.min(1, random())) * 250);
        const wait = Number.isFinite(hintMs) ? Math.max(backoff, hintMs) : backoff;
        if (wait > 5000 || now() + wait >= deadline) return fail(code);
        await sleep(wait);
        continue;
      }
      if (response.status === 403) return fail('calendar_access_revoked');
      if (response.status !== 200) {
        await response.body?.cancel();
        return fail('calendar_unavailable');
      }
      const result = await boundedJson(response);
      await admit(calendarId, allowed);
      return result;
    }
    return fail('calendar_unavailable');
  };
  const endpoint = (calendarId: string, eventId?: string) => {
    if (!calendarIdValid(calendarId) || (eventId !== undefined && !/^[a-zA-Z0-9_-]{1,1024}$/.test(eventId)))
      return fail('calendar_invalid_request');
    return new URL(
      'https://www.googleapis.com/calendar/v3/calendars/' +
        encodeURIComponent(calendarId) +
        '/events' +
        (eventId === undefined ? '' : '/' + eventId),
    );
  };
  const reader: CalendarReader = {
    access,
    async list(calendarId, requested, pageToken) {
      validateCalendarWindow(requested);
      const window = Object.freeze({ ...requested });
      if (
        pageToken !== undefined &&
        (typeof pageToken !== 'string' || !pageToken.length || pageToken.length > 2048 || hasCalendarControl(pageToken))
      )
        return fail('calendar_invalid_request');
      const url = endpoint(calendarId);
      for (const [key, value] of Object.entries({
        ...window,
        singleEvents: 'true',
        showDeleted: 'true',
        maxResults: '250',
      }))
        url.searchParams.set(key, value);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const result = await request(calendarId, url, false);
      if (!['reader', 'writerWithoutPrivateAccess', 'writer', 'owner'].includes(String(result.accessRole)))
        return fail('calendar_access_revoked');
      if (result.items !== undefined && (!Array.isArray(result.items) || result.items.length > 250))
        return fail('calendar_invalid_response');
      const next = result.nextPageToken;
      if (
        next !== undefined &&
        (typeof next !== 'string' || !next.length || next.length > 2048 || hasCalendarControl(next))
      )
        return fail('calendar_invalid_response');
      return {
        events: ((result.items ?? []) as unknown[]).map((e) => normalizeEvent(e, window.timeZone)),
        nextPageToken: next === undefined ? null : (next as string),
        accessRole: String(result.accessRole),
      };
    },
    async get(calendarId, eventId, timeZone) {
      try {
        calendarZone(timeZone);
      } catch (_error) {
        return fail('calendar_invalid_request');
      }
      const url = endpoint(calendarId, eventId);
      url.searchParams.set('timeZone', timeZone);
      const result = normalizeEvent(await request(calendarId, url, true), timeZone);
      if (result.providerEventId !== eventId) return fail('calendar_invalid_response');
      return result;
    },
  };
  const protect = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof CalendarReadError) throw error;
      if (error instanceof Error && ['calendar_invalid_event', 'calendar_invalid_window'].includes(error.message))
        return fail(error.message);
      return fail('calendar_unavailable');
    }
  };
  return Object.freeze({
    access,
    list: (...args: Parameters<CalendarReader['list']>) => protect(() => reader.list(...args)),
    get: (...args: Parameters<CalendarReader['get']>) => protect(() => reader.get(...args)),
  });
}
