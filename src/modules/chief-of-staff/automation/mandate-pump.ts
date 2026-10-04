import type { CosBinding } from '../../../cos-boundary.js';
import { digest, type Context, type Result } from '../domain/contracts.js';
import type { MandateHead, MandateStore } from './mandate-store.js';
import type { NativeMandateTasks } from './mandate-native.js';
export type MandatePumpDependencies = {
  store: Pick<MandateStore, 'headsForHost' | 'bindNative' | 'evaluate'>;
  current(binding: CosBinding): boolean;
  admitted(binding: CosBinding): Promise<boolean>;
  withTasks<T>(binding: CosBinding, operation: (tasks: NativeMandateTasks) => T): T;
};
/** Uses the existing CoS service tick, selected source events and native task clocks. Adds no timer or model scheduler. */
export class MandatePump {
  private readonly active = new Set<string>();
  private readonly cursors = new Map<string, string>();
  constructor(readonly dependencies: MandatePumpDependencies) {}
  async drain(binding: CosBinding): Promise<Result> {
    if (this.active.has(binding.scopeId)) return { status: 'pending' };
    const d = this.dependencies;
    this.active.add(binding.scopeId);
    try {
      if (!d.current(binding) || !(await d.admitted(binding)) || !d.current(binding)) return { status: 'denied' };
      const context: Context = {
        scopeId: binding.scopeId,
        ownerId: binding.ownerId,
        sessionId: binding.sessionId,
        agentGroupId: binding.agentGroupId,
        ingressId: 'host-mandate-wake',
      };
      const inventory = await d.store.headsForHost(context, this.cursors.get(binding.scopeId) ?? '');
      if (inventory.status !== 'ok') return inventory;
      if (!d.current(binding)) return { status: 'denied' };
      if (!Array.isArray(inventory.heads)) return { status: 'unavailable' };
      this.cursors.set(binding.scopeId, typeof inventory.next_after === 'string' ? inventory.next_after : '');
      for (const head of inventory.heads as MandateHead[]) {
        if (!d.current(binding)) return { status: 'denied' };
        if (head.state !== 'active' || !head.eligible || !head.wake) {
          d.withTasks(binding, (tasks) => tasks.retireAll(binding, head.id));
          continue;
        }
        const wake = head.wake;
        const staged = d.withTasks(binding, (tasks) => {
          tasks.retireAll(binding, head.id, wake);
          const id = tasks.stage(binding, wake);
          return id
            ? {
                id,
                changed: tasks.lastSourceDigest(binding, wake) !== head.sourceDigest,
                due: tasks.due(binding, wake, head.now),
              }
            : null;
        });
        if (!staged) continue;
        const bound = await d.store.bindNative(context, wake, staged.id, digest({ binding, wake }));
        if (bound.status !== 'ok' || !d.current(binding)) continue;
        if (!staged.changed && !staged.due) continue;
        if (!(await d.admitted(binding)) || !d.current(binding)) return { status: 'denied' };
        const evaluated = await d.store.evaluate(context, head.id);
        if (!d.current(binding)) return { status: 'denied' };
        if (evaluated.status !== 'ok') continue;
        d.withTasks(binding, (tasks) => tasks.recordEvaluation(binding, wake, head.sourceDigest));
        if (staged.due) {
          d.withTasks(binding, (tasks) => tasks.retire(binding, wake));
          if (
            typeof evaluated.next_wake_at === 'string' &&
            Number.isFinite(Date.parse(evaluated.next_wake_at)) &&
            Date.parse(evaluated.next_wake_at) > Date.parse(head.now)
          ) {
            const next = { ...wake, wakeAt: new Date(evaluated.next_wake_at).toISOString() };
            const id = d.withTasks(binding, (tasks) => tasks.stage(binding, next));
            if (id && d.current(binding)) await d.store.bindNative(context, next, id, digest({ binding, wake: next }));
          }
        }
      }
      return { status: 'ok' };
      // eslint-disable-next-line no-catch-all/no-catch-all -- Host clock failures close admission; private transport/database errors must not reach model output.
    } catch {
      return { status: 'unavailable' };
    } finally {
      this.active.delete(binding.scopeId);
    }
  }
}
