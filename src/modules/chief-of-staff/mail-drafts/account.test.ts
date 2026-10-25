import { expect, it, vi } from 'vitest';
import { verifyMailDraftMailbox } from './account.js';
function fixture() {
  let active = true;
  const current = vi.fn(() => {
      if (!active) throw Error('PRIVATE_OWNER_DIAGNOSTIC');
    }),
    token = vi.fn(async () => 'PRIVATE_DRAFT_ACCESS'),
    fetch = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ emailAddress: 'OWNER@example.test' })),
    );
  return {
    current,
    token,
    fetch,
    active: (value: boolean) => {
      active = value;
    },
  };
}
it('checks only the fixed account profile with the dedicated token and never returns token or account data', async () => {
  const f = fixture();
  expect(await verifyMailDraftMailbox('owner@example.test', f.token, f)).toBeUndefined();
  expect(f.fetch).toHaveBeenCalledWith(
    'https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress',
    expect.objectContaining({
      method: 'GET',
      redirect: 'error',
      headers: {
        Authorization: 'Bearer PRIVATE_DRAFT_ACCESS',
        Accept: 'application/json',
        'Cache-Control': 'no-store',
      },
    }),
  );
  expect(f.fetch.mock.calls[0][1].body).toBeUndefined();
  expect(f.current.mock.calls.length).toBeGreaterThanOrEqual(5);
});
it.each([
  { emailAddress: 'foreign@example.test' },
  {},
  { emailAddress: 5 },
  { emailAddress: 'owner@example.test', unknown: 'PRIVATE_PROVIDER_DATA' },
])('rejects an unbound or malformed profile %j', async (profile) => {
  const f = fixture();
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify(profile)));
  await expect(verifyMailDraftMailbox('owner@example.test', f.token, f)).rejects.toThrow(
    'mail_draft_account_unavailable',
  );
});
it.each([302, 401, 403, 429, 500])(
  'does not accept or retry HTTP %s during owner account verification',
  async (status) => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(new Response('PRIVATE_PROVIDER_ERROR', { status }));
    await expect(verifyMailDraftMailbox('owner@example.test', f.token, f)).rejects.toThrow(
      'mail_draft_account_unavailable',
    );
    expect(f.fetch).toHaveBeenCalledTimes(1);
  },
);
it.each(['declared', 'streamed'] as const)('bounds the %s response independently of provider claims', async (kind) => {
  const f = fixture();
  f.fetch.mockResolvedValueOnce(
    kind === 'declared'
      ? new Response('{}', { headers: { 'Content-Length': '50000' } })
      : new Response(' '.repeat(20000) + '{"emailAddress":"owner@example.test"}'),
  );
  await expect(verifyMailDraftMailbox('owner@example.test', f.token, f)).rejects.toThrow(
    'mail_draft_account_unavailable',
  );
});
it.each(['token', 'profile'] as const)(
  'checks current owner authority after the awaited %s operation',
  async (stage) => {
    const f = fixture();
    if (stage === 'token')
      f.token.mockImplementationOnce(async () => {
        f.active(false);
        return 'PRIVATE_DRAFT_ACCESS';
      });
    else
      f.fetch.mockImplementationOnce(async () => {
        f.active(false);
        return new Response('{"emailAddress":"owner@example.test"}');
      });
    await expect(verifyMailDraftMailbox('owner@example.test', f.token, f)).rejects.toThrow(
      'mail_draft_account_unavailable',
    );
    if (stage === 'token') expect(f.fetch).not.toHaveBeenCalled();
  },
);
it('cancels a blocked response stream when the owner operation is aborted', async () => {
  const f = fixture(),
    cancellation = new AbortController();
  f.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ start() {} })));
  const result = verifyMailDraftMailbox('owner@example.test', f.token, { ...f, signal: cancellation.signal });
  await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
  cancellation.abort();
  await expect(result).rejects.toThrow('mail_draft_account_unavailable');
});
it('rejects invalid account selection and aborted operation before reading credentials', async () => {
  const f = fixture();
  await expect(verifyMailDraftMailbox('bad\r\naddress', f.token, f)).rejects.toThrow('mail_draft_account_unavailable');
  await expect(
    verifyMailDraftMailbox('owner@example.test', f.token, { ...f, signal: AbortSignal.abort() }),
  ).rejects.toThrow('mail_draft_account_unavailable');
  expect(f.token).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
});
