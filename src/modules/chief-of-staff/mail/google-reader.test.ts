import { expect, it, vi } from 'vitest';
import { googleMailReader } from './google-reader.js';
import { GOOGLE_MAIL_READ_SCOPE } from './oauth.js';
import type { MailAccess } from './reader.js';
const now = Date.parse('2026-10-15T10:00:00Z'),
  window = { capturedAt: now, since: now - 30 * 86400000 };
const access = (): MailAccess => ({
  generation: 'fixture-binding:1',
  mailboxEmail: 'owner@example.invalid',
  scopes: [GOOGLE_MAIL_READ_SCOPE],
  auth: 'ready',
});
const raw = (id = 'aa01', labels = ['INBOX']) => ({
  id,
  threadId: 'bb02',
  historyId: '900719925474099312345',
  internalDate: String(now - 1000),
  labelIds: labels,
  payload: { mimeType: 'text/plain', body: { data: Buffer.from('FIXTURE_SELECTED_BODY').toString('base64url') } },
});
function setup(reply: unknown = {}, status = 200) {
  let grant = access();
  const token = vi.fn(async () => 'FIXTURE_PRIVATE_TOKEN');
  const fetch = vi.fn(async (url: string, _init: RequestInit) =>
    url.includes('/profile')
      ? new Response(JSON.stringify({ emailAddress: 'owner@example.invalid', historyId: '900719925474099312345' }))
      : new Response(JSON.stringify(reply), { status }),
  );
  const reader = googleMailReader({
    access: async () => structuredClone(grant),
    token,
    fetch,
    now: () => now,
    sleep: async () => {},
  });
  return {
    reader,
    fetch,
    token,
    change: (patch: Partial<MailAccess>) => {
      grant = { ...grant, ...patch };
    },
  };
}
it('checks the intended mailbox through a fixed read-only profile endpoint and never exports token material', async () => {
  const f = setup();
  expect(await f.reader.profile()).toEqual({
    mailboxEmail: 'owner@example.invalid',
    historyId: '900719925474099312345',
  });
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(f.fetch.mock.calls[0][0]).toMatch(/^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/profile\?/);
  expect(f.fetch.mock.calls[0][1]).toMatchObject({
    method: 'GET',
    redirect: 'error',
    headers: { Authorization: 'Bearer FIXTURE_PRIVATE_TOKEN' },
  });
});
it('uses a fixed rolling Inbox/Sent union query and exact bounded pagination', async () => {
  const f = setup({
    messages: [{ id: 'aa01', threadId: 'bb02' }],
    nextPageToken: 'fixture-page',
    resultSizeEstimate: 4,
  });
  expect(await f.reader.list(window)).toEqual({
    messages: [{ id: 'aa01', threadId: 'bb02' }],
    nextPageToken: 'fixture-page',
    resultSizeEstimate: 4,
  });
  const url = new URL(f.fetch.mock.calls.at(-1)![0]);
  expect(url.pathname).toBe('/gmail/v1/users/me/messages');
  expect(url.searchParams.get('maxResults')).toBe('100');
  expect(url.searchParams.get('includeSpamTrash')).toBe('false');
  for (const term of ['{in:inbox in:sent}', '-in:spam', '-in:trash', 'after:' + Math.floor(window.since / 1000)])
    expect(url.searchParams.get('q')).toContain(term);
  await f.reader.list(window, 'fixture-next&not=an-injected-query');
  expect(new URL(f.fetch.mock.calls.at(-1)![0]).searchParams.get('pageToken')).toBe(
    'fixture-next&not=an-injected-query',
  );
  expect(f.fetch.mock.calls.filter(([url]) => url.includes('/profile'))).toHaveLength(1);
});
it('normalizes each message and filters excluded thread members before any body can leave the host', async () => {
  const f = setup(raw());
  const selected = await f.reader.message('aa01', window);
  expect(selected.status).toBe('selected');
  const t = setup({
    id: 'bb02',
    messages: [
      raw(),
      raw('aa02', ['SENT']),
      { ...raw('aa03', ['INBOX', 'SPAM']), payload: 'PRIVATE_SPAM_BODY' },
      { ...raw('aa04', ['TRASH', 'SENT']), payload: 'PRIVATE_TRASH_BODY' },
    ],
  });
  const result = await t.reader.thread('bb02', window);
  expect(result.messages.map((m) => m.id)).toEqual(['aa01', 'aa02']);
  expect(result.excluded).toBe(2);
  expect(result.unsupported).toBe(0);
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  expect(JSON.stringify(result)).not.toContain('TOKEN');
  expect(new URL(t.fetch.mock.calls.at(-1)![0]).searchParams.get('format')).toBe('full');
});
it('collects unfiltered history changes and deletions with large decimal cursor identity intact', async () => {
  const h = '900719925474099312345';
  const f = setup({
    history: [
      {
        id: (BigInt(h) + 1n).toString(),
        messages: [{ id: 'aa01' }],
        labelsRemoved: [{ message: { id: 'aa02' } }],
        messagesDeleted: [{ message: { id: 'aa03' } }],
        messagesAdded: [{ message: { id: 'aa04' } }],
      },
    ],
    historyId: '900719925474099312999',
    nextPageToken: 'fixture-next',
  });
  expect(await f.reader.history(h)).toEqual({
    changedIds: ['aa01', 'aa02', 'aa04'],
    deletedIds: ['aa03'],
    historyId: '900719925474099312999',
    nextPageToken: 'fixture-next',
  });
  const url = new URL(f.fetch.mock.calls.at(-1)![0]);
  expect(url.searchParams.get('startHistoryId')).toBe(h);
  expect(url.searchParams.has('labelId')).toBe(false);
  expect(url.searchParams.has('historyTypes')).toBe(false);
});
it.each(['expired', 'revoked', 'disconnected'] as const)('refuses %s grants before obtaining a token', async (auth) => {
  const f = setup();
  f.change({ auth });
  await expect(f.reader.list(window)).rejects.toThrow('mail_auth_' + auth);
  expect(f.token).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
});
it.each(
  [
    [],
    ['https://www.googleapis.com/auth/calendar.events.readonly'],
    ['https://www.googleapis.com/auth/gmail.modify'],
    [GOOGLE_MAIL_READ_SCOPE, 'https://www.googleapis.com/auth/gmail.compose'],
  ].map((scopes) => ({ scopes })),
)('refuses wrong or expanded scopes $scopes', async ({ scopes }) => {
  const f = setup();
  f.change({ scopes });
  await expect(f.reader.profile()).rejects.toThrow('mail_scope_denied');
  expect(f.fetch).not.toHaveBeenCalled();
});
it('denies a wrong token account before requesting mail content', async () => {
  const f = setup({ messages: [] });
  f.fetch.mockImplementation(
    async () => new Response(JSON.stringify({ emailAddress: 'other@example.invalid', historyId: '123' })),
  );
  await expect(f.reader.list(window)).rejects.toThrow('mail_wrong_account');
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(f.fetch.mock.calls[0][0]).toContain('/profile');
});
it('rechecks authority after awaited token access and after provider responses', async () => {
  const f = setup();
  f.token.mockImplementation(async () => {
    f.change({ generation: 'fixture-binding:2' });
    return 'FIXTURE_PRIVATE_TOKEN';
  });
  await expect(f.reader.profile()).rejects.toThrow('mail_access_changed');
  expect(f.fetch).not.toHaveBeenCalled();
  const g = setup();
  g.fetch.mockImplementation(async () => {
    g.change({ auth: 'revoked' });
    return new Response(JSON.stringify({ emailAddress: 'owner@example.invalid', historyId: '123' }));
  });
  await expect(g.reader.profile()).rejects.toThrow('mail_auth_revoked');
});
it.each([
  ['history', 404, 'mail_history_expired'],
  ['message', 404, 'mail_message_missing'],
  ['history', 401, 'mail_auth_revoked'],
  ['history', 403, 'mail_auth_revoked'],
] as const)('classifies %s HTTP %i without private provider error text', async (kind, status, code) => {
  const f = setup({ error: { message: 'PRIVATE_PROVIDER_DETAIL' } }, status);
  await expect(kind === 'history' ? f.reader.history('123') : f.reader.message('aa01', window)).rejects.toThrow(code);
  expect(f.fetch.mock.calls.filter(([url]) => !url.includes('/profile'))).toHaveLength(1);
});
it('bounds retries and only repeats fixed GET operations', async () => {
  const f = setup({}, 503);
  await expect(f.reader.history('123')).rejects.toThrow('mail_unavailable');
  expect(f.fetch.mock.calls.filter(([url]) => !url.includes('/profile'))).toHaveLength(3);
  expect(f.fetch.mock.calls.every(([, init]) => init.method === 'GET' && init.redirect === 'error')).toBe(true);
  const g = setup({}, 429);
  await expect(g.reader.history('123')).rejects.toThrow('mail_rate_limited');
  expect(g.fetch.mock.calls.filter(([url]) => !url.includes('/profile'))).toHaveLength(3);
});
it.each(['../../send', 'https://attacker.invalid/', 'aa01?format=raw', 'aa01%2Fsend', 'not-a-provider-id'])(
  'refuses unsafe message IDs %s before requests',
  async (id) => {
    const f = setup();
    await expect(f.reader.message(id, window)).rejects.toThrow('mail_request_invalid');
    expect(f.fetch).not.toHaveBeenCalled();
  },
);
it('refuses oversized and malformed responses and a mismatched provider message identity', async () => {
  const f = setup();
  f.fetch.mockImplementation(async () => new Response('{}', { headers: { 'content-length': String(5 * 1024 ** 2) } }));
  await expect(f.reader.profile()).rejects.toThrow('mail_response_too_large');
  const g = setup();
  g.fetch.mockImplementation(async () => new Response('PRIVATE_INVALID_JSON'));
  await expect(g.reader.profile()).rejects.toThrow('mail_invalid_response');
  const h = setup(raw('aa02'));
  await expect(h.reader.message('aa01', window)).rejects.toThrow('mail_invalid_response');
});
it('refuses cancelled operations without obtaining credentials or making requests', async () => {
  const signal = AbortSignal.abort(),
    token = vi.fn(async () => 'PRIVATE_TOKEN'),
    fetch = vi.fn();
  const reader = googleMailReader({ access: async () => access(), token, fetch, signal });
  await expect(reader.profile()).rejects.toThrow('mail_cancelled');
  expect(token).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it('checks the mailbox again when a refreshed token changes and refuses a different account before content', async () => {
  const f = setup({ messages: [], resultSizeEstimate: 0 });
  await f.reader.list(window);
  f.token.mockResolvedValue('ANOTHER_PRIVATE_TOKEN');
  f.fetch.mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          url.includes('/profile')
            ? { emailAddress: 'other@example.invalid', historyId: '123' }
            : { messages: [], resultSizeEstimate: 0 },
        ),
      ),
  );
  await expect(f.reader.list(window)).rejects.toThrow('mail_wrong_account');
  expect(f.fetch.mock.calls.filter(([url]) => url.includes('/messages'))).toHaveLength(1);
  expect(f.fetch.mock.calls.filter(([url]) => url.includes('/profile'))).toHaveLength(2);
});
it('bounds streamed response bytes even when content length is absent', async () => {
  const f = setup();
  f.fetch.mockImplementation(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(4 * 1024 ** 2 + 1));
            controller.close();
          },
        }),
      ),
  );
  await expect(f.reader.profile()).rejects.toThrow('mail_response_too_large');
});
it('cancels a stalled response body without returning any partial provider data', async () => {
  const controller = new AbortController();
  let began: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const fetch = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{"private":"'));
            began();
          },
        }),
      ),
  );
  const reader = googleMailReader({
    access: async () => access(),
    token: async () => 'PRIVATE_TOKEN',
    fetch,
    signal: controller.signal,
  });
  const pending = reader.profile();
  await started;
  controller.abort();
  await expect(pending).rejects.toThrow('mail_cancelled');
});
it('handles rate-limit reasons without obeying an excessive retry interval', async () => {
  const f = setup({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, 403);
  await expect(f.reader.history('123')).rejects.toThrow('mail_rate_limited');
  expect(f.fetch.mock.calls.filter(([url]) => !url.includes('/profile'))).toHaveLength(3);
  const g = setup();
  g.fetch.mockImplementation(async (url) =>
    url.includes('/profile')
      ? new Response(JSON.stringify({ emailAddress: 'owner@example.invalid', historyId: '123' }))
      : new Response('{}', { status: 429, headers: { 'retry-after': '3600' } }),
  );
  await expect(g.reader.history('123')).rejects.toThrow('mail_rate_limited');
  expect(g.fetch.mock.calls.filter(([url]) => !url.includes('/profile'))).toHaveLength(1);
});
it.each(['0', '1.2', '1e12', '../../history', '1'.repeat(129)])(
  'rejects invalid history IDs %s before credentials',
  async (id) => {
    const f = setup();
    await expect(f.reader.history(id)).rejects.toThrow('mail_request_invalid');
    expect(f.token).not.toHaveBeenCalled();
  },
);
