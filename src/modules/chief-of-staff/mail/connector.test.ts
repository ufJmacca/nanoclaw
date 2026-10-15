import { describe, expect, it, vi } from 'vitest';
import { MailConnector } from './connector.js';
import { MailReadError } from './reader.js';
import { GOOGLE_MAIL_READ_SCOPE } from './oauth.js';
import { normalizeMailMessage, MAIL_RETENTION_MS } from './normalization.js';
import type { Result, Context } from '../domain/contracts.js';
import type { MailCapture } from './capture.js';
import type { MailConnection } from './store.js';
import { CalendarReadError } from '../calendar/reader.js';
const context = {
  scopeId: 'scope',
  ownerId: 'owner',
  agentGroupId: 'group',
  sessionId: 'session',
  ingressId: 'ingress',
  provider: 'codex',
};
const id = '11111111-1111-4111-8111-111111111111',
  captureId = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const at = 1800000000000,
    window = { capturedAt: at, since: at - MAIL_RETENTION_MS };
  const binding = {
    id,
    provider: 'fixture' as const,
    mailboxEmail: 'owner@example.invalid',
    scopes: [GOOGLE_MAIL_READ_SCOPE],
    processingProviders: ['codex'],
    version: 1,
    auth: 'ready' as const,
  };
  const store = {
    connection: vi.fn(async (): Promise<Result> => ({ status: 'ok', binding })),
    captureWindow: vi.fn(async (): Promise<Result> => ({ status: 'ok', window })),
    start: vi.fn(async (): Promise<Result> => ({ status: 'ok', previous: null })),
    filterCapture: vi.fn(async (_ctx, _id, capture): Promise<Result> => ({ status: 'ok', capture })),
    publish: vi.fn(
      async (_ctx: Context, _binding: string, _id: string, _capture: MailCapture): Promise<Result> => ({
        status: 'ok',
        capture_id: captureId,
      }),
    ),
    fail: vi.fn(async (): Promise<Result> => ({ status: 'ok' })),
    setAuth: vi.fn(async (): Promise<Result> => ({ status: 'ok' })),
  };
  const reader = {
    profile: vi.fn(async () => ({ mailboxEmail: binding.mailboxEmail, historyId: '100' })),
    list: vi.fn(async () => ({ messages: [{ id: 'a1', threadId: 'b1' }], nextPageToken: null, resultSizeEstimate: 1 })),
    message: vi.fn(async () =>
      normalizeMailMessage(
        {
          id: 'a1',
          threadId: 'b1',
          historyId: '101',
          internalDate: String(at - 1000),
          labelIds: ['INBOX'],
          payload: {
            mimeType: 'text/plain',
            body: { data: Buffer.from('Untrusted fixture mail').toString('base64url') },
          },
        },
        window,
      ),
    ),
    history: vi.fn(async () => ({ changedIds: [], deletedIds: [], historyId: '101', nextPageToken: null })),
    thread: vi.fn(async () => ({ messages: [], excluded: 0, unsupported: 0 })),
  };
  const fences = { assertOpen: vi.fn(), deny: vi.fn(), runCheck: vi.fn(async (_s, _b, operation) => operation()) };
  const options = { store, fences, admitted: () => true, fixtureReader: () => reader, verifyStorage: vi.fn() };
  return { at, window, binding, store, reader, fences, options, connector: new MailConnector(options) };
}
describe('G04 host-only mail refresh', () => {
  it('uses the database observation window and publishes only the owner-filtered capture after checked collection', async () => {
    const f = fixture(),
      result = await f.connector.refresh(context, id, captureId);
    expect(result.result.status).toBe('ok');
    expect(f.store.start).toHaveBeenCalledWith(context, id, captureId, f.window);
    expect(f.store.filterCapture).toHaveBeenCalledTimes(1);
    expect(f.store.publish.mock.calls[0]?.[3]).toMatchObject({
      window: f.window,
      mailboxEmail: f.binding.mailboxEmail,
      messages: [{ id: 'a1' }],
    });
    expect(f.reader.thread).not.toHaveBeenCalled();
    expect(f.options.verifyStorage).toHaveBeenCalled();
  });
  it('does no provider or store work when polling admission is closed', async () => {
    const f = fixture();
    f.options.admitted = () => false;
    expect((await f.connector.refresh(context, id, captureId)).result.status).toBe('denied');
    expect(f.store.connection).not.toHaveBeenCalled();
    expect(f.reader.profile).not.toHaveBeenCalled();
  });
  it('does not send a Google request after token acquisition loses current admission', async () => {
    const f = fixture(),
      binding: MailConnection = { ...f.binding, provider: 'google', credentialRef: captureId };
    f.store.connection.mockResolvedValue({ status: 'ok', binding });
    const fetch = vi.fn(async () => new Response('{}'));
    const connector = new MailConnector({
      ...f.options,
      fetch,
      credentials: {
        inspect: async () => ({ auth: 'ready', scopes: [GOOGLE_MAIL_READ_SCOPE], generation: 1 }),
        token: async () => {
          f.options.admitted = () => false;
          return 'PRIVATE_FIXTURE_TOKEN';
        },
      },
      admitted: () => f.options.admitted(),
    });
    expect((await connector.refresh(context, id, captureId)).result.status).toBe('denied');
    expect(fetch).not.toHaveBeenCalled();
    expect(f.store.publish).not.toHaveBeenCalled();
  });
  it('latches a wrong token mailbox as access loss before publishing any content', async () => {
    const f = fixture();
    f.reader.profile.mockResolvedValue({ mailboxEmail: 'other@example.invalid', historyId: '100' });
    const result = await f.connector.refresh(context, id, captureId);
    expect(result.result.access_loss).toBe('revoked');
    expect(f.store.publish).not.toHaveBeenCalled();
    expect(f.reader.list).not.toHaveBeenCalled();
    expect(f.fences.deny).toHaveBeenCalledWith('scope', id, 'revoked');
  });
  it('keeps denial latched even if the independent journal cannot persist it', async () => {
    const f = fixture();
    f.reader.profile.mockRejectedValue(new MailReadError('mail_auth_revoked'));
    f.fences.deny.mockImplementation(() => {
      throw Error('/private/storage/path');
    });
    const result = await f.connector.refresh(context, id, captureId);
    expect(result.result).toMatchObject({
      status: 'unavailable',
      code: 'mail_access_fence_failed',
      access_loss: 'revoked',
    });
    expect(JSON.stringify(result)).not.toContain('/private');
    expect(() => f.connector.assertOpen('scope', id)).toThrow('mail_auth_revoked');
  });
  it('reconciles a credential refresh that durably expired its journal before returning an uncertain exchange', async () => {
    const f = fixture();
    let closed = false;
    f.fences.assertOpen.mockImplementation(() => {
      if (closed) throw new CalendarReadError('calendar_auth_expired');
    });
    f.store.connection.mockResolvedValue({
      status: 'ok',
      binding: { ...f.binding, provider: 'google', credentialRef: captureId },
    });
    const connector = new MailConnector({
      ...f.options,
      credentials: {
        inspect: async () => ({ auth: 'ready', scopes: [GOOGLE_MAIL_READ_SCOPE], generation: 1 }),
        token: async () => {
          closed = true;
          throw new CalendarReadError('calendar_oauth_exchange_uncertain');
        },
      },
    });
    const result = await connector.refresh(context, id, captureId);
    expect(result.result.access_loss).toBe('expired');
    expect(f.store.setAuth).toHaveBeenCalledWith(context, id, 'expired');
    expect(f.store.publish).not.toHaveBeenCalled();
  });
  it('does no work for an already-cancelled poll', async () => {
    const f = fixture();
    expect((await f.connector.refresh(context, id, captureId, undefined, AbortSignal.abort())).result.status).toBe(
      'unavailable',
    );
    expect(f.store.connection).not.toHaveBeenCalled();
    expect(f.reader.profile).not.toHaveBeenCalled();
  });
  it('does not leak database diagnostics if durable access loss cannot update PostgreSQL', async () => {
    const f = fixture();
    f.reader.profile.mockRejectedValue(new MailReadError('mail_auth_revoked'));
    f.store.setAuth.mockRejectedValue(Error('/private/database/diagnostics'));
    const result = await f.connector.refresh(context, id, captureId);
    expect(result.result).toMatchObject({ status: 'unavailable', access_loss: 'revoked' });
    expect(JSON.stringify(result)).not.toContain('/private');
    expect(() => f.connector.assertOpen('scope', id)).toThrow('mail_auth_revoked');
  });
  it('latches provider revocation before a failed database denial can return', async () => {
    const f = fixture();
    f.reader.profile.mockRejectedValue(new MailReadError('mail_auth_revoked'));
    f.store.setAuth.mockResolvedValue({ status: 'unavailable' });
    const result = await f.connector.refresh(context, id, captureId);
    expect(result.result.access_loss).toBe('revoked');
    expect(f.fences.deny).toHaveBeenCalledWith('scope', id, 'revoked');
    expect(() => f.connector.assertOpen('scope', id)).toThrow('mail_auth_revoked');
    expect(f.store.publish).not.toHaveBeenCalled();
  });
  it('rechecks admission after asynchronous provider work and discards the capture on pause', async () => {
    const f = fixture();
    f.reader.message.mockImplementationOnce(async () => {
      f.options.admitted = () => false;
      return { status: 'excluded', reason: 'not_selected' };
    });
    expect((await f.connector.refresh(context, id, captureId)).result.status).toBe('denied');
    expect(f.store.publish).not.toHaveBeenCalled();
  });
  it('returns private prepared recovery data after an uncertain publish and retries only its exact identity', async () => {
    const f = fixture();
    f.store.publish.mockResolvedValueOnce({ status: 'pending' });
    const first = await f.connector.refresh(context, id, captureId);
    expect(first.result.status).toBe('pending');
    expect(first.prepared?.capture.messages).toHaveLength(1);
    f.store.publish.mockResolvedValue({ status: 'ok' });
    const before = f.reader.profile.mock.calls.length;
    expect((await f.connector.refresh(context, id, captureId, first.prepared)).result.status).toBe('ok');
    expect(f.reader.profile.mock.calls.length).toBe(before);
    expect(
      (await f.connector.refresh(context, id, '33333333-3333-4333-8333-333333333333', first.prepared)).result.status,
    ).toBe('denied');
  });
  it('single-flights one binding and never returns another caller’s private prepared capture', async () => {
    const f = fixture();
    let resume!: () => void;
    const hold = new Promise<void>((resolve) => {
      resume = resolve;
    });
    f.reader.profile.mockImplementationOnce(async () => {
      await hold;
      return { mailboxEmail: f.binding.mailboxEmail, historyId: '100' };
    });
    const pending = f.connector.refresh(context, id, captureId);
    const other = await f.connector.refresh({ ...context, ownerId: 'foreign' }, id, captureId);
    expect(other.prepared).toBeUndefined();
    expect(other.result.status).not.toBe('ok');
    resume();
    expect((await pending).result.status).toBe('ok');
    expect(f.reader.profile).toHaveBeenCalledTimes(1);
  });
  it('lets a duplicate waiter cancel without cancelling the original checked refresh', async () => {
    const f = fixture();
    let resume!: () => void;
    const hold = new Promise<void>((resolve) => {
      resume = resolve;
    });
    f.reader.profile.mockImplementationOnce(async () => {
      await hold;
      return { mailboxEmail: f.binding.mailboxEmail, historyId: '100' };
    });
    const original = f.connector.refresh(context, id, captureId),
      controller = new AbortController();
    const duplicate = f.connector.refresh(context, id, captureId, undefined, controller.signal);
    controller.abort();
    expect((await duplicate).result.status).toBe('unavailable');
    resume();
    expect((await original).result.status).toBe('ok');
    expect(f.reader.profile).toHaveBeenCalledTimes(1);
  });
});
