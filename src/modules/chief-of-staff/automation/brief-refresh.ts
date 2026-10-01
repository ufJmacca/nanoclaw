import type { Context, Result } from '../domain/contracts.js';
import type { BriefRunStore } from './brief-store.js';
import type { CalendarConnector } from '../calendar/connector.js';
import type { CalendarWindow } from '../calendar/normalization.js';

export type BriefRefreshTarget = {
  binding_id: string;
  binding_version: number;
  calendar_id: string;
  snapshot_id: string;
  window: CalendarWindow;
  completed_at?: string;
  state: 'pending' | 'complete' | 'failed' | 'uncertain';
};
export type BriefRefreshPlan = {
  version: 1;
  provider: string;
  generation: number;
  started_at: string;
  deadline_at: string;
  state: 'running' | 'not_requested' | 'complete' | 'failed' | 'timed_out';
  truncated: boolean;
  unavailable: number;
  targets: BriefRefreshTarget[];
};

type Dependencies = {
  runs: Pick<BriefRunStore, 'beginRefresh' | 'recordRefreshTarget' | 'finishRefresh'>;
  connector?: Pick<CalendarConnector, 'refresh'>;
  current(): boolean;
  beforeRefresh?(plan: BriefRefreshPlan, signal: AbortSignal): Promise<Result>;
};

/** One aggregate budget, including database work, for the persisted selected targets. */
export class BriefRefresh {
  constructor(readonly dependencies: Dependencies) {}
  async execute(
    context: Context,
    runId: string,
    generation: number,
    provider: string,
    seconds: number,
  ): Promise<Result> {
    const d = this.dependencies;
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 30 || !d.current()) return { status: 'denied' };
    const controller = new AbortController(),
      started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline = seconds > 0 ? started + seconds * 1000 : Infinity;
    const interrupted = (): Result | undefined => {
      if (performance.now() >= deadline) controller.abort();
      return !d.current() ? { status: 'denied' } : controller.signal.aborted ? { status: 'pending' } : undefined;
    };
    // A zero-second refresh only records not_requested; the database retains its own bound.
    if (seconds > 0) timer = setTimeout(() => controller.abort(), seconds * 1000);
    const watch = setInterval(() => {
      if (!d.current()) controller.abort();
    }, 50);
    try {
      const begun = await d.runs.beginRefresh(context, runId, generation, provider, controller.signal);
      const stopped = interrupted();
      if (stopped) return stopped;
      if (begun.status !== 'ok') return begun;
      const plan = begun.refresh as BriefRefreshPlan;
      if (plan.state !== 'running') return begun;
      deadline = started + Math.min(seconds * 1000, Number(begun.remaining_ms));
      const remaining = deadline - performance.now();
      if (!Number.isFinite(remaining) || remaining <= 0) return { status: 'pending' };
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), remaining);
      const finish = async (forced?: 'failed') => {
        const result = await d.runs.finishRefresh(context, runId, generation, forced, controller.signal);
        return interrupted() ?? result;
      };
      if (!d.connector) return await finish('failed');
      if (d.beforeRefresh) {
        const prepared = await d.beforeRefresh(plan, controller.signal);
        const stopped = interrupted();
        if (stopped) return stopped;
        if (prepared.status !== 'ok') return prepared;
      }
      for (const target of plan.targets) {
        if (target.state !== 'pending') continue;
        const before = interrupted();
        if (before) return before;
        const refreshed = await d.connector.refresh(
          { ...context, provider },
          target.binding_id,
          target.calendar_id,
          target.snapshot_id,
          target.window,
          controller.signal,
        );
        const after = interrupted();
        if (after) return after;
        const outcome =
          refreshed.result.status === 'ok'
            ? 'complete'
            : ['pending', 'unavailable'].includes(refreshed.result.status)
              ? 'uncertain'
              : 'failed';
        const recorded = await d.runs.recordRefreshTarget(
          context,
          runId,
          generation,
          target.snapshot_id,
          outcome,
          controller.signal,
        );
        const stopped = interrupted();
        if (stopped) return stopped;
        if (recorded.status !== 'ok') return recorded;
      }
      return await finish();
    } catch {
      return interrupted() ?? { status: 'unavailable' };
    } finally {
      clearTimeout(timer);
      clearInterval(watch);
    }
  }
}
