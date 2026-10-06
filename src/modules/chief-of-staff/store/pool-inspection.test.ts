import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { expect, it } from 'vitest';
import { BoundedDatabase } from './client.js';
it('S11-PG01 pool inspection reports bounded capacity/waiting and idle failures without credentials or new connections', async () => {
  const pool = Object.assign(new EventEmitter(), {
    totalCount: 3,
    idleCount: 1,
    waitingCount: 2,
    connect: () => {
      throw Error('PRIVATE_SECRET');
    },
  });
  const db = new BoundedDatabase(pool as unknown as pg.Pool, 100, 5);
  expect(db.inspectPool()).toEqual({
    capacity: 5,
    admitted: 0,
    total: 3,
    idle: 1,
    used: 2,
    waiting: 2,
    connection_state: 'unverified',
  });
  pool.emit('error', new Error('PRIVATE_IDLE_ERROR'));
  expect(db.inspectPool()).toMatchObject({ connection_state: 'cooldown', capacity: 5 });
  expect(JSON.stringify(db.inspectPool())).not.toContain('PRIVATE');
});
