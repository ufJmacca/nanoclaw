import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initTestDb } from './db/connection.js';
import { installCosMissionBoundary, type CosMissionIdentity } from './cos-mission-boundary.js';
import {
  isCosMissionStopped,
  stopCosMissionAttempt,
  stopCosMissionFamily,
  stoppedCosMissionIdentities,
} from './cos-mission-stop.js';
const a: CosMissionIdentity = {
  scopeId: 'cos',
  missionId: 'mission-a',
  attemptId: 'attempt-a',
  generation: 1,
  agentGroupId: 'group-a',
  sessionId: 'session-a',
  provider: 'codex',
};
const b: CosMissionIdentity = {
  ...a,
  missionId: 'mission-b',
  attemptId: 'attempt-b',
  agentGroupId: 'group-b',
  sessionId: 'session-b',
};
beforeEach(() => initTestDb());
afterEach(() => closeDb());
it('S05-PG02 records a durable deny-only attempt stop without database or provider access', () => {
  const db = getDb();
  installCosMissionBoundary(a, db);
  installCosMissionBoundary(b, db);
  stopCosMissionAttempt(a, 'database_unavailable', db);
  expect(isCosMissionStopped(a, db)).toBe(true);
  expect(isCosMissionStopped(b, db)).toBe(false);
  expect(stoppedCosMissionIdentities(db)).toEqual([a]);
  stopCosMissionAttempt(a, 'database_unavailable', db);
  expect(db.prepare('SELECT count(*) AS n FROM cos_mission_stop_attempts').get()).toEqual({ n: 1 });
  expect(isCosMissionStopped({ ...a, sessionId: 'substituted' }, db)).toBe(true);
});
it('S05-T07 a family tombstone also stops identities allocated after cancellation', () => {
  const db = getDb();
  stopCosMissionFamily(a.scopeId, a.missionId, 'owner_cancel', db);
  installCosMissionBoundary(a, db);
  installCosMissionBoundary(b, db);
  const retry = { ...a, attemptId: 'attempt-a2', generation: 2, agentGroupId: 'group-a2', sessionId: 'session-a2' };
  installCosMissionBoundary(retry, db);
  expect(isCosMissionStopped(a, db)).toBe(true);
  expect(isCosMissionStopped(retry, db)).toBe(true);
  expect(isCosMissionStopped(b, db)).toBe(false);
  expect(stoppedCosMissionIdentities(db)).toEqual([a, retry]);
});
it('S05-T03 cannot attach a stop request to an unowned or changed execution identity', () => {
  const db = getDb();
  installCosMissionBoundary(a, db);
  expect(() => stopCosMissionAttempt(b, 'database_unavailable', db)).toThrow('mission_stop_identity_denied');
  expect(() => stopCosMissionAttempt({ ...a, agentGroupId: 'ordinary' }, 'database_unavailable', db)).toThrow(
    'mission_stop_identity_denied',
  );
  expect(isCosMissionStopped(a, db)).toBe(false);
});
it('S05-PG03 attempt stop survives replay while a distinct later generation remains separately fenced', () => {
  const db = getDb();
  installCosMissionBoundary(a, db);
  stopCosMissionAttempt(a, 'authority_lost', db);
  installCosMissionBoundary(a, db);
  const next = { ...a, attemptId: 'new-attempt', generation: 2, agentGroupId: 'new-group', sessionId: 'new-session' };
  installCosMissionBoundary(next, db);
  expect(isCosMissionStopped(a, db)).toBe(true);
  expect(isCosMissionStopped(next, db)).toBe(false);
  // Absence of a stop is not authority to launch; normal mission markers still deny generic execution.
});
it('S05-PG03 both stop records survive reopening the native SQLite file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-stop-restart-'));
  const file = path.join(dir, 'native.db');
  let db = new Database(file);
  try {
    installCosMissionBoundary(a, db);
    installCosMissionBoundary(b, db);
    stopCosMissionAttempt(a, 'database_unavailable', db);
    stopCosMissionFamily(b.scopeId, b.missionId, 'owner_cancel', db);
    db.close();
    db = new Database(file);
    expect(stoppedCosMissionIdentities(db)).toEqual([a, b]);
    expect(isCosMissionStopped(a, db)).toBe(true);
    expect(isCosMissionStopped(b, db)).toBe(true);
  } finally {
    if (db.open) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
