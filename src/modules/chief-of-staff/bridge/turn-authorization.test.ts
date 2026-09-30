import { afterEach, expect, it, vi } from 'vitest';
import { createTurnAuthorization } from './turn-authorization.js';
import type { Context } from '../domain/contracts.js';

afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  let context: Context | null = {
    scopeId: 'scope',
    ownerId: 'owner',
    sessionId: 'session',
    agentGroupId: 'group',
    ingressId: 'ingress',
  };
  const local = vi.fn(() => context);
  const verify = vi.fn(async () => context);
  return {
    local,
    verify,
    set: (value: Context | null) => {
      context = value;
    },
    authorize: createTurnAuthorization({ local, verify }),
  };
}
it('bounds remote checks during two minutes of one-second egress polling', async () => {
  const f = fixture();
  expect(await f.authorize()).toBe('ingress');
  for (let i = 0; i < 120; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    expect(await f.authorize('poll')).toBe('ingress');
  }
  expect(f.verify).toHaveBeenCalledTimes(9);
  expect(f.local.mock.calls.length).toBeGreaterThanOrEqual(121);
});
it('fresh admission bypasses the poll cache', async () => {
  const f = fixture();
  await f.authorize();
  f.verify.mockResolvedValue(null);
  expect(await f.authorize()).toBeNull();
  expect(await f.authorize('poll')).toBeNull();
  expect(f.verify).toHaveBeenCalledTimes(2);
});
it('local pause immediately denies a cached remote authorization', async () => {
  const f = fixture();
  await f.authorize();
  f.set(null);
  expect(await f.authorize('poll')).toBeNull();
  expect(f.verify).toHaveBeenCalledOnce();
});
it('does not reuse a permission result for a newer ingress', async () => {
  const f = fixture();
  await f.authorize();
  f.set({ ...f.local()!, ingressId: 'new' });
  expect(await f.authorize('poll')).toBe('new');
  expect(f.verify).toHaveBeenCalledTimes(2);
});
it('shares an in-flight remote check across simultaneous sockets', async () => {
  const f = fixture();
  let finish!: (context: Context | null) => void;
  f.verify.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const a = f.authorize(),
    b = f.authorize('poll');
  expect(f.verify).toHaveBeenCalledOnce();
  finish(f.local());
  expect(await Promise.all([a, b])).toEqual(['ingress', 'ingress']);
});
it('denies pause and ingress races while a remote check is pending', async () => {
  const f = fixture();
  let finish!: (context: Context | null) => void;
  f.verify.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const old = f.local(),
    pending = f.authorize();
  f.set(null);
  finish(old);
  expect(await pending).toBeNull();
});
it('never extends permission lifetime by the duration of a slow check', async () => {
  const f = fixture();
  let finish!: (context: Context | null) => void;
  f.verify.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.authorize();
  await vi.advanceTimersByTimeAsync(15000);
  finish(f.local());
  expect(await pending).toBeNull();
});
it('fails closed on revocation or transport failure and does not retry every second', async () => {
  const f = fixture();
  await f.authorize();
  f.verify.mockRejectedValue(Error('synthetic 429'));
  await vi.advanceTimersByTimeAsync(15000);
  expect(await f.authorize('poll')).toBeNull();
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    expect(await f.authorize('poll')).toBeNull();
  }
  expect(f.verify).toHaveBeenCalledTimes(2);
});
