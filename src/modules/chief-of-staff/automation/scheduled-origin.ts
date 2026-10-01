import type Database from 'better-sqlite3';
import type { Session } from '../../../types.js';
import { cosBoundary, type CosBinding } from '../../../cos-boundary.js';
import { hasTable } from '../../../db/connection.js';
import { digest, type Context } from '../domain/contracts.js';
export type ScheduledLease = { runId: string; generation: number; hostId: string; deadlineAt: string };
type Row = {
  scope_id: string;
  binding_digest: string;
  owner_ingress_id: string | null;
  run_id: string;
  generation: number;
  lease_owner: string;
  deadline_at: string;
  interrupted: number;
};
function ensureSchema(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS cos_scheduled_origins (
  scope_id TEXT PRIMARY KEY,binding_digest TEXT NOT NULL,owner_ingress_id TEXT,
  run_id TEXT NOT NULL,generation INTEGER NOT NULL,lease_owner TEXT NOT NULL,deadline_at TEXT NOT NULL,
  interrupted INTEGER NOT NULL DEFAULT 0 CHECK(interrupted IN (0,1))
);`);
}
/** Recovery identity only. An interrupted or expired row grants no model or publication authority. */
export function readScheduledLease(db: Database.Database, binding: CosBinding): ScheduledLease | null {
  if (!hasTable(db, 'cos_scheduled_origins')) return null;
  const row = db.prepare('SELECT * FROM cos_scheduled_origins WHERE scope_id=?').get(binding.scopeId) as
    | Row
    | undefined;
  return row && row.binding_digest === digest(binding)
    ? { runId: row.run_id, generation: row.generation, hostId: row.lease_owner, deadlineAt: row.deadline_at }
    : null;
}
/** Only the trusted scheduler installs a successfully claimed PostgreSQL lease. This row is never offline authority. */
export function installScheduledOrigin(
  db: Database.Database,
  binding: CosBinding,
  session: Session,
  lease: ScheduledLease,
  now = Date.now(),
): boolean {
  const boundary = cosBoundary(session, db),
    deadline = Date.parse(lease.deadlineAt);
  if (
    !boundary.restricted ||
    !boundary.binding ||
    boundary.paused ||
    digest(boundary.binding) !== digest(binding) ||
    !/^[a-f0-9]{64}$/.test(lease.runId) ||
    !Number.isSafeInteger(lease.generation) ||
    lease.generation < 1 ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(lease.hostId) ||
    !Number.isFinite(deadline) ||
    deadline <= now ||
    deadline > now + 300000
  )
    return false;
  ensureSchema(db);
  return db.transaction(() => {
    db.prepare(
      'INSERT OR IGNORE INTO cos_scheduled_origins(scope_id,binding_digest,owner_ingress_id,run_id,generation,lease_owner,deadline_at) VALUES(?,?,?,?,?,?,?)',
    ).run(
      binding.scopeId,
      digest(binding),
      boundary.ingressId,
      lease.runId,
      lease.generation,
      lease.hostId,
      lease.deadlineAt,
    );
    const row = db.prepare('SELECT * FROM cos_scheduled_origins WHERE scope_id=?').get(binding.scopeId) as Row;
    return (
      row.binding_digest === digest(binding) &&
      row.owner_ingress_id === boundary.ingressId &&
      row.run_id === lease.runId &&
      row.generation === lease.generation &&
      row.lease_owner === lease.hostId &&
      row.deadline_at === lease.deadlineAt &&
      row.interrupted === 0
    );
  })();
}
/** undefined means ordinary owner origin; null is an outstanding scheduled fence, never a fallback permission. */
export function scheduledContext(
  session: Session,
  db: Database.Database,
  now = Date.now(),
): Context | null | undefined {
  const boundary = cosBoundary(session, db);
  if (!boundary.restricted) return undefined;
  if (!boundary.binding) return null;
  if (!hasTable(db, 'cos_scheduled_origins')) return undefined;
  const binding = boundary.binding,
    row = db.prepare('SELECT * FROM cos_scheduled_origins WHERE scope_id=?').get(binding.scopeId) as Row | undefined;
  if (!row) return undefined;
  const deadline = Date.parse(row.deadline_at);
  if (
    boundary.paused ||
    row.interrupted ||
    row.binding_digest !== digest(binding) ||
    row.owner_ingress_id !== boundary.ingressId ||
    !/^[a-f0-9]{64}$/.test(row.run_id) ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1 ||
    !Number.isFinite(deadline) ||
    deadline <= now ||
    deadline > now + 300000
  )
    return null;
  return {
    scopeId: binding.scopeId,
    ownerId: binding.ownerId,
    sessionId: binding.sessionId,
    agentGroupId: binding.agentGroupId,
    ingressId: `brief:${row.run_id}:${row.generation}`,
    origin: { kind: 'schedule', runId: row.run_id, generation: row.generation },
  };
}
export function interruptScheduledOrigin(db: Database.Database, binding: CosBinding): boolean {
  if (!hasTable(db, 'cos_scheduled_origins')) return false;
  return (
    db
      .prepare('UPDATE cos_scheduled_origins SET interrupted=1 WHERE scope_id=? AND binding_digest=?')
      .run(binding.scopeId, digest(binding)).changes > 0
  );
}
/** Call only after durable run reconciliation; ambiguous database outcomes retain the local fence. */
export function clearScheduledOrigin(db: Database.Database, binding: CosBinding, lease: ScheduledLease): boolean {
  if (!hasTable(db, 'cos_scheduled_origins')) return false;
  return (
    db
      .prepare(
        'DELETE FROM cos_scheduled_origins WHERE scope_id=? AND binding_digest=? AND run_id=? AND generation=? AND lease_owner=?',
      )
      .run(binding.scopeId, digest(binding), lease.runId, lease.generation, lease.hostId).changes === 1
  );
}
