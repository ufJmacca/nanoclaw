import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

const SAFE_OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface HostExecutionLease {
  ownerId: string;
  pid: number;
}

export interface HostExecutionLeaseOptions {
  pid?: number;
  ownerId?: string;
  now?: () => string;
  isProcessAlive?: (pid: number) => boolean;
}

type HostExecutionLeaseRow = {
  owner_id: string;
  pid: number;
};

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ESRCH') return false;
    // Permission and indeterminate host errors must fail closed.
    return true;
  }
}

/** Atomically reserve container admission for one host process. */
export function acquireHostExecutionLease(
  db: Database.Database,
  options: HostExecutionLeaseOptions = {},
): HostExecutionLease {
  const pid = options.pid ?? process.pid;
  const ownerId = options.ownerId ?? randomUUID();
  const acquiredAt = (options.now ?? (() => new Date().toISOString()))();
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !SAFE_OWNER_ID.test(ownerId) ||
    !Number.isFinite(Date.parse(acquiredAt))
  ) {
    throw new Error('Invalid NanoClaw host execution lease identity');
  }

  return db
    .transaction(() => {
      const existing = db.prepare('SELECT owner_id, pid FROM host_execution_lease WHERE singleton_id = 1').get() as
        | HostExecutionLeaseRow
        | undefined;
      if (existing && existing.pid !== pid && isProcessAlive(existing.pid)) {
        throw new Error('NanoClaw host execution lease is already held by a live process');
      }
      db.prepare(
        `INSERT INTO host_execution_lease (singleton_id, owner_id, pid, acquired_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET
           owner_id = excluded.owner_id,
           pid = excluded.pid,
           acquired_at = excluded.acquired_at`,
      ).run(ownerId, pid, acquiredAt);
      return { ownerId, pid };
    })
    .immediate();
}

/** Release only the exact lease generation acquired by this process. */
export function releaseHostExecutionLease(db: Database.Database, lease: HostExecutionLease): boolean {
  return (
    db
      .prepare(
        `DELETE FROM host_execution_lease
          WHERE singleton_id = 1 AND owner_id = ? AND pid = ?`,
      )
      .run(lease.ownerId, lease.pid).changes === 1
  );
}
