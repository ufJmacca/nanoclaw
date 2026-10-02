import { randomUUID } from 'node:crypto';
import { digest, type Result } from '../domain/contracts.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import type { MissionNotifications, MissionDeliveryReceipt } from './notifications.js';

type Dependencies = {
  notifications: Pick<MissionNotifications, 'begin' | 'read' | 'finish'>;
  admitted(context: KnowledgeContext): Promise<boolean>;
  current(context: KnowledgeContext): KnowledgeContext | null;
  /** Destination is bound by the host, never by the specialist or result text. */
  send(context: KnowledgeContext, text: string, notificationId: string): Promise<string | undefined>;
};
export class MissionNotificationDelivery {
  constructor(readonly dependencies: Dependencies) {}
  async deliver(context: KnowledgeContext, reviewId: string): Promise<Result> {
    const captured = structuredClone(context),
      d = this.dependencies,
      attempt = randomUUID();
    const reserved = await d.notifications.begin(captured, reviewId, attempt);
    if (reserved.status !== 'ok') return reserved;
    const finish = (receipt: MissionDeliveryReceipt) => d.notifications.finish(captured, reviewId, attempt, receipt);
    let text: string;
    try {
      if (!(await d.admitted(captured))) return await finish({ state: 'failed', reason: 'admission_denied' });
      const result = await d.notifications.read(captured, reviewId, attempt);
      if (result.status !== 'ok' || typeof result.text !== 'string' || digest(d.current(captured)) !== digest(captured))
        return await finish({ state: 'failed', reason: 'admission_denied' });
      text = result.text;
    } catch {
      // Transport has not been invoked; persistence uncertainty retains the original consumed grant.
      return finish({ state: 'failed', reason: 'admission_denied' });
    }
    let receipt: MissionDeliveryReceipt;
    try {
      const platformReceipt = await d.send(captured, text, String(reserved.notification_id));
      receipt =
        typeof platformReceipt === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(platformReceipt)
          ? { state: 'delivered', platform_receipt: platformReceipt }
          : { state: 'uncertain' };
    } catch {
      receipt = { state: 'uncertain' };
    }
    return finish(receipt);
  }
}
