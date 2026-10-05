import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import * as writerOAuth from './oauth.js';
import { GoogleCalendarAuthorization, validGoogleCalendarTokens } from '../calendar/oauth.js';
import { GOOGLE_EVENT_READ_SCOPE } from '../calendar/reader.js';
import { GOOGLE_CALENDAR_METADATA_SCOPE, GOOGLE_OWNED_EVENT_WRITE_SCOPE } from './writer.js';
const client = { clientId: 'fixture-writer.apps.googleusercontent.com', clientSecret: 'FIXTURE_SECRET' },
  callback = 'http://127.0.0.1:45678/',
  now = Date.parse('2026-10-05T00:00:00Z');
const scopes = [GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE];
const tokens = () => ({
  accessToken: 'FIXTURE_ACCESS',
  refreshToken: 'FIXTURE_REFRESH',
  expiresAt: now + 3600000,
  refreshExpiresAt: null,
  scopes: [...scopes],
});
function setup(granted: string[] = scopes) {
  const fetch = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(
        JSON.stringify({
          access_token: 'ROTATED_ACCESS',
          refresh_token: 'ROTATED_REFRESH',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: granted.join(' '),
        }),
      ),
  );
  const flow = new writerOAuth.GoogleCalendarWriterAuthorization(client, callback, { fetch, now: () => now }),
    url = new URL(flow.authorizationUrl);
  return { flow, url, fetch, response: callback + '?code=fixture&state=' + url.searchParams.get('state') };
}
it('S09 writer consent requests only its two fixed scopes while the S03 reader stays read-only', async () => {
  const s = setup(),
    reader = new GoogleCalendarAuthorization(client, callback);
  expect(s.url.searchParams.get('scope')?.split(' ')).toEqual(scopes);
  expect(new URL(reader.authorizationUrl).searchParams.get('scope')).toBe(GOOGLE_EVENT_READ_SCOPE);
  expect(s.flow.authorizationUrl).not.toContain('FIXTURE_SECRET');
  expect(s.url.searchParams.get('redirect_uri')).toBe(callback);
  expect(s.url.searchParams.get('code_challenge_method')).toBe('S256');
  const result = await s.flow.exchange(s.response);
  expect(result.scopes).toEqual(scopes);
  expect(writerOAuth.validGoogleCalendarWriterTokens(result)).toBe(true);
  // The established reader validator accepts existing event-readable grants; its API still requests only read access.
  expect(validGoogleCalendarTokens(result)).toBe(true);
  const [endpoint, init] = s.fetch.mock.calls[0],
    params = new URLSearchParams(String(init.body));
  expect(endpoint).toBe('https://oauth2.googleapis.com/token');
  expect(init.redirect).toBe('error');
  expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(
    s.url.searchParams.get('code_challenge'),
  );
});
it.each(
  [
    [GOOGLE_EVENT_READ_SCOPE],
    [GOOGLE_OWNED_EVENT_WRITE_SCOPE],
    [GOOGLE_CALENDAR_METADATA_SCOPE],
    [...scopes, GOOGLE_EVENT_READ_SCOPE],
    [...scopes, 'https://www.googleapis.com/auth/drive'],
    [...scopes, scopes[0]],
  ].map((granted) => ({ granted })),
)('rejects missing, broader or duplicate writer scope grants $granted', async ({ granted }) => {
  const s = setup(granted);
  await expect(s.flow.exchange(s.response)).rejects.toThrow('calendar_oauth_invalid_response');
  await expect(s.flow.exchange(s.response)).rejects.toThrow('calendar_oauth_flow_used');
  expect(s.fetch).toHaveBeenCalledTimes(1);
  expect(writerOAuth.validGoogleCalendarWriterTokens({ ...tokens(), scopes: granted })).toBe(false);
});
it('does not exchange a substituted callback or mismatched state', async () => {
  const s = setup();
  await expect(s.flow.exchange(s.response.replace('127.0.0.1', 'localhost'))).rejects.toThrow(
    'calendar_oauth_callback_invalid',
  );
  await expect(s.flow.exchange(s.response.replace('state=', 'state=wrong-'))).rejects.toThrow(
    'calendar_oauth_callback_invalid',
  );
  expect(s.fetch).not.toHaveBeenCalled();
});
it('consumes writer consent before dispatch and never retries an uncertain exchange', async () => {
  const s = setup();
  s.fetch.mockRejectedValue(new Error('PRIVATE_PROVIDER_TOKEN'));
  const first = s.flow.exchange(s.response);
  await expect(s.flow.exchange(s.response)).rejects.toThrow('calendar_oauth_flow_used');
  await expect(first).rejects.toThrow('calendar_oauth_exchange_uncertain');
  expect(s.fetch).toHaveBeenCalledTimes(1);
});
it('rotates writer tokens without requesting additional scope and denies read-only grants before contact', async () => {
  const s = setup();
  const result = await writerOAuth.refreshGoogleCalendarWriterToken(client, tokens(), {
    fetch: s.fetch,
    now: () => now,
  });
  expect(result.refreshToken).toBe('ROTATED_REFRESH');
  const params = new URLSearchParams(String(s.fetch.mock.calls[0][1].body));
  expect(params.has('scope')).toBe(false);
  expect(params.get('grant_type')).toBe('refresh_token');
  s.fetch.mockClear();
  await expect(
    writerOAuth.refreshGoogleCalendarWriterToken(
      client,
      { ...tokens(), scopes: [GOOGLE_EVENT_READ_SCOPE] },
      { fetch: s.fetch, now: () => now },
    ),
  ).rejects.toThrow('calendar_oauth_configuration_invalid');
  expect(s.fetch).not.toHaveBeenCalled();
});
it('preserves only the previously validated writer grant when a refresh omits scope or a rotated refresh token', async () => {
  const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'ROTATED_ACCESS', expires_in: 3600, token_type: 'Bearer' })),
    ),
    old = tokens();
  const result = await writerOAuth.refreshGoogleCalendarWriterToken(client, old, { fetch, now: () => now });
  expect(result.scopes).toEqual(scopes);
  expect(result.refreshToken).toBe(old.refreshToken);
});
