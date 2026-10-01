import { afterEach, expect, it, vi } from 'vitest';
import { BriefRefresh, type BriefRefreshPlan } from './brief-refresh.js';
import type { BriefRunStore } from './brief-store.js';
import type { CalendarConnector } from '../calendar/connector.js';

afterEach(() => vi.useRealTimers());
function fixture() {
  const context = {
    scopeId: 'scope',
    ownerId: 'owner',
    sessionId: 'session',
    agentGroupId: 'group',
    ingressId: 'host',
  };
  const plan: BriefRefreshPlan = {
    version: 1,
    provider: 'codex',
    generation: 1,
    started_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 20000).toISOString(),
    state: 'running',
    truncated: false,
    unavailable: 0,
    targets: ['first', 'second'].map((id) => ({
      binding_id: 'binding',
      binding_version: 1,
      calendar_id: id,
      snapshot_id: id + '-snapshot',
      window: { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-10T00:00:00Z', timeZone: 'UTC' },
      state: 'pending',
    })),
  };
  const runs = {
    beginRefresh: vi.fn<BriefRunStore['beginRefresh']>(async () => ({
      status: 'ok',
      refresh: structuredClone(plan),
      remaining_ms: 20000,
    })),
    recordRefreshTarget: vi.fn<BriefRunStore['recordRefreshTarget']>(async () => ({ status: 'ok' })),
    finishRefresh: vi.fn<BriefRunStore['finishRefresh']>(async () => ({
      status: 'ok',
      refresh: { ...plan, state: 'complete' },
    })),
  };
  const connector = { refresh: vi.fn<CalendarConnector['refresh']>(async () => ({ result: { status: 'ok' } })) };
  const current = vi.fn(() => true);
  return { context, plan, runs, connector, current, refresh: new BriefRefresh({ runs, connector, current }) };
}
it('S04 refresh uses only the persisted selected targets, stable snapshot IDs and original windows', async () => {
  const f = fixture();
  expect((await f.refresh.execute(f.context, 'run', 1, 'codex', 20)).status).toBe('ok');
  expect(f.connector.refresh).toHaveBeenCalledTimes(2);
  for (const [index, target] of f.plan.targets.entries())
    expect(f.connector.refresh.mock.calls[index]).toEqual([
      { ...f.context, provider: 'codex' },
      target.binding_id,
      target.calendar_id,
      target.snapshot_id,
      target.window,
      expect.any(AbortSignal),
    ]);
  expect(f.runs.recordRefreshTarget.mock.calls.map((call) => call[4])).toEqual(['complete', 'complete']);
});
it('S04 uses remaining persisted time instead of renewing the budget after restart', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.runs.beginRefresh.mockResolvedValue({ status: 'ok', refresh: f.plan, remaining_ms: 100 });
  let entered!: () => void;
  const fetching = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.connector.refresh.mockImplementation(
    async (_c, _b, _id, _s, _w, signal) =>
      new Promise((resolve) => {
        entered();
        signal!.addEventListener(
          'abort',
          () => resolve({ result: { status: 'unavailable', code: 'calendar_refresh_timed_out' } }),
          { once: true },
        );
      }),
  );
  const work = f.refresh.execute(f.context, 'run', 1, 'codex', 20);
  await fetching;
  await vi.advanceTimersByTimeAsync(101);
  expect((await work).status).toBe('pending');
  expect(f.connector.refresh).toHaveBeenCalledOnce();
  expect(f.runs.recordRefreshTarget).not.toHaveBeenCalled();
  f.runs.beginRefresh.mockResolvedValue({ status: 'ok', refresh: { ...f.plan, state: 'timed_out' }, remaining_ms: 0 });
  expect((await f.refresh.execute(f.context, 'run', 1, 'codex', 20)).status).toBe('ok');
  expect(f.connector.refresh).toHaveBeenCalledOnce();
});
it('S04 uncertain plan acknowledgement permits no connector work', async () => {
  const f = fixture();
  f.runs.beginRefresh.mockResolvedValue({ status: 'pending' });
  expect((await f.refresh.execute(f.context, 'run', 1, 'codex', 20)).status).toBe('pending');
  expect(f.connector.refresh).not.toHaveBeenCalled();
});
it('S04 owner preemption aborts active refresh and prevents another target', async () => {
  vi.useFakeTimers();
  const f = fixture();
  let entered!: () => void;
  const fetching = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.connector.refresh.mockImplementation(
    async (_c, _b, _id, _s, _w, signal) =>
      new Promise((resolve) => {
        entered();
        signal!.addEventListener('abort', () => resolve({ result: { status: 'unavailable' } }), { once: true });
      }),
  );
  const work = f.refresh.execute(f.context, 'run', 1, 'codex', 20);
  await fetching;
  f.current.mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(51);
  expect((await work).status).toBe('denied');
  expect(f.connector.refresh).toHaveBeenCalledOnce();
});
it('S04 uncertain snapshot publication is recorded without claiming successful refresh', async () => {
  const f = fixture();
  f.connector.refresh.mockResolvedValue({ result: { status: 'pending' } });
  await f.refresh.execute(f.context, 'run', 1, 'codex', 20);
  expect(f.runs.recordRefreshTarget.mock.calls.map((call) => call[4])).toEqual(['uncertain', 'uncertain']);
});

it('S04 does no connector work when refresh is disabled or already terminal', async () => {
  const f = fixture();
  f.runs.beginRefresh.mockResolvedValue({
    status: 'ok',
    refresh: { ...f.plan, state: 'not_requested', targets: [] },
    remaining_ms: 0,
  });
  expect((await f.refresh.execute(f.context, 'run', 1, 'codex', 0)).status).toBe('ok');
  expect(f.connector.refresh).not.toHaveBeenCalled();
  expect(f.runs.finishRefresh).not.toHaveBeenCalled();
});
it('S04 a missing connector records failure without attempting account setup', async () => {
  const f = fixture();
  await new BriefRefresh({ runs: f.runs, current: f.current }).execute(f.context, 'run', 1, 'codex', 20);
  expect(f.runs.finishRefresh).toHaveBeenCalledWith(f.context, 'run', 1, 'failed', expect.any(AbortSignal));
  expect(f.connector.refresh).not.toHaveBeenCalled();
});
it('S04 does not repeat already recorded target attempts after a host restart', async () => {
  const f = fixture();
  f.plan.targets[0].state = 'uncertain';
  f.plan.targets[1].state = 'complete';
  expect((await f.refresh.execute(f.context, 'run', 1, 'codex', 20)).status).toBe('ok');
  expect(f.connector.refresh).not.toHaveBeenCalled();
});
it('S04 pending target acknowledgement stops before attempting the next calendar', async () => {
  const f = fixture();
  f.runs.recordRefreshTarget.mockResolvedValue({ status: 'pending' });
  expect((await f.refresh.execute(f.context, 'run', 1, 'codex', 20)).status).toBe('pending');
  expect(f.connector.refresh).toHaveBeenCalledOnce();
  expect(f.runs.finishRefresh).not.toHaveBeenCalled();
});
it('S04 the aggregate timer also cancels target bookkeeping', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.runs.beginRefresh.mockResolvedValue({ status: 'ok', refresh: f.plan, remaining_ms: 100 });
  let entered!: () => void;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.runs.recordRefreshTarget.mockImplementation(
    async (_c, _r, _g, _s, _o, signal) =>
      new Promise((resolve) => {
        entered();
        signal!.addEventListener('abort', () => resolve({ status: 'pending' }), { once: true });
      }),
  );
  const work = f.refresh.execute(f.context, 'run', 1, 'codex', 20);
  await writing;
  await vi.advanceTimersByTimeAsync(101);
  expect((await work).status).toBe('pending');
  expect(f.connector.refresh).toHaveBeenCalledOnce();
  expect(f.runs.finishRefresh).not.toHaveBeenCalled();
});
it('S04 owner preemption during final bookkeeping never admits generation', async () => {
  const f = fixture();
  f.runs.finishRefresh.mockImplementation(async () => {
    f.current.mockReturnValue(false);
    return { status: 'ok' };
  });
  expect((await f.refresh.execute(f.context, 'run', 1, 'codex', 20)).status).toBe('denied');
});
