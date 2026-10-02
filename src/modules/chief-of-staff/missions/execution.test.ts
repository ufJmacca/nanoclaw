import { afterEach, expect, it, vi } from 'vitest';
import { initTestDb, closeDb } from '../../../db/connection.js';
import { installCosMissionBoundary, type CosMissionIdentity } from '../../../cos-mission-boundary.js';
import { createMissionExecution } from './execution.js';

afterEach(closeDb);
function fixture() {
  const db = initTestDb();
  const identity: CosMissionIdentity = {
    scopeId: 'scope',
    missionId: 'mission',
    attemptId: 'attempt',
    generation: 1,
    agentGroupId: 'child',
    sessionId: 'session',
    provider: 'codex',
  };
  installCosMissionBoundary(identity, db);
  const options = {
    db,
    assertHostAuthority: vi.fn(),
    session: vi.fn((_id: string): { agent_group_id: string } | undefined => undefined),
    directory: vi.fn((group: string, session: string) => `/sessions/${group}/${session}/cos-v1`),
    running: vi.fn((_id: string) => false),
    stop: vi.fn((_id: string) => {}),
    probe: { present: vi.fn((_path: string) => false), stop: vi.fn((_path: string) => {}) },
  };
  return { db, identity, options, execution: createMissionExecution(options) };
}
it('S05 probes and stops the permanently reserved child workspace even before a native session exists', async () => {
  const f = fixture();
  expect(f.execution.running(f.identity)).toBe(false);
  expect(f.options.probe.present).toHaveBeenCalledWith('/sessions/child/session/cos-v1');
  await f.execution.stop(f.identity);
  expect(f.options.stop).toHaveBeenCalledWith('session');
  expect(f.options.probe.stop).toHaveBeenCalledWith('/sessions/child/session/cos-v1');
});
it.each(['unreserved', 'corrupt', 'foreign-session', 'host-lease'])(
  'S05 uncertain %s identity never targets another workspace',
  async (cause) => {
    const f = fixture();
    if (cause === 'unreserved') f.identity.generation++;
    if (cause === 'corrupt') f.db.exec("UPDATE cos_mission_boundaries SET identity='{}'");
    if (cause === 'foreign-session') f.options.session.mockReturnValue({ agent_group_id: 'ordinary' });
    if (cause === 'host-lease')
      f.options.assertHostAuthority.mockImplementation(() => {
        throw Error('lost');
      });
    expect(f.execution.running(f.identity)).toBe(true);
    await expect(f.execution.stop(f.identity)).rejects.toThrow();
    expect(f.options.directory).not.toHaveBeenCalled();
    expect(f.options.stop).not.toHaveBeenCalled();
    expect(f.options.probe.stop).not.toHaveBeenCalled();
  },
);
it('S05 a queued native wake counts as present and uncertain Docker stop propagates for retry', async () => {
  const f = fixture();
  f.options.running.mockReturnValue(true);
  expect(f.execution.running(f.identity)).toBe(true);
  f.options.probe.stop.mockImplementation(() => {
    throw Error('uncertain');
  });
  await expect(f.execution.stop(f.identity)).rejects.toThrow('uncertain');
  expect(f.options.stop).toHaveBeenCalledWith('session');
});
it('S06-T06 local absence of allocation permits only a separate database proof; unknown execution stays uncertain', () => {
  const f = fixture();
  f.db.exec('DELETE FROM cos_mission_boundaries');
  expect(f.execution.running(f.identity)).toBe(true);
  expect(f.execution.unallocated(f.identity)).toBe(true);
  expect(f.options.probe.present).not.toHaveBeenCalled();
  f.options.running.mockReturnValue(true);
  expect(f.execution.unallocated(f.identity)).toBe(false);
  f.options.running.mockReturnValue(false);
  f.options.session.mockReturnValue({ agent_group_id: f.identity.agentGroupId });
  expect(f.execution.unallocated(f.identity)).toBe(false);
  f.options.session.mockReturnValue(undefined);
  installCosMissionBoundary(f.identity, f.db);
  f.db.exec("UPDATE cos_mission_boundaries SET identity='{}'");
  expect(f.execution.unallocated(f.identity)).toBe(false);
});
it('S06-T06 retained allocation intent or lost host authority denies never-allocated confirmation', () => {
  const f = fixture();
  f.db.exec('DELETE FROM cos_mission_boundaries');
  f.db.exec('CREATE TABLE cos_mission_allocations(attempt_id TEXT, identity TEXT)');
  f.db.prepare('INSERT INTO cos_mission_allocations VALUES(?,?)').run(f.identity.attemptId, JSON.stringify(f.identity));
  expect(f.execution.unallocated(f.identity)).toBe(false);
  f.db.exec('DELETE FROM cos_mission_allocations');
  f.options.assertHostAuthority.mockImplementation(() => {
    throw Error('lost');
  });
  expect(f.execution.unallocated(f.identity)).toBe(false);
});
