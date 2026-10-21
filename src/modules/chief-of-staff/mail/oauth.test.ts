import { expect, it, vi } from 'vitest';
import {
  GOOGLE_MAIL_READ_SCOPE,
  GoogleMailAuthorization,
  validGoogleMailTokens,
  refreshGoogleMailToken,
} from './oauth.js';
import { GoogleCalendarAuthorization, validGoogleCalendarTokens } from '../calendar/oauth.js';
const client = { clientId: 'fixture-mail.apps.googleusercontent.com', clientSecret: 'fixture-mail-secret' },
  callback = 'http://127.0.0.1:45678/',
  now = Date.parse('2026-10-15T00:00:00Z');
const tokens = (scopes = [GOOGLE_MAIL_READ_SCOPE]) => ({
  accessToken: 'fixture-access',
  refreshToken: 'fixture-refresh',
  expiresAt: now + 3600000,
  refreshExpiresAt: null,
  scopes,
});
const response = (scope = GOOGLE_MAIL_READ_SCOPE) =>
  new Response(
    JSON.stringify({
      access_token: 'fixture-new-access',
      refresh_token: 'fixture-new-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
      scope,
    }),
  );
it('requests only gmail.readonly in a separate PKCE loopback consent flow without widening Calendar', () => {
  const mail = new GoogleMailAuthorization(client, callback),
    calendar = new GoogleCalendarAuthorization({ clientId: 'fixture-calendar.apps.googleusercontent.com' }, callback);
  const url = new URL(mail.authorizationUrl);
  expect(url.searchParams.get('scope')).toBe(GOOGLE_MAIL_READ_SCOPE);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('redirect_uri')).toBe(callback);
  expect(url.searchParams.get('include_granted_scopes')).not.toBe('true');
  expect(url.searchParams.get('state')).not.toBe(new URL(calendar.authorizationUrl).searchParams.get('state'));
  expect(new URL(calendar.authorizationUrl).searchParams.get('scope')).toBe(
    'https://www.googleapis.com/auth/calendar.events.readonly',
  );
  expect(mail.authorizationUrl).not.toContain(client.clientSecret);
});
it('accepts the exact mail read scope and refuses using mail tokens as Calendar authority', async () => {
  expect(validGoogleMailTokens(tokens())).toBe(true);
  expect(validGoogleCalendarTokens(tokens())).toBe(false);
  const fetch = vi.fn(async () => response()),
    flow = new GoogleMailAuthorization(client, callback, { fetch, now: () => now });
  const state = new URL(flow.authorizationUrl).searchParams.get('state');
  const result = await flow.exchange(callback + '?code=fixture-code&state=' + state);
  expect(result.scopes).toEqual([GOOGLE_MAIL_READ_SCOPE]);
  expect(fetch).toHaveBeenCalledOnce();
  await expect(flow.exchange(callback + '?code=fixture-code&state=' + state)).rejects.toThrow('flow_used');
  expect(fetch).toHaveBeenCalledOnce();
});
it.each([
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://mail.google.com/',
  GOOGLE_MAIL_READ_SCOPE + ' https://www.googleapis.com/auth/calendar.events.readonly',
  GOOGLE_MAIL_READ_SCOPE + ' ' + GOOGLE_MAIL_READ_SCOPE,
])('refuses an incorrect or expanded mail scope %s', async (scope) => {
  expect(validGoogleMailTokens(tokens(scope.split(' ')))).toBe(false);
  const fetch = vi.fn(async () => response(scope)),
    flow = new GoogleMailAuthorization(client, callback, { fetch, now: () => now });
  const state = new URL(flow.authorizationUrl).searchParams.get('state');
  await expect(flow.exchange(callback + '?code=fixture-code&state=' + state)).rejects.toThrow('invalid_response');
});
it('serializes the existing refresh grant without requesting wider scopes and validates the rotated result', async () => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => response());
  const result = await refreshGoogleMailToken(client, tokens(), { fetch, now: () => now });
  expect(result.accessToken).toBe('fixture-new-access');
  expect(result.scopes).toEqual([GOOGLE_MAIL_READ_SCOPE]);
  const fields = new URLSearchParams(String(fetch.mock.calls[0][1].body));
  expect(fields.get('grant_type')).toBe('refresh_token');
  expect(fields.has('scope')).toBe(false);
});
