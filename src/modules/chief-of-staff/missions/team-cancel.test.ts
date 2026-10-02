import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { installCosMissionBoundary, type CosMissionIdentity } from '../../../cos-mission-boundary.js';
import { isCosMissionStopped } from '../../../cos-mission-stop.js';
import { createTeamCancellation } from './team-cancel.js';
const databases: Database.Database[] = [];
const context = {
  scopeId: 'scope',
  ownerId: 'owner',
  agentGroupId: 'main',
  sessionId: 'main',
  ingressId: 'owner-message',
};
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  const identity = (id: string): CosMissionIdentity => ({
    scopeId: 'scope',
    missionId: 'mission-' + id,
    attemptId: id,
    generation: 1,
    agentGroupId: 'child-' + id,
    sessionId: 'session-' + id,
    provider: 'codex',
  });
  const children = [identity('one'), identity('two')],
    sibling = identity('sibling');
  for (const i of [...children, sibling]) installCosMissionBoundary(i, db);
  const active = new Set(children.map((i) => i.attemptId));
  const teams = {
    cancel: vi.fn().mockResolvedValue({ status: 'ok', state: 'cancelling', identities: children }),
    confirmCancellation: vi.fn().mockResolvedValue({ status: 'ok', state: 'cancelled' }),
  };
  const runs = { confirmStopped: vi.fn().mockResolvedValue({ status: 'ok' }) };
  const running = (i: CosMissionIdentity) => active.has(i.attemptId);
  const stop = vi.fn(async (i: CosMissionIdentity) => {
    for (const child of children) expect(isCosMissionStopped(child, db)).toBe(true);
    expect(isCosMissionStopped(sibling, db)).toBe(false);
    active.delete(i.attemptId);
  });
  const cancel = createTeamCancellation({ db, teams, runs, running, stop });
  return { db, children, sibling, active, teams, runs, running, stop, cancel };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
it('S06-T06 fences every family before the first native stop and confirms only independently absent exact children', async () => {
  const f = fixture();
  expect(await f.cancel(context, 'team')).toEqual({ status: 'ok', state: 'cancelled' });
  expect(f.stop).toHaveBeenCalledTimes(2);
  expect(f.runs.confirmStopped.mock.calls.map((c) => c[0])).toEqual(f.children);
  expect(f.teams.confirmCancellation).toHaveBeenCalledWith(context, 'team');
  expect(isCosMissionStopped({ ...f.children[0], attemptId: 'late-retry', generation: 2 }, f.db)).toBe(true);
});
it('S06-T06 keeps credits and local fences closed when a native worker remains present, then reconciles on replay', async () => {
  const f = fixture();
  f.stop.mockImplementation(async () => {
    throw Error('fixture stop uncertainty');
  });
  expect(await f.cancel(context, 'team')).toEqual({ status: 'pending', state: 'cancelling' });
  expect(f.runs.confirmStopped).not.toHaveBeenCalled();
  expect(f.teams.confirmCancellation).not.toHaveBeenCalled();
  expect(f.children.every((i) => isCosMissionStopped(i, f.db))).toBe(true);
  f.active.clear();
  expect(await f.cancel(context, 'team')).toEqual({ status: 'ok', state: 'cancelled' });
  expect(f.runs.confirmStopped).toHaveBeenCalledTimes(2);
});
it('S06-T06 unavailable or denied owner control cannot select a native family', async () => {
  const f = fixture();
  for (const status of ['denied', 'pending', 'unavailable']) {
    f.teams.cancel.mockResolvedValue({ status });
    expect((await f.cancel(context, 'team')).status).toBe(status);
  }
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.runs.confirmStopped).not.toHaveBeenCalled();
  expect(isCosMissionStopped(f.children[0], f.db)).toBe(false);
});
