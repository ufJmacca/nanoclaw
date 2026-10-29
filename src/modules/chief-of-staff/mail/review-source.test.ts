import { expect, it, vi } from 'vitest';
import { googleMailReader } from './google-reader.js';
import { GOOGLE_MAIL_READ_SCOPE } from './oauth.js';

const now = Date.parse('2026-10-26T05:00:00.000Z'),
  window = { capturedAt: now, since: now - 30 * 86400000 };
function fixture(extra: Array<{ name: string; value: string }> = []) {
  let auth = 'ready',
    beforeReturn = () => {};
  const response = {
    id: 'aa01',
    threadId: 'bb01',
    historyId: '123',
    internalDate: String(now - 1000),
    labelIds: ['INBOX'],
    payload: {
      headers: [{ name: 'From', value: 'Colleague <colleague@example.test>' }, ...extra],
      body: { data: 'PRIVATE_BODY_CANARY' },
    },
  };
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.method).toBe('GET');
    if (new URL(url).pathname.endsWith('/profile'))
      return new Response(JSON.stringify({ emailAddress: 'owner@example.test', historyId: '123' }));
    beforeReturn();
    return new Response(JSON.stringify(response));
  });
  const reader = googleMailReader({
    access: async () => ({
      generation: 'fixture:1',
      mailboxEmail: 'owner@example.test',
      scopes: [GOOGLE_MAIL_READ_SCOPE],
      auth: auth as 'ready',
    }),
    token: async () => 'FIXTURE_PRIVATE_TOKEN',
    fetch,
    now: () => now,
  });
  return {
    reader,
    fetch,
    response,
    revokeDuringRead: () => {
      beforeReturn = () => {
        auth = 'revoked';
      };
    },
  };
}
it('uses only fixed read-only metadata headers and discloses no body, token or routing headers', async () => {
  const f = fixture();
  const result = await f.reader.reviewSource('aa01', window);
  expect(result).toEqual({
    id: 'aa01',
    threadId: 'bb01',
    historyId: '123',
    internalDate: now - 1000,
    observedAt: now,
    excluded: null,
  });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_BODY_CANARY|FIXTURE_PRIVATE_TOKEN|colleague@example/);
  const url = new URL(f.fetch.mock.calls.at(-1)![0]);
  expect(url.pathname).toBe('/gmail/v1/users/me/messages/aa01');
  expect(url.searchParams.get('format')).toBe('metadata');
  expect(url.searchParams.get('fields')).toBe('id,threadId,historyId,internalDate,labelIds,payload(headers)');
  expect(url.searchParams.getAll('metadataHeaders')).toEqual([
    'From',
    'Reply-To',
    'List-Id',
    'List-Unsubscribe',
    'Precedence',
    'Auto-Submitted',
    'X-Auto-Response-Suppress',
  ]);
});
it.each([
  ['List-Id', 'Team updates <list.example.test>', 'bulk_mail'],
  ['List-Unsubscribe', '<https://example.test/unsubscribe>', 'bulk_mail'],
  ['Precedence', 'bulk', 'bulk_mail'],
  ['Precedence', 'list', 'bulk_mail'],
  ['Auto-Submitted', 'auto-replied', 'automated_mail'],
  ['Auto-Submitted', 'auto-generated', 'automated_mail'],
  ['X-Auto-Response-Suppress', 'All', 'automated_mail'],
  ['Reply-To', 'no-reply@example.test', 'no_reply'],
])('excludes %s=%s using fresh provider metadata', async (name, value, excluded) => {
  expect((await fixture([{ name, value }]).reader.reviewSource('aa01', window)).excluded).toBe(excluded);
});
it('accepts explicit non-automatic mail and rejects no-reply senders', async () => {
  expect(
    (await fixture([{ name: 'Auto-Submitted', value: 'no' }]).reader.reviewSource('aa01', window)).excluded,
  ).toBeNull();
  const f = fixture();
  f.response.payload.headers[0].value = 'No reply <noreply@example.test>';
  expect((await f.reader.reviewSource('aa01', window)).excluded).toBe('no_reply');
});
it.each([
  'unselected',
  'outside-window',
  'foreign-message',
  'malformed-header',
  'duplicate-header',
  'unrequested-header',
] as const)('denies %s without exposing provider content', async (kind) => {
  const f = fixture();
  if (kind === 'unselected') f.response.labelIds = ['TRASH'];
  if (kind === 'outside-window') f.response.internalDate = String(window.since - 1);
  if (kind === 'foreign-message') f.response.id = 'cc01';
  if (kind === 'malformed-header') f.response.payload.headers[0].value = 'Sender\r\nInjected: value';
  if (kind === 'duplicate-header') f.response.payload.headers.push({ name: 'from', value: 'other@example.test' });
  if (kind === 'unrequested-header') f.response.payload.headers.push({ name: 'Content-Type', value: 'text/plain' });
  await expect(f.reader.reviewSource('aa01', window)).rejects.toThrow(/^mail_/);
});
it('rechecks revocation across the metadata await and rejects unsafe identifiers before network access', async () => {
  const f = fixture();
  f.revokeDuringRead();
  await expect(f.reader.reviewSource('aa01', window)).rejects.toThrow('mail_auth_revoked');
  const other = fixture();
  await expect(other.reader.reviewSource('../messages/other', window)).rejects.toThrow('mail_request_invalid');
  expect(other.fetch).not.toHaveBeenCalled();
});
