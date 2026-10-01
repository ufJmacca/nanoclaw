import type Database from 'better-sqlite3';
import type { CosBinding } from '../../../cos-boundary.js';
import type { Context, Result } from '../domain/contracts.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import type { BriefRunStore } from './brief-store.js';
import type { NativeBriefRun } from './native-tasks.js';
import { clearScheduledOrigin, readScheduledLease, type ScheduledLease } from './scheduled-origin.js';

type Run = NativeBriefRun & { generation: number; lease_owner: string; state: string };
type Dependencies = {
  db: Database.Database;
  runs: Pick<BriefRunStore, 'inspect' | 'authorize' | 'cancel' | 'finishDelivery'>;
  local(binding: CosBinding): KnowledgeContext | null;
  admitted(binding: CosBinding): Promise<boolean>;
  deliver(context: KnowledgeContext): Promise<Result>;
  retire(binding: CosBinding, run: NativeBriefRun): boolean;
  taskState(binding: CosBinding, run: NativeBriefRun): string | null;
  stop(sessionId: string): void;
  running(sessionId: string): boolean;
};
const terminal = new Set(['delivered', 'uncertain', 'failed', 'cancelled']);

/** One host pump owns reconciliation. Pending database outcomes retain the native execution fence. */
export class BriefReconciliation {
  private readonly active = new Set<string>();
  constructor(readonly dependencies: Dependencies) {}
  private retire(binding: CosBinding, lease: ScheduledLease, run: Run): Result {
    const d = this.dependencies;
    d.stop(binding.sessionId);
    if (!d.retire(binding, run) || d.running(binding.sessionId)) return { status: 'pending' };
    return clearScheduledOrigin(d.db, binding, lease) ? { status: 'ok', state: run.state } : { status: 'denied' };
  }
  async drain(binding: CosBinding): Promise<Result> {
    if (this.active.has(binding.scopeId)) return { status: 'pending' };
    this.active.add(binding.scopeId);
    const d = this.dependencies;
    try {
      const lease = readScheduledLease(d.db, binding);
      if (!lease) return { status: 'ok', state: 'absent' };
      const context: Context = {
        scopeId: binding.scopeId,
        ownerId: binding.ownerId,
        sessionId: binding.sessionId,
        agentGroupId: binding.agentGroupId,
        ingressId: `brief:${lease.runId}:${lease.generation}`,
        origin: { kind: 'schedule', runId: lease.runId, generation: lease.generation },
      };
      const inspected = await d.runs.inspect(context, lease.runId);
      if (inspected.status !== 'ok') {
        d.stop(binding.sessionId);
        return { status: inspected.status };
      }
      const run = inspected.run as Run;
      if (!run || run.id !== lease.runId || run.generation !== lease.generation || run.lease_owner !== lease.hostId) {
        d.stop(binding.sessionId);
        return { status: 'denied' };
      }
      if (terminal.has(run.state)) return this.retire(binding, lease, run);
      const notification = inspected.notification as { state: string; attempt_id: string | null } | undefined;
      if (notification?.state === 'delivering') {
        // No send from this pump can be active here: drain is serialized for the entire transport call.
        d.stop(binding.sessionId);
        if (!notification.attempt_id) return { status: 'denied' };
        const settled = await d.runs.finishDelivery(context, lease.runId, lease.generation, notification.attempt_id, {
          state: 'uncertain',
        });
        return settled.status === 'ok' ? this.retire(binding, lease, { ...run, state: 'uncertain' }) : settled;
      }
      const cancel = async () => {
        d.stop(binding.sessionId);
        const settled = await d.runs.cancel(context, lease.runId, lease.generation);
        return settled.status === 'ok' && terminal.has(String(settled.state))
          ? this.retire(binding, lease, { ...run, state: String(settled.state) })
          : settled;
      };
      if (!d.local(binding) || !(await d.admitted(binding))) return await cancel();
      const authority = await d.runs.authorize(context, lease.runId, lease.generation);
      if (authority.status === 'denied') return await cancel();
      if (authority.status !== 'ok') {
        d.stop(binding.sessionId);
        return authority;
      }
      const current = d.local(binding);
      if (!current || current.origin?.runId !== lease.runId || current.origin.generation !== lease.generation)
        return await cancel();
      if (run.state === 'prepared' && notification?.state === 'queued') return await d.deliver(current);
      if (run.state === 'dispatched' && ['completed', 'failed', 'cancelled'].includes(d.taskState(binding, run) ?? ''))
        return await cancel();
      return { status: 'ok', state: run.state };
    } catch {
      d.stop(binding.sessionId);
      return { status: 'unavailable' };
    } finally {
      this.active.delete(binding.scopeId);
    }
  }
}
