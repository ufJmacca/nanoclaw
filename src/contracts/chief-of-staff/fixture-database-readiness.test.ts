import type pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { BoundedDatabase, DatabaseUnavailable } from '../../modules/chief-of-staff/store/client.js';
import { readyFixtureDatabase } from './fixture-database-readiness.js';

afterEach(() => vi.useRealTimers());
function fixture() {
  const client = { query: vi.fn().mockResolvedValue({ rows: [{ fixture_ready: 1 }] }), release: vi.fn() },
    pool = { on: vi.fn(), connect: vi.fn().mockResolvedValue(client) },
    database = new BoundedDatabase(pool as unknown as pg.Pool);
  return { database, pool, client };
}

it('establishes readiness with one read on the existing selected pool', async () => {
  const f = fixture(),
    run = vi.spyOn(f.database, 'run');
  await readyFixtureDatabase(f.database);
  expect(f.pool.connect).toHaveBeenCalledTimes(1);
  expect(f.client.query.mock.calls).toEqual([['SELECT 1 AS fixture_ready']]);
  expect(run.mock.calls[0][1]).toBe(false);
  expect(f.client.release).toHaveBeenCalledWith(false);
  expect(f.database.inspectPool().admitted).toBe(0);
});

it('allows one read-only startup retry after the same pool finishes its real cooldown', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    run = vi.spyOn(f.database, 'run');
  f.pool.connect.mockRejectedValueOnce(Error('synthetic initial connection reset'));
  const outcome = expect(readyFixtureDatabase(f.database)).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(999);
  expect(f.pool.connect).toHaveBeenCalledTimes(1);
  expect(f.database.inspectPool().connection_state).toBe('cooldown');
  await vi.advanceTimersByTimeAsync(1);
  await outcome;
  expect(f.pool.connect).toHaveBeenCalledTimes(2);
  expect(f.client.query.mock.calls).toEqual([['SELECT 1 AS fixture_ready']]);
  expect(run.mock.calls.every((call) => call[1] === false)).toBe(true);
  expect(f.database.inspectPool()).toMatchObject({ admitted: 0, connection_state: 'recent_success' });
});

it('leaves a persistent outage closed after two read attempts without resetting its pool', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.pool.connect.mockRejectedValue(Error('synthetic persistent outage'));
  const outcome = expect(readyFixtureDatabase(f.database)).rejects.toBeInstanceOf(DatabaseUnavailable);
  await vi.advanceTimersByTimeAsync(1000);
  await outcome;
  expect(f.pool.connect).toHaveBeenCalledTimes(2);
  expect(f.client.query).not.toHaveBeenCalled();
  expect(f.database.inspectPool()).toMatchObject({ admitted: 0, connection_state: 'cooldown' });
});

it.each(['busy', 'pending'] as const)('does not retry %s admission or uncertain work', async (code) => {
  const error = new DatabaseUnavailable(code),
    run = vi.fn().mockRejectedValue(error);
  await expect(readyFixtureDatabase({ run })).rejects.toBe(error);
  expect(run).toHaveBeenCalledTimes(1);
});

it('propagates unexpected errors without hiding or retrying them', async () => {
  const error = Error('synthetic unexpected failure'),
    run = vi.fn().mockRejectedValue(error);
  await expect(readyFixtureDatabase({ run })).rejects.toBe(error);
  expect(run).toHaveBeenCalledTimes(1);
});

it('rejects an invalid readiness response without retrying', async () => {
  const f = fixture();
  f.client.query.mockResolvedValue({ rows: [{ fixture_ready: 0 }] });
  await expect(readyFixtureDatabase(f.database)).rejects.toThrow('fixture_database_readiness_unverified');
  expect(f.pool.connect).toHaveBeenCalledTimes(1);
});
