/** Host-local stop journal. These records can only remove authority; PostgreSQL remains the mission ledger. */
import type Database from 'better-sqlite3';
import { hasTable } from './db/connection.js';
import { cosMissionIdentities, validCosMissionIdentity, type CosMissionIdentity } from './cos-mission-boundary.js';
const id = (v: string) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
type AttemptReason = 'database_unavailable' | 'authority_lost' | 'deadline' | 'cancelled';
type FamilyReason = 'owner_cancel' | 'origin_revoked';
function schema(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS cos_mission_stop_attempts (
    attempt_id TEXT PRIMARY KEY,agent_group_id TEXT NOT NULL UNIQUE,session_id TEXT NOT NULL UNIQUE,
    identity TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS cos_mission_stop_families (
    scope_id TEXT NOT NULL,mission_id TEXT NOT NULL,reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(scope_id,mission_id));`);
}
function same(a: unknown, b: CosMissionIdentity) {
  return (
    validCosMissionIdentity(a) &&
    Object.entries(b).every(([key, value]) => a[key as keyof CosMissionIdentity] === value)
  );
}
function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
}
/** Call before requesting native stop. Missing confirmation never removes this permanent fence. */
export function stopCosMissionAttempt(
  identity: CosMissionIdentity,
  reason: AttemptReason,
  db: Database.Database,
): void {
  if (
    !validCosMissionIdentity(identity) ||
    !['database_unavailable', 'authority_lost', 'deadline', 'cancelled'].includes(reason) ||
    !hasTable(db, 'cos_mission_boundaries')
  )
    throw new Error('mission_stop_identity_denied');
  const row = db
    .prepare('SELECT agent_group_id,session_id,identity FROM cos_mission_boundaries WHERE attempt_id=?')
    .get(identity.attemptId) as { agent_group_id: string; session_id: string; identity: string } | undefined;
  if (
    !row ||
    row.agent_group_id !== identity.agentGroupId ||
    row.session_id !== identity.sessionId ||
    !same(parse(row.identity), identity)
  )
    throw new Error('mission_stop_identity_denied');
  schema(db);
  db.transaction(() => {
    const existing = db
      .prepare('SELECT identity FROM cos_mission_stop_attempts WHERE attempt_id=? OR agent_group_id=? OR session_id=?')
      .all(identity.attemptId, identity.agentGroupId, identity.sessionId) as Array<{ identity: string }>;
    if (existing.length) {
      if (existing.length !== 1 || !same(parse(existing[0].identity), identity))
        throw new Error('mission_stop_identity_denied');
      return;
    }
    db.prepare(
      'INSERT INTO cos_mission_stop_attempts(attempt_id,agent_group_id,session_id,identity,reason) VALUES(?,?,?,?,?)',
    ).run(identity.attemptId, identity.agentGroupId, identity.sessionId, JSON.stringify(identity), reason);
  })();
}
/** Trusted owner/private-origin validation happens before this host-only function. RPC callers cannot select its scope. */
export function stopCosMissionFamily(
  scopeId: string,
  missionId: string,
  reason: FamilyReason,
  db: Database.Database,
): void {
  if (!id(scopeId) || !id(missionId) || !['owner_cancel', 'origin_revoked'].includes(reason))
    throw new Error('mission_stop_identity_denied');
  schema(db);
  db.prepare(
    'INSERT INTO cos_mission_stop_families(scope_id,mission_id,reason) VALUES(?,?,?) ON CONFLICT DO NOTHING',
  ).run(scopeId, missionId, reason);
}
/** False means only "no stop recorded"; it never substitutes for current PostgreSQL admission. */
export function isCosMissionStopped(identity: CosMissionIdentity, db: Database.Database): boolean {
  if (!validCosMissionIdentity(identity)) return true;
  return (
    (hasTable(db, 'cos_mission_stop_families') &&
      !!db
        .prepare('SELECT 1 FROM cos_mission_stop_families WHERE scope_id=? AND mission_id=?')
        .get(identity.scopeId, identity.missionId)) ||
    (hasTable(db, 'cos_mission_stop_attempts') &&
      !!db
        .prepare('SELECT 1 FROM cos_mission_stop_attempts WHERE attempt_id=? OR agent_group_id=? OR session_id=?')
        .get(identity.attemptId, identity.agentGroupId, identity.sessionId))
  );
}
/** Enumerate only exact, independently marked identities for native stop/reconciliation; never infer ordinary groups. */
export function stoppedCosMissionIdentities(db: Database.Database): CosMissionIdentity[] {
  return cosMissionIdentities(db).filter((identity) => isCosMissionStopped(identity, db));
}
