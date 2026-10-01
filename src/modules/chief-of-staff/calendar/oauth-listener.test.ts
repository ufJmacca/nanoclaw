import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { startCalendarAuthorization, type CalendarAuthorizationListener } from './oauth-listener.js';
import { GOOGLE_EVENT_READ_SCOPE } from './reader.js';
const client = { clientId: 'fixture-client.apps.googleusercontent.com' };
const listeners: CalendarAuthorizationListener[] = [];
afterEach(async () => {
  await Promise.all(listeners.splice(0).map((listener) => listener.close()));
});
const reply = () =>
  new Response(
    JSON.stringify({
      access_token: 'FIXTURE_ACCESS_TOKEN',
      refresh_token: 'FIXTURE_REFRESH_TOKEN',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: GOOGLE_EVENT_READ_SCOPE,
    }),
  );
async function setup(options: Parameters<typeof startCalendarAuthorization>[1] = {}) {
  const provider = vi.fn(async (_url: string, _init: RequestInit) => reply());
  const listener = await startCalendarAuthorization(client, { fetch: provider, ...options });
  listeners.push(listener);
  const auth = new URL(listener.authorizationUrl),
    callback = new URL(auth.searchParams.get('redirect_uri') ?? 'http://127.0.0.1:1/');
  callback.searchParams.set('code', 'fixture-code');
  callback.searchParams.set('state', auth.searchParams.get('state') ?? 'missing');
  return { listener, provider, callback };
}
describe('S03 exact loopback OAuth listener', () => {
  it('accepts a browser callback on its actual loopback port and never echoes credentials', async () => {
    const s = await setup();
    const response = await fetch(s.callback);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('FIXTURE_');
    expect(await s.listener.result).toMatchObject({ accessToken: 'FIXTURE_ACCESS_TOKEN' });
    expect(s.provider).toHaveBeenCalledOnce();
  });
  it('rejects invalid state, host, path and methods while leaving the legitimate attempt usable', async () => {
    const s = await setup(),
      wrong = new URL(s.callback);
    wrong.searchParams.set('state', 'wrong');
    for (const [url, init] of [
      [wrong, {}],
      [s.callback, { method: 'POST' }],
      [new URL('/other' + s.callback.search, s.callback), {}],
    ] as const) {
      expect((await fetch(url, init)).status).toBe(400);
    }
    // Node's fetch normalizes Host; use the HTTP client to exercise the actual hostile header.
    const hostileHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.get(s.callback, { headers: { Host: 'attacker.test' } }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
    });
    expect(hostileHost).toBe(400);
    expect(s.provider).not.toHaveBeenCalled();
    expect((await fetch(s.callback)).status).toBe(200);
    await s.listener.result;
  });
  it('sends a generic failure page and preserves a fixed error code when Google denies exchange', async () => {
    const s = await setup({
      fetch: async () =>
        new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'PRIVATE_GOOGLE_DETAIL' }), {
          status: 400,
        }),
    });
    const result = expect(s.listener.result).rejects.toThrow('calendar_oauth_revoked');
    const response = await fetch(s.callback);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('PRIVATE_GOOGLE_DETAIL');
    await result;
  });
  it('times out and closes the actual listener without leaving a pending consent attempt', async () => {
    const s = await setup({ timeoutMs: 20 });
    await expect(s.listener.result).rejects.toThrow('calendar_oauth_flow_expired');
    await s.listener.close();
    await expect(fetch(s.callback)).rejects.toThrow();
    expect(s.provider).not.toHaveBeenCalled();
  });
  it('operator cancellation closes the port and rejects the pending result', async () => {
    const s = await setup();
    const result = expect(s.listener.result).rejects.toThrow('calendar_oauth_cancelled');
    await s.listener.close();
    await result;
    await expect(fetch(s.callback)).rejects.toThrow();
  });
  it('aborts an in-flight token exchange when the operator cancels', async () => {
    let signal: AbortSignal | null | undefined, enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const s = await setup({
      fetch: async (_url, init) => {
        signal = init.signal;
        enter();
        return new Promise<Response>((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(new Error('fixture_aborted')), { once: true });
        });
      },
    });
    const browser = fetch(s.callback).catch(() => null);
    await entered;
    const ended = expect(s.listener.result).rejects.toThrow('calendar_oauth_cancelled');
    await s.listener.close();
    await ended;
    expect(signal?.aborted).toBe(true);
    await browser;
  });
  it('rejects overlapping callbacks without cancelling the first exchange or replaying its code', async () => {
    let release!: () => void, enter!: () => void;
    const wait = new Promise<void>((r) => {
        release = r;
      }),
      entered = new Promise<void>((r) => {
        enter = r;
      });
    const provider = vi.fn(async () => {
      enter();
      await wait;
      return reply();
    });
    const s = await setup({ fetch: provider });
    const first = fetch(s.callback);
    await entered;
    try {
      expect((await fetch(s.callback)).status).toBe(409);
    } finally {
      release();
    }
    expect((await first).status).toBe(200);
    await s.listener.result;
    expect(provider).toHaveBeenCalledOnce();
  });
});
