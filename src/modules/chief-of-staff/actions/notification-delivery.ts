import type { CosBinding } from '../../../cos-boundary.js';
import { digest, type Result } from '../domain/contracts.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import { validActionId } from '../contracts/action-protocol.js';
import { actionNotificationId, validActionNotification } from './notification-protocol.js';
import type { EffectWitness } from './witness.js';
import type { ActionNotifications } from './notifications.js';

type Dependencies = {
  notices: Pick<ActionNotifications, 'read' | 'pending'>;
  witness: Pick<EffectWitness, 'consumeNotification'>;
  current(binding: CosBinding): KnowledgeContext | null;
  admitted(binding: CosBinding): Promise<boolean>;
  project(context: KnowledgeContext, text: string, id: string): void;
  send(context: KnowledgeContext, text: string, id: string): Promise<string | undefined>;
};
/** A consumed or uncertain send is never retried automatically, including after remote-state restore. */
export class ActionNotificationDelivery {
  private readonly cursors = new Map<string, string | null>();
  private readonly draining = new Set<string>();
  private closed = false;
  constructor(readonly dependencies: Dependencies) {}
  close(): void {
    this.closed = true;
    this.cursors.clear();
  }
  async deliver(binding: CosBinding, context: KnowledgeContext, id: string): Promise<Result> {
    const d = this.dependencies,
      captured = structuredClone(context);
    const local = () => !this.closed && digest(d.current(binding)) === digest(captured);
    try {
      if (!local() || !(await d.admitted(binding)) || !local()) return { status: 'denied' };
      const read = await d.notices.read(captured, id),
        notice = read.notice;
      if (read.status !== 'ok') return read;
      if (
        !local() ||
        !validActionNotification(notice) ||
        typeof read.text !== 'string' ||
        digest(read.text) !== notice.textDigest ||
        notice.scopeId !== captured.scopeId ||
        notice.ownerId !== captured.ownerId ||
        notice.sessionId !== captured.sessionId ||
        notice.agentGroupId !== captured.agentGroupId ||
        notice.instanceId !== binding.instanceId ||
        notice.channelId !== binding.channelId ||
        notice.actionId !== id ||
        !(await d.admitted(binding)) ||
        !local()
      )
        return { status: 'denied' };
      const notificationId = actionNotificationId(notice);
      // A confirmed fsync is required before projecting/sending. An unknown reservation never permits transport.
      if (!d.witness.consumeNotification(notice)) return { status: 'pending', reason: 'notification_consumed' };
      if (!local()) return { status: 'denied' };
      d.project(captured, read.text, notificationId);
      if (!local() || !(await d.admitted(binding)) || !local()) return { status: 'denied' };
      const receipt = await d.send(captured, read.text, notificationId);
      return typeof receipt === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(receipt)
        ? { status: 'ok', state: 'delivered', notification_id: notificationId, platform_receipt: receipt }
        : { status: 'pending', state: 'uncertain', notification_id: notificationId };
      // eslint-disable-next-line no-catch-all/no-catch-all -- Private diagnostics never cross the result boundary; an unknown send remains consumed.
    } catch {
      return { status: 'pending', state: 'uncertain' };
    }
  }
  async drain(binding: CosBinding): Promise<void> {
    const key = digest(binding),
      d = this.dependencies;
    if (this.closed || this.draining.has(key)) return;
    this.draining.add(key);
    try {
      const context = d.current(binding);
      if (
        !context ||
        context.origin ||
        !(await d.admitted(binding)) ||
        digest(d.current(binding)) !== digest(context) ||
        this.closed
      )
        return;
      const cursor = this.cursors.get(key) ?? null,
        page = await d.notices.pending(context, cursor);
      if (
        page.status !== 'ok' ||
        !Array.isArray(page.action_ids) ||
        page.action_ids.length > 20 ||
        this.closed ||
        digest(d.current(binding)) !== digest(context)
      )
        return;
      const ids = page.action_ids as unknown[],
        after = page.next_after;
      if (
        ids.some((id) => !validActionId(id)) ||
        new Set(ids).size !== ids.length ||
        ids.some(
          (id, index) =>
            typeof id !== 'string' || (index > 0 && String(ids[index - 1]) >= id) || (cursor !== null && cursor >= id),
        ) ||
        (after !== null && (!validActionId(after) || after !== ids.at(-1)))
      )
        return;
      this.cursors.set(key, after as string | null);
      for (const id of ids) {
        if (this.closed || digest(d.current(binding)) !== digest(context)) return;
        await this.deliver(binding, context, String(id));
      }
      // eslint-disable-next-line no-catch-all/no-catch-all -- The host retries discovery only, never a consumed result send.
    } catch {
      return;
    } finally {
      this.draining.delete(key);
    }
  }
}
