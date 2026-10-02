import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CoordinatorReviewRuns } from './coordinator-review-runs.js';
import type { KnowledgeContext } from '../knowledge/store.js';

const context: KnowledgeContext = {
  scopeId: 'scope',
  ownerId: 'owner',
  agentGroupId: 'main',
  sessionId: 'retained-main',
  ingressId: 'host-review',
  provider: 'codex',
  generation: randomUUID(),
};
function backend() {
  return {
    pending: vi.fn(async () => ({
      status: 'ok' as const,
      items: [] as Array<{ mission_id: string; submission_id: string }>,
    })),
    claim: vi.fn(async () => ({ status: 'ok' as const })),
    inspect: vi.fn(async () => ({ status: 'ok' as const })),
    authorize: vi.fn(async () => ({ status: 'ok' as const })),
    renew: vi.fn(async () => ({ status: 'ok' as const })),
    reserve: vi.fn(async () => ({ status: 'ok' as const, reserved: false })),
    retire: vi.fn(async () => ({ status: 'ok' as const })),
  };
}
it('S06-T05/T10 routes every review lifecycle operation by retained root identity without a permissive fallback', async () => {
  const singles = backend(),
    teams = backend(),
    runs = new CoordinatorReviewRuns(singles, teams),
    sub = randomUUID(),
    lease = { owner: 'host', fence: 1 };
  const operations = {
    claim: [context, 'ID', sub, 'host'],
    inspect: [context, 'ID', sub],
    authorize: [context, 'ID', sub, lease, true],
    renew: [context, 'ID', sub, lease],
    reserve: [context, 'ID', sub, lease, 'call', 'model'],
    retire: [context, 'ID', sub, lease],
  };
  for (const [method, args] of Object.entries(operations)) {
    for (const team of [false, true]) {
      const missionId = (team ? 'team-' : 'mission-') + 'a'.repeat(64),
        actual = args.map((v) => (v === 'ID' ? missionId : v));
      const result = await Reflect.apply(runs[method as keyof typeof operations], runs, actual);
      expect(result.status).toBe('ok');
      expect((team ? teams : singles)[method as keyof typeof operations]).toHaveBeenLastCalledWith(...actual);
    }
    expect(singles[method as keyof typeof operations]).toHaveBeenCalledTimes(1);
    expect(teams[method as keyof typeof operations]).toHaveBeenCalledTimes(1);
  }
  teams.claim.mockResolvedValueOnce({ status: 'denied' } as never);
  expect((await runs.claim(context, 'team-' + 'b'.repeat(64), sub, 'host')).status).toBe('denied');
  expect(singles.claim).toHaveBeenCalledTimes(1);
});
it('S06-T02/T10 fairly combines bounded single and team wakes in the same main context', async () => {
  const singles = backend(),
    teams = backend(),
    runs = new CoordinatorReviewRuns(singles, teams);
  const singleItem = { mission_id: 'mission-' + 'a'.repeat(64), submission_id: randomUUID() },
    teamItem = { mission_id: 'team-' + 'b'.repeat(64), submission_id: randomUUID() };
  singles.pending.mockResolvedValue({ status: 'ok', items: [singleItem] });
  teams.pending.mockResolvedValue({ status: 'ok', items: [teamItem] });
  const first = await runs.pending(context),
    second = await runs.pending(context);
  expect(first.items).toEqual([singleItem, teamItem]);
  expect(second.items).toEqual([teamItem, singleItem]);
  expect(singles.pending).toHaveBeenCalledWith(context);
  expect(teams.pending).toHaveBeenCalledWith(context);
  teams.pending.mockResolvedValueOnce({ status: 'unavailable' } as never);
  expect((await runs.pending(context)).status).toBe('unavailable');
});
