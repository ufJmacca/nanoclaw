import { EventEmitter } from 'node:events';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoundedDatabase } from './client.js';

function fixture(capacity = 2) {
  const client = { release: vi.fn(), query: vi.fn() };
  const pool = Object.assign(new EventEmitter(), { connect: vi.fn().mockResolvedValue(client) });
  return { client, pool, db: new BoundedDatabase(pool as unknown as pg.Pool, 100, capacity) };
}
afterEach(() => vi.useRealTimers());

describe('S01-PG04 bounded shared database client', () => {
  it('S04 refuses an aborted refresh before acquiring database credentials', async () => {
    const { db, pool } = fixture();
    await expect(db.run(async () => 'unused', false, AbortSignal.abort())).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it('S04 cancellation destroys an active mutation and retains its uncertain outcome', async () => {
    const { db, client } = fixture();
    const abort = new AbortController();
    const work = db.run(async () => new Promise(() => {}), true, abort.signal);
    const assertion = expect(work).rejects.toMatchObject({ code: 'pending' });
    await Promise.resolve();
    abort.abort();
    await assertion;
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('S04 cancellation during pool acquisition fences a late client without running the operation', async () => {
    const { db, client, pool } = fixture(1),
      abort = new AbortController();
    let arrive!: (client: unknown) => void;
    pool.connect.mockReturnValue(
      new Promise((resolve) => {
        arrive = resolve;
      }),
    );
    const operation = vi.fn(async () => 'late');
    const work = db.run(operation, false, abort.signal);
    const assertion = expect(work).rejects.toMatchObject({ code: 'unavailable' });
    abort.abort();
    await assertion;
    arrive(client);
    await Promise.resolve();
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('handles idle pool errors without crashing the host', () => {
    const { pool } = fixture();
    expect(() => pool.emit('error', new Error('secret endpoint detail'))).not.toThrow();
  });

  it('returns a safe error without leaking driver credentials', async () => {
    const { db, pool } = fixture();
    pool.connect.mockRejectedValue(new Error('password-canary connection details'));
    await expect(db.run(async () => 'unused')).rejects.toThrow('CoS database unavailable');
  });

  it('bounds the whole operation and destroys uncertain clients', async () => {
    vi.useFakeTimers();
    const { db, client } = fixture();
    const work = db.run(async () => new Promise(() => {}), true);
    const assertion = expect(work).rejects.toMatchObject({ code: 'pending' });
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('rejects overflow rather than allocating an unbounded pool queue', async () => {
    const { db, pool } = fixture(1);
    let finish!: (value: string) => void;
    const first = db.run(
      async () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    await expect(db.run(async () => 'extra')).rejects.toMatchObject({ code: 'busy' });
    expect(pool.connect).toHaveBeenCalledTimes(1);
    finish('done');
    await first;
  });

  it('bounds acquisition and destroys a client arriving after its deadline', async () => {
    vi.useFakeTimers();
    const { db, client, pool } = fixture();
    let arrive!: (value: unknown) => void;
    pool.connect.mockReturnValue(
      new Promise((resolve) => {
        arrive = resolve;
      }),
    );
    const work = db.run(async () => 'late');
    const assertion = expect(work).rejects.toMatchObject({ code: 'unavailable' });
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
    arrive(client);
    await Promise.resolve();
    await Promise.resolve();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('releases a healthy client once and keeps the original result', async () => {
    const { db, client } = fixture();
    await expect(db.run(async () => ({ approved: false }))).resolves.toEqual({ approved: false });
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('S01-PG02 shared runtime operation fence', () => {
  it('checks local admission before acquiring a connection', async () => {
    const f = fixture();
    const db = new BoundedDatabase(f.pool as unknown as pg.Pool, 100, 2, () => false);
    await expect(db.run(async () => 'forbidden', true)).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it('does not run an operation while a cross-host maintenance lock is held', async () => {
    const f = fixture();
    f.client.query.mockResolvedValue({ rows: [{ locked: false }] });
    const operation = vi.fn();
    const db = new BoundedDatabase(f.pool as unknown as pg.Pool, 100, 2, () => true);
    await expect(db.run(operation, true)).rejects.toMatchObject({ code: 'unavailable' });
    expect(operation).not.toHaveBeenCalled();
    expect(f.client.release).toHaveBeenCalledWith(true);
  });
  it('rechecks admission after the shared lock and releases that same client only after unlock', async () => {
    const f = fixture(),
      admission = vi.fn().mockReturnValue(true);
    f.client.query.mockResolvedValue({ rows: [{ locked: true, unlocked: true }] });
    const db = new BoundedDatabase(f.pool as unknown as pg.Pool, 100, 2, admission);
    await expect(db.run(async () => 'done')).resolves.toBe('done');
    expect(admission.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(f.client.query).toHaveBeenLastCalledWith('SELECT pg_advisory_unlock_shared(73101003) AS unlocked');
    expect(f.client.release).toHaveBeenCalledWith(false);
  });
});
