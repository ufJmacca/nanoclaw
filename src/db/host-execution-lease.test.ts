import Database from 'better-sqlite3';
import { it, expect } from 'vitest';
import { migration017 } from './migrations/017-host-execution-lease.js';
import {
  acquireHostExecutionLease,
  assertHostExecutionLease,
  releaseHostExecutionLease,
} from './host-execution-lease.js';
it('asserts only the current host lease generation and refuses released or replaced ownership', () => {
  const db = new Database(':memory:');
  migration017.up(db);
  try {
    const first = acquireHostExecutionLease(db);
    expect(() => assertHostExecutionLease(db, first)).not.toThrow();
    const next = acquireHostExecutionLease(db);
    expect(() => assertHostExecutionLease(db, first)).toThrow('host_execution_authority_lost');
    expect(() => assertHostExecutionLease(db, next)).not.toThrow();
    releaseHostExecutionLease(db, next);
    expect(() => assertHostExecutionLease(db, next)).toThrow('host_execution_authority_lost');
  } finally {
    db.close();
  }
});
