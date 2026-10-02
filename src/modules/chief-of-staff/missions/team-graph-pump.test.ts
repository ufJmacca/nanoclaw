import { expect, it, vi } from 'vitest';
import { TeamGraphPump } from './team-graph-pump.js';
import type { Context, Result } from '../domain/contracts.js';
const context = {
  scopeId: 'scope',
  ownerId: 'owner',
  agentGroupId: 'main',
  sessionId: 'main',
  ingressId: 'host-dispatch',
};
function fixture() {
  const events: string[] = [],
    teamId = 'team-' + 'a'.repeat(64);
  const teams = {
    pendingGraphs: vi.fn(
      async (_context: Context, _after: string | null): Promise<Result> => ({
        status: 'ok',
        items: [teamId],
        next_after: null,
      }),
    ),
    advance: vi.fn(async (_context: Context, _teamId: string): Promise<Result> => {
      events.push('advance');
      return { status: 'ok', state: 'running' };
    }),
    claimReady: vi.fn(async (_context: Context, _teamId: string): Promise<Result> => {
      events.push('claim');
      return { status: 'ok', state: 'running' };
    }),
    requestRework: vi.fn(async (_context: Context, _teamId: string, _submissionId: string): Promise<Result> => {
      events.push('rework');
      return { status: 'ok', revised_steps: ['writer'] };
    }),
  };
  const local = vi.fn(() => true),
    pump = new TeamGraphPump({ teams: teams as never, local });
  return { events, teamId, teams, local, pump };
}
it('S06-T02/T07 advances committed result events before bounded ready intents without owning a model or native dispatcher', async () => {
  const t = fixture();
  await t.pump.drain(context);
  expect(t.events).toEqual(['advance', 'claim']);
  expect(t.teams.pendingGraphs).toHaveBeenCalledWith(context, null);
  expect(t.teams.advance).toHaveBeenCalledWith(context, t.teamId);
  expect(t.teams.claimReady).toHaveBeenCalledWith(context, t.teamId);
});
it('S06-T03/T08 applies only existing approved rework before ready discovery and never waits for a reviewer model', async () => {
  const t = fixture();
  t.teams.advance.mockResolvedValue({
    status: 'ok',
    state: 'awaiting_review',
    review_submission_id: 'submission',
  } as never);
  await t.pump.drain(context);
  expect(t.events).toEqual(['rework', 'claim']);
  expect(t.teams.requestRework).toHaveBeenCalledWith(context, t.teamId, 'submission');
  t.events.length = 0;
  t.teams.requestRework.mockResolvedValue({ status: 'denied' } as never);
  await t.pump.drain(context);
  expect(t.teams.claimReady).toHaveBeenCalledTimes(1);
});
it('S06-T02/PG02 bounds each page and preserves a fair cursor across calls', async () => {
  const t = fixture(),
    ids = ['a', 'b', 'c', 'd'].map((n) => 'team-' + n.repeat(64));
  t.teams.pendingGraphs.mockResolvedValueOnce({ status: 'ok', items: ids, next_after: ids[3] });
  await t.pump.drain(context);
  expect(t.teams.claimReady.mock.calls.map((call) => call[1])).toEqual(ids);
  await t.pump.drain(context);
  expect(t.teams.pendingGraphs).toHaveBeenLastCalledWith(context, ids[3]);
  t.teams.pendingGraphs.mockResolvedValueOnce({ status: 'ok', items: [...ids, t.teamId], next_after: null });
  await expect(t.pump.drain(context)).rejects.toThrow('team_discovery_invalid');
});
it('S06-T05 admission loss between transitions cannot create another ready intent', async () => {
  const t = fixture();
  t.teams.advance.mockImplementation(async () => {
    t.local.mockReturnValue(false);
    return { status: 'ok', state: 'running' };
  });
  await t.pump.drain(context);
  expect(t.teams.claimReady).not.toHaveBeenCalled();
  t.local.mockReturnValue(true);
  t.teams.advance.mockResolvedValue({ status: 'denied' } as never);
  await t.pump.drain(context);
  expect(t.teams.claimReady).not.toHaveBeenCalled();
});
it('S06-PG01 retains its cursor on uncertain transitions and rejects malformed discovery without dispatch', async () => {
  const t = fixture();
  t.teams.advance.mockResolvedValueOnce({ status: 'pending' } as never);
  await expect(t.pump.drain(context)).rejects.toThrow('team_transition_unavailable');
  await t.pump.drain(context);
  expect(t.teams.pendingGraphs).toHaveBeenLastCalledWith(context, null);
  for (const items of [[t.teamId, t.teamId], ['foreign'], [{ team_id: t.teamId }]]) {
    t.teams.pendingGraphs.mockResolvedValueOnce({ status: 'ok', items, next_after: null } as never);
    await expect(t.pump.drain(context)).rejects.toThrow('team_discovery_invalid');
  }
  expect(t.teams.claimReady).toHaveBeenCalledTimes(1);
});
it('S06-T04/T06 performs metadata-only retirement while model admission is paused, without advancing or claiming', async () => {
  const t = fixture(),
    retire = vi.fn(async () => ({ status: 'ok', state: 'blocked' }) as Result);
  t.local.mockReturnValue(false);
  const pump = new TeamGraphPump({ teams: t.teams, local: t.local, open: () => true, retire });
  await pump.drain(context);
  expect(retire).toHaveBeenCalledExactlyOnceWith(context, t.teamId);
  expect(t.teams.advance).not.toHaveBeenCalled();
  expect(t.teams.claimReady).not.toHaveBeenCalled();
});
it('S06-T04/T06 retires a newly blocked graph in the same sweep and retains uncertain native stops', async () => {
  const t = fixture(),
    retire = vi.fn(async (): Promise<Result> => ({ status: 'denied' }));
  t.teams.advance.mockResolvedValue({ status: 'ok', state: 'blocked' });
  retire.mockResolvedValueOnce({ status: 'denied' }).mockResolvedValueOnce({ status: 'pending', state: 'cancelling' });
  const pump = new TeamGraphPump({ teams: t.teams, local: t.local, open: () => true, retire });
  await pump.drain(context);
  expect(retire).toHaveBeenCalledTimes(2);
  expect(t.teams.claimReady).not.toHaveBeenCalled();
  retire.mockResolvedValue({ status: 'pending' });
  await expect(pump.drain(context)).rejects.toThrow('team_retirement_unavailable');
});
it('S06-T01/T05 fresh private-origin denial permits cleanup but cannot advance or create a ready intent', async () => {
  const t = fixture(),
    retire = vi.fn(async (): Promise<Result> => ({ status: 'denied' })),
    admit = vi.fn(async () => false);
  const pump = new TeamGraphPump({ teams: t.teams, local: t.local, open: () => true, retire, admit });
  await pump.drain(context);
  expect(retire).toHaveBeenCalledOnce();
  expect(admit).toHaveBeenCalledExactlyOnceWith(context);
  expect(t.teams.advance).not.toHaveBeenCalled();
  expect(t.teams.claimReady).not.toHaveBeenCalled();
});
