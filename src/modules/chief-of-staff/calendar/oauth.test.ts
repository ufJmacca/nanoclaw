import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GoogleCalendarAuthorization, refreshGoogleCalendarToken, type GoogleCalendarTokens } from './oauth.js';
import { GOOGLE_EVENT_READ_SCOPE } from './reader.js';
const client = { clientId: 'fixture-client.apps.googleusercontent.com', clientSecret: 'fixture-client-secret' };
const callback = 'http://127.0.0.1:45678/';
const now = Date.parse('2026-10-01T00:00:00Z');
const tokens = (): GoogleCalendarTokens => ({
  accessToken: 'fixture-access',
  refreshToken: 'fixture-refresh',
  expiresAt: now + 3600000,
  refreshExpiresAt: null,
  scopes: [GOOGLE_EVENT_READ_SCOPE],
});
const response = (patch: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      access_token: 'fixture-new-access',
      refresh_token: 'fixture-new-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: GOOGLE_EVENT_READ_SCOPE,
      ...patch,
    }),
  );
const setup = (reply = response()) => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => reply);
  const flow = new GoogleCalendarAuthorization(client, callback, { fetch, now: () => now });
  const state = new URL(flow.authorizationUrl).searchParams.get('state');
  return { flow, fetch, url: callback + '?code=fixture-code&state=' + state };
};
describe('S03 host-only Google desktop OAuth protocol', () => {
  it('requests only event-read access using a unique state, PKCE S256 and exact loopback redirect', async () => {
    const s = setup(),
      other = setup(),
      url = new URL(s.flow.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_EVENT_READ_SCOPE);
    expect(url.searchParams.get('redirect_uri')).toBe(callback);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).not.toBe(new URL(other.flow.authorizationUrl).searchParams.get('state'));
    expect(s.flow.authorizationUrl).not.toContain('fixture-client-secret');
    await s.flow.exchange(s.url);
    const params = new URLSearchParams(String(s.fetch.mock.calls[0][1].body));
    const verifier = params.get('code_verifier')!;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
  });
  it('exchanges through the fixed HTTPS token endpoint and returns only validated credential fields', async () => {
    const s = setup(response({ id_token: 'UNREQUESTED_ID_TOKEN', refresh_token_expires_in: 7200 }));
    const result = await s.flow.exchange(s.url);
    expect(result).toEqual({
      ...tokens(),
      accessToken: 'fixture-new-access',
      refreshToken: 'fixture-new-refresh',
      refreshExpiresAt: now + 7200000,
    });
    const [url, init] = s.fetch.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'Cache-Control': 'no-store' } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('redirect_uri')).toBe(callback);
    expect(body.get('client_secret')).toBe('fixture-client-secret');
    expect(JSON.stringify(result)).not.toContain('UNREQUESTED_ID_TOKEN');
  });
  it.each([
    'https://attacker.test/',
    'http://localhost:45678/',
    'http://127.0.0.1:45679/',
    'http://127.0.0.1:45678/other',
  ])('rejects a mismatched callback %s before exchange', async (bad) => {
    const s = setup();
    await expect(s.flow.exchange(bad + new URL(s.url).search)).rejects.toThrow('calendar_oauth_callback_invalid');
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it('rejects state mismatch, duplicate parameters and URL fragments', async () => {
    const s = setup();
    for (const url of [s.url.replace('state=', 'state=wrong-'), s.url + '&code=second', s.url + '#fragment'])
      await expect(s.flow.exchange(url)).rejects.toThrow('calendar_oauth_callback_invalid');
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it('rejects non-ASCII callback state without leaking a crypto exception', async () => {
    const s = setup(),
      url = new URL(s.url);
    url.searchParams.set('state', 'é'.repeat(43));
    await expect(s.flow.exchange(url.href)).rejects.toThrow('calendar_oauth_callback_invalid');
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it('consumes a valid callback before dispatch so concurrent replays cannot exchange twice', async () => {
    const s = setup();
    const first = s.flow.exchange(s.url);
    await expect(s.flow.exchange(s.url)).rejects.toThrow('calendar_oauth_flow_used');
    await first;
    expect(s.fetch).toHaveBeenCalledOnce();
  });
  it('rejects expired flows and preserves no usable code after the operator denies consent', async () => {
    let time = now;
    const fetch = vi.fn(async () => response());
    const flow = new GoogleCalendarAuthorization(client, callback, { fetch, now: () => time });
    time += 600001;
    await expect(
      flow.exchange(callback + '?code=fixture&state=' + new URL(flow.authorizationUrl).searchParams.get('state')),
    ).rejects.toThrow('calendar_oauth_flow_expired');
    expect(fetch).not.toHaveBeenCalled();
    const s = setup();
    const denied = new URL(s.url);
    denied.searchParams.delete('code');
    denied.searchParams.set('error', 'access_denied');
    denied.searchParams.set('error_description', 'PRIVATE_ERROR_TEXT');
    await expect(s.flow.exchange(denied.href)).rejects.toThrow('calendar_oauth_denied');
    await expect(s.flow.exchange(s.url)).rejects.toThrow('calendar_oauth_flow_used');
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it('refreshes without new scope parameters and preserves an unrotated refresh token and its expiry', async () => {
    const old = { ...tokens(), refreshExpiresAt: now + 7200000 };
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      response({ refresh_token: undefined, scope: undefined }),
    );
    const result = await refreshGoogleCalendarToken(client, old, { fetch, now: () => now });
    expect(result.refreshToken).toBe(old.refreshToken);
    expect(result.refreshExpiresAt).toBe(old.refreshExpiresAt);
    const body = new URLSearchParams(String(fetch.mock.calls[0][1].body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe(old.refreshToken);
    expect(body.has('scope')).toBe(false);
    expect(body.has('redirect_uri')).toBe(false);
  });
  it('retains a rotated refresh token and rejects an expired refresh grant before dispatch', async () => {
    const fetch = vi.fn(async () => response());
    expect((await refreshGoogleCalendarToken(client, tokens(), { fetch, now: () => now })).refreshToken).toBe(
      'fixture-new-refresh',
    );
    fetch.mockClear();
    await expect(
      refreshGoogleCalendarToken(client, { ...tokens(), refreshExpiresAt: now - 1 }, { fetch, now: () => now }),
    ).rejects.toThrow('calendar_oauth_revoked');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('classifies invalid grants without exposing provider bodies or causing an automatic replay', async () => {
    const s = setup(
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'PRIVATE_PROVIDER_BODY' }), {
        status: 400,
      }),
    );
    await expect(s.flow.exchange(s.url)).rejects.toThrow('calendar_oauth_revoked');
    expect(s.fetch).toHaveBeenCalledOnce();
    await expect(s.flow.exchange(s.url)).rejects.toThrow('calendar_oauth_flow_used');
  });
  it.each([
    { expires_in: 0 },
    { token_type: 'Basic' },
    { scope: 'https://www.googleapis.com/auth/drive.readonly' },
    { access_token: 'bad\ntoken' },
    { refresh_token: undefined },
  ])('rejects malformed or insufficient token responses', async (patch) => {
    const s = setup(response(patch));
    await expect(s.flow.exchange(s.url)).rejects.toThrow('calendar_oauth_invalid_response');
  });
  it('bounds token responses and strips private transport failures', async () => {
    const s = setup(new Response('x'.repeat(40000)));
    await expect(s.flow.exchange(s.url)).rejects.toThrow('calendar_oauth_invalid_response');
    const fetch = vi.fn(async () => {
      throw new Error('PRIVATE_TRANSPORT_TEXT');
    });
    await expect(refreshGoogleCalendarToken(client, tokens(), { fetch, now: () => now })).rejects.toThrow(
      'calendar_oauth_exchange_uncertain',
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('refuses non-loopback or credential-bearing callback configuration', () => {
    for (const bad of [
      'https://example.test/',
      'http://127.0.0.1:45678/?extra=yes',
      'http://user:pass@127.0.0.1:45678/',
      'http://127.0.0.1:45678/#fragment',
    ])
      expect(() => new GoogleCalendarAuthorization(client, bad)).toThrow('calendar_oauth_configuration_invalid');
  });
});
