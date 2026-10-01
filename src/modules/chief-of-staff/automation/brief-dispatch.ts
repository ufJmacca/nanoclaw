import type Database from 'better-sqlite3';
import { cosBoundary, type CosBinding } from '../../../cos-boundary.js';
import type { Session } from '../../../types.js';
import { digest, type Context, type Result } from '../domain/contracts.js';
import type { BriefRunStore } from './brief-store.js';
import type { NativeBriefRun, NativeBriefTasks } from './native-tasks.js';
import { installScheduledOrigin, readScheduledLease, scheduledContext } from './scheduled-origin.js';

export type DispatchBriefRun = NativeBriefRun & {
  state: string;
  generation: number;
  limits: { refresh_seconds: number };
  deadline_at: string;
};
type Dependencies = {
  db: Database.Database;
  runs: Pick<BriefRunStore, 'reserveDue' | 'claim' | 'authorize' | 'cancel'>;
  session(id: string): Session | undefined;
  admitted(binding: CosBinding): Promise<boolean>;
  running(sessionId: string): boolean;
  withTasks<T>(session: Session, operation: (tasks: NativeBriefTasks) => Promise<T>): Promise<T>;
  /** Complete bounded refresh/admission before installing a scheduled model origin. */
  prepare(binding: CosBinding, context: Context, run: DispatchBriefRun): Promise<Result>;
  wake(session: Session): Promise<void>;
};

export class BriefDispatch {
  private readonly active = new Set<string>();
  constructor(readonly dependencies: Dependencies) {}
  async drain(binding: CosBinding): Promise<Result> {
    if (this.active.has(binding.scopeId)) return { status: 'pending' };
    this.active.add(binding.scopeId);
    const d = this.dependencies;
    try {
      const session = d.session(binding.sessionId);
      if (!session) return { status: 'denied' };
      const captured = cosBoundary(session, d.db),
        original = scheduledContext(session, d.db);
      if (
        !captured.restricted ||
        !captured.binding ||
        captured.paused ||
        digest(captured.binding) !== digest(binding) ||
        original === null ||
        d.running(session.id)
      )
        return { status: 'denied' };
      const unchanged = () => digest(cosBoundary(session, d.db)) === digest(captured) && !d.running(session.id);
      if (!(await d.admitted(binding)) || !unchanged()) return { status: 'denied' };
      return await d.withTasks(session, async (tasks) => {
        const existing = readScheduledLease(d.db, binding);
        const idle = (runId?: string) =>
          !tasks.db
            .prepare(
              "SELECT 1 FROM messages_in WHERE status='pending' AND kind IN ('chat','task') AND (process_after IS NULL OR datetime(process_after)<=datetime('now')) AND id<>? LIMIT 1",
            )
            .get(runId ? `cos-brief-${runId}` : '');
        if (!unchanged() || !idle(existing?.runId)) return { status: 'denied' };
        const context: Context = {
          scopeId: binding.scopeId,
          sessionId: binding.sessionId,
          ownerId: binding.ownerId,
          agentGroupId: binding.agentGroupId,
          ingressId: 'host-brief-reservation',
        };
        const reserved = await d.runs.reserveDue(context);
        if (reserved.status !== 'ok') return reserved;
        if (!reserved.run) return { status: 'ok', state: 'not_due' };
        const run = reserved.run as DispatchBriefRun;
        if (!['queued', 'dispatched'].includes(run.state) || (existing && existing.runId !== run.id))
          return { status: 'denied' };
        const host = 'cos-native-' + digest(binding);
        const claimed = await d.runs.claim(context, run.id, host);
        if (claimed.status !== 'ok') return claimed;
        const lease = {
          runId: run.id,
          generation: Number(claimed.generation),
          hostId: host,
          deadlineAt: String(claimed.deadline_at),
        };
        const cancel = async (): Promise<Result> => {
          const settled = await d.runs.cancel(context, run.id, lease.generation);
          // Even if the cancellation acknowledgement is lost, the staged task must remain non-runnable.
          tasks.pause(binding, run);
          if (settled.status === 'ok') tasks.retire(binding, run);
          return settled.status === 'ok' ? { status: 'denied' } : settled;
        };
        if (!unchanged() || !idle(run.id)) return await cancel();
        if (!existing) {
          const prepared = await d.prepare(binding, context, {
            ...run,
            generation: lease.generation,
            deadline_at: lease.deadlineAt,
          });
          if (!unchanged() || !idle(run.id)) return await cancel();
          if (['pending', 'unavailable'].includes(prepared.status)) return prepared;
          if (prepared.status !== 'ok') return await cancel();
        }
        if (!(await d.admitted(binding)) || !unchanged() || !idle(run.id)) return await cancel();
        if (!tasks.stage(binding, run) || !installScheduledOrigin(d.db, binding, session, lease)) return await cancel();
        const current = () => {
          const origin = scheduledContext(session, d.db);
          return (
            unchanged() &&
            idle(run.id) &&
            !!origin &&
            origin.origin?.runId === run.id &&
            origin.origin.generation === lease.generation
          );
        };
        if (
          !(await tasks.activate(
            binding,
            run,
            async () => {
              const authority = await d.runs.authorize(context, run.id, lease.generation);
              return authority.status === 'ok' && (await d.admitted(binding));
            },
            current,
          ))
        )
          return await cancel();
        // No await separates the final native fence from wake admission.
        if (!current()) return await cancel();
        await d.wake(session);
        return { status: 'ok', state: 'dispatched', run_id: run.id };
      });
    } catch {
      return { status: 'unavailable' };
    } finally {
      this.active.delete(binding.scopeId);
    }
  }
}
