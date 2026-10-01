/** Permanent deny boundary; this table identifies a child but never grants execution authority. */
import type Database from 'better-sqlite3';
import { hasTable } from './db/connection.js';
import type { Session } from './types.js';

export type CosMissionIdentity = {
  scopeId: string;
  missionId: string;
  attemptId: string;
  generation: number;
  agentGroupId: string;
  sessionId: string;
  provider: 'codex';
};
const identityKeys = [
  'scopeId',
  'missionId',
  'attemptId',
  'generation',
  'agentGroupId',
  'sessionId',
  'provider',
] as const;
function validIdentity(value: unknown): value is CosMissionIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === identityKeys.length &&
    identityKeys.every((key) => Object.hasOwn(v, key)) &&
    ['scopeId', 'missionId', 'attemptId', 'agentGroupId', 'sessionId'].every(
      (key) => typeof v[key] === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v[key]),
    ) &&
    v.provider === 'codex' &&
    Number.isSafeInteger(v.generation) &&
    Number(v.generation) > 0
  );
}
function ensureSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cos_mission_boundaries (
    attempt_id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL UNIQUE, identity TEXT NOT NULL);`);
}
export function hasCosMissionBoundary(groupId: string, sessionId: string, db: Database.Database): boolean {
  return (
    hasTable(db, 'cos_mission_boundaries') &&
    !!db.prepare('SELECT 1 FROM cos_mission_boundaries WHERE agent_group_id=? OR session_id=?').get(groupId, sessionId)
  );
}
type Boundary = { restricted: false } | { restricted: true; identity: CosMissionIdentity | null };
type Row = { attempt_id: string; agent_group_id: string; session_id: string; identity: string };
export function missionBoundary(session: Session, db: Database.Database): Boundary {
  if (!hasTable(db, 'cos_mission_boundaries')) return { restricted: false };
  const rows = db
    .prepare('SELECT * FROM cos_mission_boundaries WHERE agent_group_id=? OR session_id=?')
    .all(session.agent_group_id, session.id) as Row[];
  if (!rows.length) return { restricted: false };
  const denied: Boundary = { restricted: true, identity: null };
  if (rows.length !== 1) return denied;
  try {
    const identity: unknown = JSON.parse(rows[0].identity);
    if (
      !validIdentity(identity) ||
      identity.attemptId !== rows[0].attempt_id ||
      identity.agentGroupId !== rows[0].agent_group_id ||
      identity.sessionId !== rows[0].session_id ||
      identity.agentGroupId !== session.agent_group_id ||
      identity.sessionId !== session.id ||
      identity.provider !== session.agent_provider ||
      session.messaging_group_id !== null ||
      session.thread_id !== null ||
      session.status !== 'active'
    )
      return denied;
    return { restricted: true, identity };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return denied;
  }
}
/** Record before allocation. Exact replay is safe; reuse of any execution identity is forbidden. */
export function installCosMissionBoundary(identity: CosMissionIdentity, db: Database.Database): void {
  if (!validIdentity(identity)) throw new Error('invalid_mission_identity');
  ensureSchema(db);
  db.transaction(() => {
    if (
      hasTable(db, 'cos_identity_boundaries') &&
      db
        .prepare('SELECT 1 FROM cos_identity_boundaries WHERE agent_group_id=? OR session_id=?')
        .get(identity.agentGroupId, identity.sessionId)
    )
      throw new Error('mission_identity_conflict');
    const rows = db
      .prepare('SELECT * FROM cos_mission_boundaries WHERE attempt_id=? OR agent_group_id=? OR session_id=?')
      .all(identity.attemptId, identity.agentGroupId, identity.sessionId) as Row[];
    if (rows.length) {
      const row = rows[0];
      let stored: unknown;
      try {
        stored = JSON.parse(row.identity);
      } catch (error) {
        throw new Error('mission_identity_conflict', { cause: error });
      }
      if (
        rows.length !== 1 ||
        row.attempt_id !== identity.attemptId ||
        row.agent_group_id !== identity.agentGroupId ||
        row.session_id !== identity.sessionId ||
        !validIdentity(stored) ||
        !identityKeys.every((key) => stored[key] === identity[key])
      )
        throw new Error('mission_identity_conflict');
      return;
    }
    db.prepare('INSERT INTO cos_mission_boundaries(attempt_id,agent_group_id,session_id,identity) VALUES(?,?,?,?)').run(
      identity.attemptId,
      identity.agentGroupId,
      identity.sessionId,
      JSON.stringify(identity),
    );
  })();
}
