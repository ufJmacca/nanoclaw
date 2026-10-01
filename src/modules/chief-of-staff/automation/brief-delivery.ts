import { randomUUID } from 'node:crypto';
import { digest, type Result } from '../domain/contracts.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import type { BriefArtifacts } from './brief-artifacts.js';
import type { BriefArtifactReference, BriefDeliveryOutcome, BriefRunStore } from './brief-store.js';

type Dependencies = {
  runs: Pick<BriefRunStore, 'beginDelivery' | 'deliveryCurrent' | 'finishDelivery'>;
  artifacts: Pick<BriefArtifacts, 'get'>;
  /** Synchronous native-context fence, including owner preemption and pause. */
  current(context: KnowledgeContext): KnowledgeContext | null;
  /** Fresh private-channel ownership and subscription validation. */
  admitted(context: KnowledgeContext): Promise<boolean>;
  /** The host binds the destination; callers cannot supply a channel or arbitrary text. */
  send(context: KnowledgeContext, text: string, notificationId: string): Promise<string | undefined>;
};

export class BriefDelivery {
  constructor(readonly dependencies: Dependencies) {}
  async deliver(context: KnowledgeContext): Promise<Result> {
    const captured = structuredClone(context),
      origin = captured.origin,
      d = this.dependencies;
    if (!origin) return { status: 'denied' };
    const attempt = randomUUID();
    const reserved = await d.runs.beginDelivery(captured, origin.runId, origin.generation, attempt);
    if (reserved.status !== 'ok') return reserved;
    const finish = (outcome: BriefDeliveryOutcome) =>
      d.runs.finishDelivery(captured, origin.runId, origin.generation, attempt, outcome);
    let text: string;
    try {
      const ref = reserved.reference as BriefArtifactReference;
      if (!ref || ref.context_generation !== captured.generation || ref.provider !== captured.provider)
        return await finish({ state: 'failed', reason: 'admission_denied' });
      if (
        (await d.runs.deliveryCurrent(captured, origin.runId, origin.generation, attempt)).status !== 'ok' ||
        !(await d.admitted(captured))
      )
        return await finish({ state: 'failed', reason: 'admission_denied' });
      // Source permissions may change while channel facts are fetched. Read the protected
      // bytes only after those awaits, then apply the synchronous native-context fence.
      const artifact = await d.artifacts.get(captured, ref.artifact_id, true);
      if (
        artifact.status !== 'ok' ||
        artifact.artifact_id !== ref.artifact_id ||
        typeof artifact.text !== 'string' ||
        digest(artifact.text) !== ref.output_digest ||
        digest(d.current(captured)) !== digest(captured)
      )
        return await finish({ state: 'failed', reason: 'admission_denied' });
      text = artifact.text;
    } catch {
      // No transport was invoked. If persistence is also unavailable, the durable delivering fence remains.
      return finish({ state: 'failed', reason: 'admission_denied' });
    }
    let outcome: BriefDeliveryOutcome;
    try {
      const receipt = await d.send(captured, text, String(reserved.notification_id));
      outcome =
        typeof receipt === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(receipt)
          ? { state: 'delivered', platform_receipt: receipt }
          : { state: 'uncertain' };
    } catch {
      // A transport exception does not establish whether the platform accepted the post.
      outcome = { state: 'uncertain' };
    }
    return finish(outcome);
  }
}
