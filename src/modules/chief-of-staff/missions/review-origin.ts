import type Database from 'better-sqlite3';
import type { Session } from '../../../types.js';
import { cosBoundary, type CosBinding } from '../../../cos-boundary.js';
import { hasTable } from '../../../db/connection.js';
import { digest, type Context } from '../domain/contracts.js';
import type { MissionReviewIdentity, MissionReviewLease } from './review-runs.js';
export type ReviewOriginGrant = { identity: MissionReviewIdentity; lease: MissionReviewLease; deadlineAt: string };
type Row = { binding_digest: string; owner_ingress_id: string | null; grant_json: string; interrupted: number };
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
function validGrant(v: unknown): v is ReviewOriginGrant {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 3) return false;
  const g = v as ReviewOriginGrant,
    i = g.identity,
    l = g.lease;
  return (
    !!i &&
    !!l &&
    typeof i === 'object' &&
    typeof l === 'object' &&
    Object.keys(i).length === 6 &&
    Object.keys(l).length === 2 &&
    id(i.missionId) &&
    uuid(i.submissionId) &&
    uuid(i.attemptId) &&
    id(i.sessionId) &&
    uuid(i.contextGeneration) &&
    Number.isSafeInteger(i.generation) &&
    i.generation > 0 &&
    id(l.owner) &&
    Number.isSafeInteger(l.fence) &&
    l.fence > 0 &&
    typeof g.deadlineAt === 'string' &&
    Number.isFinite(Date.parse(g.deadlineAt))
  );
}
function row(db: Database.Database, binding: CosBinding): Row | undefined {
  if (!hasTable(db, 'cos_mission_review_origins')) return undefined;
  return db.prepare('SELECT * FROM cos_mission_review_origins WHERE scope_id=?').get(binding.scopeId) as
    | Row
    | undefined;
}
function decode(value: Row): ReviewOriginGrant | null {
  try {
    const grant: unknown = JSON.parse(value.grant_json);
    return validGrant(grant) ? grant : null;
  } catch {
    return null;
  }
}
function currentGeneration(db: Database.Database, binding: CosBinding, generation: string): boolean {
  return (
    hasTable(db, 'cos_conversation_states') &&
    !!db
      .prepare(
        "SELECT 1 FROM cos_conversation_states WHERE scope_id=? AND binding_digest=? AND generation=? AND status='active'",
      )
      .get(binding.scopeId, digest(binding), generation)
  );
}
/** Recovery identity only, including expired/interrupted work. A retained row is not execution authority. */
export function readReviewOrigin(db: Database.Database, binding: CosBinding): ReviewOriginGrant | null {
  const stored = row(db, binding);
  return stored?.binding_digest === digest(binding) ? decode(stored) : null;
}
/** Host-only installation after an acknowledged remote claim and independent main-session idle check. */
export function installReviewOrigin(
  db: Database.Database,
  binding: CosBinding,
  session: Session,
  grant: ReviewOriginGrant,
  now = Date.now(),
): boolean {
  const boundary = cosBoundary(session, db),
    deadline = Date.parse(grant?.deadlineAt);
  if (
    !validGrant(grant) ||
    !boundary.restricted ||
    !boundary.binding ||
    boundary.paused ||
    digest(boundary.binding) !== digest(binding) ||
    grant.identity.sessionId !== session.id ||
    !currentGeneration(db, binding, grant.identity.contextGeneration) ||
    !Number.isFinite(deadline) ||
    deadline <= now ||
    deadline > now + 60000 ||
    (hasTable(db, 'cos_scheduled_origins') &&
      db.prepare('SELECT 1 FROM cos_scheduled_origins WHERE scope_id=?').get(binding.scopeId))
  )
    return false;
  db.exec(`CREATE TABLE IF NOT EXISTS cos_mission_review_origins (
    scope_id TEXT PRIMARY KEY,binding_digest TEXT NOT NULL,owner_ingress_id TEXT,
    grant_json TEXT NOT NULL,interrupted INTEGER NOT NULL DEFAULT 0 CHECK(interrupted IN (0,1))
  )`);
  return db.transaction(() => {
    db.prepare(
      'INSERT OR IGNORE INTO cos_mission_review_origins(scope_id,binding_digest,owner_ingress_id,grant_json) VALUES(?,?,?,?)',
    ).run(binding.scopeId, digest(binding), boundary.ingressId, JSON.stringify(grant));
    const stored = row(db, binding)!;
    return (
      stored.binding_digest === digest(binding) &&
      stored.owner_ingress_id === boundary.ingressId &&
      stored.interrupted === 0 &&
      digest(decode(stored)) === digest(grant)
    );
  })();
}
/** undefined permits ordinary origin lookup; null retains a closed review fence until exact reconciliation. */
export function reviewContext(session: Session, db: Database.Database, now = Date.now()): Context | null | undefined {
  const boundary = cosBoundary(session, db);
  if (!boundary.restricted) return undefined;
  if (!boundary.binding) return null;
  const binding = boundary.binding,
    stored = row(db, binding);
  if (!stored) return undefined;
  const grant = decode(stored);
  if (
    !grant ||
    boundary.paused ||
    stored.interrupted ||
    stored.binding_digest !== digest(binding) ||
    stored.owner_ingress_id !== boundary.ingressId ||
    grant.identity.sessionId !== session.id ||
    !currentGeneration(db, binding, grant.identity.contextGeneration) ||
    Date.parse(grant.deadlineAt) <= now ||
    Date.parse(grant.deadlineAt) > now + 60000
  )
    return null;
  return {
    scopeId: binding.scopeId,
    ownerId: binding.ownerId,
    sessionId: session.id,
    agentGroupId: binding.agentGroupId,
    ingressId: `mission-review:${grant.identity.missionId}:${grant.identity.generation}:${grant.lease.fence}`,
    origin: {
      kind: 'mission_review',
      runId: grant.identity.missionId,
      generation: grant.identity.generation,
      submissionId: grant.identity.submissionId,
      owner: grant.lease.owner,
      fence: grant.lease.fence,
    },
  };
}
export function interruptReviewOrigin(db: Database.Database, binding: CosBinding): boolean {
  return (
    hasTable(db, 'cos_mission_review_origins') &&
    db
      .prepare('UPDATE cos_mission_review_origins SET interrupted=1 WHERE scope_id=? AND binding_digest=?')
      .run(binding.scopeId, digest(binding)).changes > 0
  );
}
/** Host supplies the deadline from a freshly acknowledged remote renewal of this same lease. */
export function renewReviewOrigin(
  db: Database.Database,
  binding: CosBinding,
  session: Session,
  grant: ReviewOriginGrant,
  deadlineAt: string,
  now = Date.now(),
): boolean {
  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline) || deadline <= now || deadline > now + 60000) return false;
  return db.transaction(() => {
    const stored = row(db, binding),
      context = reviewContext(session, db, now);
    if (
      !stored ||
      !context ||
      stored.binding_digest !== digest(binding) ||
      !validGrant(grant) ||
      digest(decode(stored)) !== digest(grant)
    )
      return false;
    return (
      db
        .prepare(
          'UPDATE cos_mission_review_origins SET grant_json=? WHERE scope_id=? AND grant_json=? AND interrupted=0',
        )
        .run(JSON.stringify({ ...grant, deadlineAt }), binding.scopeId, stored.grant_json).changes === 1
    );
  })();
}
/** Only after the native task/container and remote review lease have been reconciled. */
export function clearReviewOrigin(db: Database.Database, binding: CosBinding, grant: ReviewOriginGrant): boolean {
  const stored = row(db, binding);
  if (
    !stored ||
    stored.binding_digest !== digest(binding) ||
    !validGrant(grant) ||
    digest(decode(stored)) !== digest(grant)
  )
    return false;
  return (
    db
      .prepare('DELETE FROM cos_mission_review_origins WHERE scope_id=? AND binding_digest=? AND grant_json=?')
      .run(binding.scopeId, digest(binding), stored.grant_json).changes === 1
  );
}
