import type { CosBinding } from '../../../cos-boundary.js';
import { digest, type Result } from '../domain/contracts.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import { validActionId } from '../contracts/action-protocol.js';
import type { ActionNativeAdmission } from './executor.js';

type Dependencies = {
  current(binding: CosBinding): KnowledgeContext | null;
  admitted(binding: CosBinding): Promise<boolean>;
  recover(context: KnowledgeContext, offset: number): Promise<Result>;
  pending(context: KnowledgeContext, after: string | null): Promise<Result>;
  execute(context: KnowledgeContext, id: string, admission: ActionNativeAdmission): Promise<Result>;
};
/** Existing host pump only. It neither invokes a model nor extends owner turn authority. */
export class ActionPump {
  private readonly draining = new Set<string>();
  private readonly cursors = new Map<string, { after: string | null; witness: number }>();
  private readonly shutdown = new AbortController();
  constructor(readonly dependencies: Dependencies) {}
  close(): void {
    this.shutdown.abort();
    this.cursors.clear();
  }
  async drain(binding: CosBinding): Promise<void> {
    const key = digest(binding),
      d = this.dependencies;
    if (this.shutdown.signal.aborted || this.draining.has(key)) return;
    this.draining.add(key);
    try {
      const context = d.current(binding);
      if (!context || context.origin) return;
      const local = () => !this.shutdown.signal.aborted && digest(d.current(binding)) === digest(context);
      const admitted = async () => local() && (await d.admitted(binding)) && local();
      if (!(await admitted())) return;
      const cursor = this.cursors.get(key) ?? { after: null, witness: 0 };
      // Read at most one independent journal page and one queue page per tick.
      const recovery = await d.recover(context, cursor.witness);
      if (!local() || recovery.status !== 'ok') return;
      const next = recovery.next_offset;
      if (next !== null && (!Number.isSafeInteger(next) || Number(next) <= cursor.witness || Number(next) > 100000))
        return;
      cursor.witness = next === null ? 0 : Number(next);
      const pending = await d.pending(context, cursor.after);
      if (!local() || pending.status !== 'ok' || !Array.isArray(pending.action_ids) || pending.action_ids.length > 20)
        return;
      const ids = pending.action_ids as unknown[],
        after = pending.next_after;
      if (
        ids.some((id) => !validActionId(id)) ||
        new Set(ids).size !== ids.length ||
        ids.some(
          (id, index) =>
            typeof id !== 'string' ||
            (index > 0 && String(ids[index - 1]) >= id) ||
            (cursor.after !== null && cursor.after >= id),
        ) ||
        (after !== null && (!validActionId(after) || after !== ids.at(-1)))
      )
        return;
      cursor.after = after as string | null;
      this.cursors.set(key, cursor);
      for (const id of ids) {
        if (!(await admitted())) return;
        await d.execute(context, String(id), { local, admitted, signal: this.shutdown.signal });
        if (!local()) return;
      }
      // eslint-disable-next-line no-catch-all/no-catch-all -- Provider, database and target journal diagnostics remain host-only; the next tick may reconcile.
    } catch {
      return;
    } finally {
      this.draining.delete(key);
    }
  }
}
