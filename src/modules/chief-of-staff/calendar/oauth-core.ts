import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CalendarReadError, GOOGLE_EVENT_READ_SCOPE, hasCalendarReadScope } from './reader.js';
import { object } from './normalization.js';
import { GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE } from '../actions/writer.js';
export type OAuthScopeProfile = 'reader' | 'owned_event_writer';
const validProfile = (profile: unknown): profile is OAuthScopeProfile =>
  profile === 'reader' || profile === 'owned_event_writer';
import { assertCalendarActive, calendarRequestSignal } from './cancellation.js';

export type GoogleOAuthClient = { clientId: string; clientSecret?: string };
/** Host credential material only. Never return through RPC, log, or mount in a worker. */
export type GoogleCalendarTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number | null;
  scopes: string[];
};
export type OAuthTransport = {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  signal?: AbortSignal;
};
const fail = (code: string): never => {
  throw new CalendarReadError(code);
};
const secret = (value: unknown, max = 8192): value is string =>
  typeof value === 'string' && value.length <= max && /^[\x21-\x7e]+$/.test(value);
export function checkedClient(client: GoogleOAuthClient): GoogleOAuthClient {
  if (
    !object(client) ||
    Object.keys(client).some((k) => !['clientId', 'clientSecret'].includes(k)) ||
    typeof client.clientId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,200}\.apps\.googleusercontent\.com$/.test(client.clientId) ||
    (client.clientSecret !== undefined && !secret(client.clientSecret, 512))
  )
    return fail('calendar_oauth_configuration_invalid');
  return Object.freeze({ ...client });
}
function checkedCallback(value: string): string {
  try {
    const url = new URL(value);
    if (
      value.length > 200 ||
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      Number(url.port) < 1024 ||
      Number(url.port) > 65535 ||
      value !== url.origin + '/'
    )
      return fail('calendar_oauth_configuration_invalid');
    return value;
  } catch (error) {
    if (error instanceof CalendarReadError) throw error;
    return fail('calendar_oauth_configuration_invalid');
  }
}
function validScopes(value: unknown, profile: OAuthScopeProfile): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 50 &&
    value.every((s) => secret(s, 200)) &&
    validProfile(profile) &&
    (profile === 'reader'
      ? hasCalendarReadScope(value)
      : value.length === 2 &&
        new Set(value).size === 2 &&
        value.includes(GOOGLE_OWNED_EVENT_WRITE_SCOPE) &&
        value.includes(GOOGLE_CALENDAR_METADATA_SCOPE))
  );
}
export function validCalendarTokens(value: unknown, profile: OAuthScopeProfile): value is GoogleCalendarTokens {
  return (
    object(value) &&
    Object.keys(value).sort().join(',') === 'accessToken,expiresAt,refreshExpiresAt,refreshToken,scopes' &&
    secret(value.accessToken) &&
    secret(value.refreshToken) &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    (value.refreshExpiresAt === null ||
      (typeof value.refreshExpiresAt === 'number' && Number.isFinite(value.refreshExpiresAt))) &&
    validScopes(value.scopes, profile)
  );
}
async function tokenJson(response: Response): Promise<Record<string, unknown>> {
  const maximum = 32768;
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel();
    return fail('calendar_oauth_invalid_response');
  }
  const reader = response.body?.getReader();
  if (!reader) return fail('calendar_oauth_invalid_response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        return fail('calendar_oauth_invalid_response');
      }
      chunks.push(next.value);
    }
    const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!object(result)) return fail('calendar_oauth_invalid_response');
    return result;
  } catch (error) {
    if (error instanceof CalendarReadError) throw error;
    return fail('calendar_oauth_invalid_response');
  } finally {
    reader.releaseLock();
  }
}
async function exchange(
  client: GoogleOAuthClient,
  fields: Record<string, string>,
  transport: OAuthTransport,
  profile: OAuthScopeProfile,
  previous?: GoogleCalendarTokens,
): Promise<GoogleCalendarTokens> {
  assertCalendarActive(transport.signal);
  const now = (transport.now ?? Date.now)();
  if (!Number.isFinite(now)) return fail('calendar_oauth_configuration_invalid');
  const params = new URLSearchParams({
    ...fields,
    client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
  });
  try {
    const response = await (transport.fetch ?? globalThis.fetch)('https://oauth2.googleapis.com/token', {
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-store',
      },
      body: params.toString(),
      signal: calendarRequestSignal(transport.signal, 10000),
    });
    const body = await tokenJson(response);
    if (response.status !== 200) {
      if (body.error === 'invalid_grant') return fail('calendar_oauth_revoked');
      if (body.error === 'invalid_client' || body.error === 'unauthorized_client')
        return fail('calendar_oauth_client_invalid');
      if (body.error === 'access_denied') return fail('calendar_oauth_denied');
      return fail('calendar_oauth_exchange_uncertain');
    }
    const refreshToken = body.refresh_token === undefined ? previous?.refreshToken : body.refresh_token;
    const scopes =
      body.scope === undefined
        ? previous?.scopes
        : typeof body.scope === 'string'
          ? body.scope.trim().split(/ +/)
          : null;
    if (
      !secret(body.access_token) ||
      !secret(refreshToken) ||
      body.token_type !== 'Bearer' ||
      !Number.isSafeInteger(body.expires_in) ||
      Number(body.expires_in) < 1 ||
      Number(body.expires_in) > 86400 ||
      !validScopes(scopes, profile)
    )
      return fail('calendar_oauth_invalid_response');
    let refreshExpiresAt = previous?.refreshExpiresAt ?? null;
    if (body.refresh_token_expires_in !== undefined) {
      if (
        !Number.isSafeInteger(body.refresh_token_expires_in) ||
        Number(body.refresh_token_expires_in) < 1 ||
        Number(body.refresh_token_expires_in) > 315360000
      )
        return fail('calendar_oauth_invalid_response');
      refreshExpiresAt = now + Number(body.refresh_token_expires_in) * 1000;
    }
    return {
      accessToken: body.access_token,
      refreshToken,
      expiresAt: now + Number(body.expires_in) * 1000,
      refreshExpiresAt,
      scopes: [...scopes],
    };
  } catch (error) {
    if (error instanceof CalendarReadError) throw error;
    // Never retry a potentially consumed code or rotated refresh token automatically.
    return fail('calendar_oauth_exchange_uncertain');
  }
}

/** One operator-process consent attempt. Restart abandons it; codes cannot be restored/replayed. */
export class CalendarAuthorization {
  readonly authorizationUrl: string;
  readonly #client: GoogleOAuthClient;
  readonly #profile: OAuthScopeProfile;
  readonly #callback: string;
  readonly #state = randomBytes(32).toString('base64url');
  #verifier = randomBytes(32).toString('base64url');
  readonly #createdAt: number;
  #used = false;
  readonly #transport: OAuthTransport;
  constructor(client: GoogleOAuthClient, callback: string, profile: OAuthScopeProfile, transport: OAuthTransport = {}) {
    if (!validProfile(profile)) fail('calendar_oauth_configuration_invalid');
    this.#profile = profile;
    this.#client = checkedClient(client);
    this.#callback = checkedCallback(callback);
    this.#transport = { ...transport };
    this.#createdAt = (transport.now ?? Date.now)();
    if (!Number.isFinite(this.#createdAt)) fail('calendar_oauth_configuration_invalid');
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.#client.clientId,
      redirect_uri: this.#callback,
      response_type: 'code',
      scope:
        profile === 'reader'
          ? GOOGLE_EVENT_READ_SCOPE
          : [GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE].join(' '),
      state: this.#state,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(this.#verifier).digest('base64url'),
      access_type: 'offline',
      prompt: 'consent',
    }).toString();
    this.authorizationUrl = url.href;
  }
  async exchange(callback: string): Promise<GoogleCalendarTokens> {
    if (this.#used) return fail('calendar_oauth_flow_used');
    const now = (this.#transport.now ?? Date.now)();
    if (!Number.isFinite(now) || now < this.#createdAt || now - this.#createdAt > 600000) {
      this.#used = true;
      this.#verifier = '';
      return fail('calendar_oauth_flow_expired');
    }
    let url: URL;
    try {
      url = new URL(callback);
      // eslint-disable-next-line no-catch-all/no-catch-all -- Callback content and parsing diagnostics must remain private to the operator process.
    } catch {
      return fail('calendar_oauth_callback_invalid');
    }
    const accepted = ['code', 'state', 'scope', 'authuser', 'prompt', 'iss', 'error', 'error_description', 'error_uri'];
    if (
      callback.length > 16384 ||
      url.origin + url.pathname !== this.#callback ||
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].some((k) => !accepted.includes(k) || url.searchParams.getAll(k).length !== 1)
    )
      return fail('calendar_oauth_callback_invalid');
    const state = url.searchParams.get('state');
    if (
      state === null ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(this.#state))
    )
      return fail('calendar_oauth_callback_invalid');
    const code = url.searchParams.get('code');
    if (url.searchParams.has('error') && code !== null) return fail('calendar_oauth_callback_invalid');
    if (!url.searchParams.has('error') && !secret(code)) return fail('calendar_oauth_callback_invalid');
    this.#used = true;
    const verifier = this.#verifier;
    this.#verifier = '';
    if (url.searchParams.has('error')) return fail('calendar_oauth_denied');
    return exchange(
      this.#client,
      { grant_type: 'authorization_code', code: code!, code_verifier: verifier, redirect_uri: this.#callback },
      this.#transport,
      this.#profile,
    );
  }
}

/** The host credential owner must serialize refresh and durably save rotation before releasing access tokens. */
export async function refreshCalendarToken(
  client: GoogleOAuthClient,
  tokens: GoogleCalendarTokens,
  profile: OAuthScopeProfile,
  transport: OAuthTransport = {},
): Promise<GoogleCalendarTokens> {
  const checked = checkedClient(client);
  if (
    !tokens ||
    !secret(tokens.refreshToken) ||
    !secret(tokens.accessToken) ||
    !Number.isFinite(tokens.expiresAt) ||
    !validScopes(tokens.scopes, profile) ||
    (tokens.refreshExpiresAt !== null && !Number.isFinite(tokens.refreshExpiresAt))
  )
    return fail('calendar_oauth_configuration_invalid');
  const previous = structuredClone(tokens),
    now = (transport.now ?? Date.now)();
  if (previous.refreshExpiresAt !== null && previous.refreshExpiresAt <= now) return fail('calendar_oauth_revoked');
  return exchange(
    checked,
    { grant_type: 'refresh_token', refresh_token: previous.refreshToken },
    transport,
    profile,
    previous,
  );
}
