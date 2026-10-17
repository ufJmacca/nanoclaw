import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { createNativeFixtureDatabase } from './native-fixture-database.js';

afterEach(() => vi.useRealTimers());

function fixture(input: Parameters<typeof createNativeFixtureDatabase>[1]) {
  const client = { release: vi.fn() };
  const pool = Object.assign(new EventEmitter(), { connect: vi.fn().mockResolvedValue(client) });
  return { client, database: createNativeFixtureDatabase(pool as unknown as pg.Pool, input) };
}

async function delayedMutation(input: Parameters<typeof createNativeFixtureDatabase>[1]) {
  vi.useFakeTimers();
  const f = fixture(input);
  const outcome = f.database
    .run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 750));
      return { status: 'ok' };
    }, true)
    .then(
      (result) => ({ result }),
      (error: unknown) => ({ failure: (error as { code: string }).code }),
    );
  await vi.advanceTimersByTimeAsync(751);
  return { ...f, outcome: await outcome };
}

it('lets a strategic proposal finish after a 750 ms fixture operation', async () => {
  const f = await delayedMutation({ strategy: true });
  expect(f.outcome).toEqual({ result: { status: 'ok' } });
  expect(f.client.release).toHaveBeenCalledExactlyOnceWith(false);
});

it('still fences an uncertain strategic mutation at its finite three-second deadline', async () => {
  vi.useFakeTimers();
  const f = fixture({ strategy: true });
  const outcome = f.database
    .run(async () => new Promise(() => {}), true)
    .then(
      () => ({ completed: true }),
      (error: unknown) => ({ failure: (error as { code: string }).code }),
    );
  await vi.advanceTimersByTimeAsync(2999);
  expect(f.client.release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2);
  expect(await outcome).toEqual({ failure: 'pending' });
  expect(f.client.release).toHaveBeenCalledExactlyOnceWith(true);
});

it('keeps ordinary outage fixtures on their short deadline', async () => {
  const f = await delayedMutation({});
  expect(f.outcome).toEqual({ failure: 'pending' });
  expect(f.client.release).toHaveBeenCalledExactlyOnceWith(true);
});

it('preserves the existing mission fixture budget', async () => {
  const f = await delayedMutation({ mission: {} });
  expect(f.outcome).toEqual({ result: { status: 'ok' } });
  expect(f.client.release).toHaveBeenCalledExactlyOnceWith(false);
});
