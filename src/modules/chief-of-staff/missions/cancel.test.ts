import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { installCosMissionBoundary, type CosMissionIdentity } from '../../../cos-mission-boundary.js';
import { isCosMissionStopped } from '../../../cos-mission-stop.js';
import { createMissionCancellation } from './cancel.js';
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
  const identity: CosMissionIdentity = {
    scopeId: 'scope',
    missionId: 'mission',
    attemptId: 'attempt',
    generation: 1,
    agentGroupId: 'child',
    sessionId: 'session',
    provider: 'codex',
  };
  const sibling = { ...identity, attemptId: 'other', missionId: 'other', agentGroupId: 'other', sessionId: 'other' };
  installCosMissionBoundary(identity, db);
  installCosMissionBoundary(sibling, db);
  const runs = { cancel: vi.fn().mockResolvedValue({ status: 'ok', state: 'cancelling' }) };
  const stop = vi.fn(async () => {
    expect(isCosMissionStopped(identity, db)).toBe(true);
  });
  const cancel = createMissionCancellation({ db, runs, stop });
  return { db, identity, sibling, runs, stop, cancel };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
it('S05-T07 persists the approved owner cancellation fence before stopping only its exact children', async () => {
  const f = fixture();
  expect(await f.cancel(context, 'mission')).toEqual({ status: 'ok', state: 'cancelling' });
  expect(f.runs.cancel).toHaveBeenCalledWith(context, 'mission');
  expect(f.stop).toHaveBeenCalledWith(f.identity);
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(isCosMissionStopped(f.sibling, f.db)).toBe(false);
  // A newly materialized generation cannot escape the family fence.
  expect(isCosMissionStopped({ ...f.identity, generation: 2, attemptId: 'retry' }, f.db)).toBe(true);
});
it('S05-T03 denied/uncertain owner authority cannot select arbitrary native children to stop', async () => {
  const f = fixture();
  for (const status of ['denied', 'pending', 'unavailable']) {
    f.runs.cancel.mockResolvedValue({ status });
    expect((await f.cancel(context, 'mission')).status).toBe(status);
  }
  expect(f.stop).not.toHaveBeenCalled();
  expect(isCosMissionStopped(f.identity, f.db)).toBe(false);
});
it('S05-T07 uncertain physical stop retains the permanent fence and reports pending reconciliation', async () => {
  const f = fixture();
  f.stop.mockRejectedValue(new Error('fixture stop uncertainty'));
  expect(await f.cancel(context, 'mission')).toEqual({ status: 'pending', state: 'cancelling' });
  expect(isCosMissionStopped(f.identity, f.db)).toBe(true);
});
