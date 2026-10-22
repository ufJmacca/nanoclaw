import { expect, it, vi } from 'vitest';
import {
  GoogleMailDraftAuthorization,
  validGoogleMailDraftTokens,
  refreshGoogleMailDraftToken,
  GOOGLE_MAIL_DRAFT_SCOPE,
} from './oauth.js';
import { GoogleMailAuthorization, validGoogleMailTokens, GOOGLE_MAIL_READ_SCOPE } from '../mail/oauth.js';
import { GoogleCalendarAuthorization, validGoogleCalendarTokens } from '../calendar/oauth.js';

const client = { clientId: 'fixture-draft-writer.apps.googleusercontent.com', clientSecret: 'fixture-draft-secret' };
const callback = 'http://127.0.0.1:45678/',
  now = Date.parse('2026-10-23T00:00:00Z');
const tokens = (scopes = [GOOGLE_MAIL_DRAFT_SCOPE]) => ({
  accessToken: 'fixture-access',
  refreshToken: 'fixture-refresh',
  expiresAt: now + 3600000,
  refreshExpiresAt: null,
  scopes,
});
const response = (scope = GOOGLE_MAIL_DRAFT_SCOPE) =>
  new Response(
    JSON.stringify({
      access_token: 'fixture-rotated-access',
      refresh_token: 'fixture-rotated-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
      scope,
    }),
  );
it('requests only compose in a separate PKCE flow and leaves reader and Calendar grants unchanged', () => {
  const writer = new GoogleMailDraftAuthorization(client, callback);
  const reader = new GoogleMailAuthorization({ clientId: 'fixture-reader.apps.googleusercontent.com' }, callback);
  const calendar = new GoogleCalendarAuthorization(
    { clientId: 'fixture-calendar.apps.googleusercontent.com' },
    callback,
  );
  const url = new URL(writer.authorizationUrl);
  expect(url.searchParams.get('scope')).toBe(GOOGLE_MAIL_DRAFT_SCOPE);
  expect(url.searchParams.get('include_granted_scopes')).not.toBe('true');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('state')).not.toBe(new URL(reader.authorizationUrl).searchParams.get('state'));
  expect(new URL(reader.authorizationUrl).searchParams.get('scope')).toBe(GOOGLE_MAIL_READ_SCOPE);
  expect(new URL(calendar.authorizationUrl).searchParams.get('scope')).toBe(
    'https://www.googleapis.com/auth/calendar.events.readonly',
  );
  expect(writer.authorizationUrl).not.toContain(client.clientSecret);
});
it('validates only the exact compose grant, never adopts reader tokens and consumes a code only once', async () => {
  expect(validGoogleMailDraftTokens(tokens())).toBe(true);
  expect(validGoogleMailTokens(tokens())).toBe(false);
  expect(validGoogleCalendarTokens(tokens())).toBe(false);
  expect(validGoogleMailDraftTokens(tokens([GOOGLE_MAIL_READ_SCOPE]))).toBe(false);
  const fetch = vi.fn(async () => response()),
    flow = new GoogleMailDraftAuthorization(client, callback, { fetch, now: () => now });
  const state = new URL(flow.authorizationUrl).searchParams.get('state');
  expect((await flow.exchange(callback + '?code=fixture-code&state=' + state)).scopes).toEqual([
    GOOGLE_MAIL_DRAFT_SCOPE,
  ]);
  await expect(flow.exchange(callback + '?code=fixture-code&state=' + state)).rejects.toThrow('flow_used');
  expect(fetch).toHaveBeenCalledOnce();
});
it.each([
  GOOGLE_MAIL_READ_SCOPE,
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://mail.google.com/',
  GOOGLE_MAIL_DRAFT_SCOPE + ' ' + GOOGLE_MAIL_READ_SCOPE,
  GOOGLE_MAIL_DRAFT_SCOPE + ' https://www.googleapis.com/auth/gmail.send',
  GOOGLE_MAIL_DRAFT_SCOPE + ' ' + GOOGLE_MAIL_DRAFT_SCOPE,
])('rejects an incorrect or expanded draft-writer grant: %s', async (scope) => {
  expect(validGoogleMailDraftTokens(tokens(scope.split(' ')))).toBe(false);
  const fetch = vi.fn(async () => response(scope)),
    flow = new GoogleMailDraftAuthorization(client, callback, { fetch, now: () => now });
  const state = new URL(flow.authorizationUrl).searchParams.get('state');
  await expect(flow.exchange(callback + '?code=fixture-code&state=' + state)).rejects.toThrow('invalid_response');
});
it('refreshes only the existing draft grant without requesting additional scopes', async () => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => response());
  const result = await refreshGoogleMailDraftToken(client, tokens(), { fetch, now: () => now });
  expect(result.scopes).toEqual([GOOGLE_MAIL_DRAFT_SCOPE]);
  const fields = new URLSearchParams(String(fetch.mock.calls[0][1].body));
  expect(fields.has('scope')).toBe(false);
  expect(fields.get('grant_type')).toBe('refresh_token');
});
