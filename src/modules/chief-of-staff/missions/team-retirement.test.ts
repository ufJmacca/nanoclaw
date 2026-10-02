import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createTeamRetirement } from './team-retirement.js';
import { installCosMissionBoundary, type CosMissionIdentity } from '../../../cos-mission-boundary.js';
import { isCosMissionStopped } from '../../../cos-mission-stop.js';
import type { Result } from '../domain/contracts.js';
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const context = { scopeId: 'scope', ownerId: 'owner', agentGroupId: 'main', sessionId: 'main', ingressId: 'host' };
function fixture(state = 'blocked') {
  const db = new Database(':memory:');
  databases.push(db);
  const identity: CosMissionIdentity = {
    scopeId: 'scope',
    missionId: 'mission',
    attemptId: 'attempt',
    generation: 1,
    agentGroupId: 'child',
    sessionId: 'child',
    provider: 'codex',
  };
  installCosMissionBoundary(identity, db);
  let present = true;
  const result: Result = { status: 'ok', state: 'cancelling', identities: [identity] };
  const teams = {
    inspect: vi.fn(async (): Promise<Result> => ({ status: 'ok', team: { state } })),
    retire: vi.fn(async (): Promise<Result> => result),
    confirmRetirement: vi.fn(async (): Promise<Result> => ({ status: 'ok', state: 'blocked' })),
    cancel: vi.fn(async (): Promise<Result> => result),
    confirmCancellation: vi.fn(async (): Promise<Result> => ({ status: 'ok', state: 'cancelled' })),
  };
  const runs = { confirmStopped: vi.fn(async (): Promise<Result> => ({ status: 'ok' })) },
    stop = vi.fn(async () => {
      expect(isCosMissionStopped(identity, db)).toBe(true);
      present = false;
    }),
    retire = createTeamRetirement({ db, teams, runs, stop, running: () => present });
  return { db, identity, teams, runs, stop, retire };
}
it('S06-T04/T06 fences failed-root families before native stops and preserves the terminal failure', async () => {
  const f = fixture();
  expect(await f.retire(context, 'team')).toEqual({ status: 'ok', state: 'blocked' });
  expect(f.teams.retire).toHaveBeenCalledExactlyOnceWith(context, 'team');
  expect(f.teams.cancel).not.toHaveBeenCalled();
  expect(f.runs.confirmStopped).toHaveBeenCalledExactlyOnceWith(f.identity);
  expect(f.db.prepare('SELECT reason FROM cos_mission_stop_families').get()).toEqual({ reason: 'origin_revoked' });
});
it('S06-T06 reconciles an existing owner cancellation without converting it into terminal failure', async () => {
  const f = fixture('cancelling');
  expect(await f.retire(context, 'team')).toEqual({ status: 'ok', state: 'cancelled' });
  expect(f.teams.cancel).toHaveBeenCalledOnce();
  expect(f.teams.retire).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT reason FROM cos_mission_stop_families').get()).toEqual({ reason: 'owner_cancel' });
});
it('S06-T06 malformed or unavailable owner metadata never selects a native family', async () => {
  const f = fixture();
  for (const result of [
    { status: 'denied' },
    { status: 'pending' },
    { status: 'unavailable' },
    { status: 'ok' },
  ] as Result[]) {
    f.teams.inspect.mockResolvedValue(result);
    expect((await f.retire(context, 'team')).status).toBe(result.status === 'ok' ? 'denied' : result.status);
  }
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.teams.retire).not.toHaveBeenCalled();
  expect(isCosMissionStopped(f.identity, f.db)).toBe(false);
});
