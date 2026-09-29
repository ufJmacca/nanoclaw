import type Database from 'better-sqlite3';
import type { Session } from '../../../types.js';
import type { InboundEvent } from '../../../channels/adapter.js';
import type { CosBinding } from '../../../cos-boundary.js';
import { cosBoundary } from '../../../cos-boundary.js';
import type { ChannelFacts } from './identity.js';
import { parseControl, verifyIngress, validPrivateChannel } from './identity.js';
import { digest, type Context, type Result } from '../domain/contracts.js';
export type ControllerDependencies = {
  db: Database.Database;
  enabled(): boolean;
  facts(binding: CosBinding): Promise<ChannelFacts>;
  session(id: string): Session | undefined;
  decide(context: Context, proposal: string, token: string, decision: 'approve' | 'reject'): Promise<Result>;
  acknowledge(proposal: string): void;
  stop(sessionId: string): void;
  /** Synchronous idempotent write into the fresh native inbound SQLite. */
  project(session: Session, event: InboundEvent): void;
  wake(session: Session): Promise<void>;
  now?(): number;
};
export class CosController {
  constructor(readonly dependencies: ControllerDependencies) {}
  async ingress(binding: CosBinding, event: InboundEvent): Promise<boolean> {
    const d = this.dependencies,
      now = d.now?.() ?? Date.now();
    const verified = verifyIngress(binding, await d.facts(binding), event, now);
    if (!verified) return true;
    const session = d.session(binding.sessionId);
    if (!session) return true;
    const boundary = cosBoundary(session, d.db);
    if (!boundary.restricted || !boundary.binding || boundary.binding.scopeId !== binding.scopeId) return true;
    const control = parseControl(verified.text);
    if (control?.kind === 'pause') {
      d.db.prepare('UPDATE cos_identity_boundaries SET paused=1 WHERE scope_id=?').run(binding.scopeId);
      d.stop(binding.sessionId);
      return true;
    }
    if (!d.enabled() || boundary.paused) return true;
    if (control) {
      const result = await d.decide(
        {
          scopeId: binding.scopeId,
          ownerId: binding.ownerId,
          sessionId: binding.sessionId,
          agentGroupId: binding.agentGroupId,
          ingressId: verified.id,
        },
        control.proposalId,
        control.token,
        control.kind,
      );
      // A replay after a lost local acknowledgement reaches the same durable decision.
      if (result.status === 'ok') d.acknowledge(control.proposalId);
      return true;
    }
    // Keep malformed/quoted controls out of model history; they never become commands.
    if (/\bcos\s+(approve|reject|pause)\b/i.test(verified.text)) return true;
    const payloadDigest = digest(verified);
    const pending = d.db.transaction(() => {
      d.db
        .prepare(
          `INSERT OR IGNORE INTO cos_ingress_receipts
        (scope_id,ingress_id,received_at,payload_digest,projected) VALUES(?,?,?,?,0)`,
        )
        .run(binding.scopeId, verified.id, verified.timestamp, payloadDigest);
      return d.db
        .prepare(
          `SELECT payload_digest,projected FROM cos_ingress_receipts
        WHERE scope_id=? AND ingress_id=?`,
        )
        .get(binding.scopeId, verified.id) as {
        payload_digest: string | null;
        projected: number;
      };
    })();
    if (pending.payload_digest !== payloadDigest || pending.projected !== 0) return true;
    // The receipt stays pending if writing native SQLite fails. Exact retries finish the
    // projection even after a crash between the two databases; native insertion is idempotent.
    // No attachments, reply redirection or generic command routing cross this boundary.
    d.project(session, {
      channelType: 'mattermost',
      platformId: `mattermost:${binding.instanceId}:${binding.channelId}`,
      threadId: null,
      message: {
        id: verified.id,
        kind: 'chat',
        timestamp: verified.timestamp,
        content: JSON.stringify({ senderId: `mattermost:${binding.ownerId}`, text: verified.text }),
      },
    });
    d.db.transaction(() => {
      d.db
        .prepare('UPDATE cos_ingress_receipts SET projected=1 WHERE scope_id=? AND ingress_id=?')
        .run(binding.scopeId, verified.id);
      d.db
        .prepare('UPDATE cos_identity_boundaries SET ingress_id=?,ingress_at=? WHERE scope_id=? AND paused=0')
        .run(verified.id, verified.timestamp, binding.scopeId);
    })();
    // A wake failure leaves the durable trigger for the ordinary host sweep to retry.
    await d.wake(session);
    return true;
  }
  async context(session: Session): Promise<Context | null> {
    const d = this.dependencies;
    if (!d.enabled()) return null;
    const boundary = cosBoundary(session, d.db);
    if (!boundary.restricted || !boundary.binding || boundary.paused || !boundary.ingressId || !boundary.ingressAt)
      return null;
    const now = d.now?.() ?? Date.now(),
      at = Date.parse(boundary.ingressAt);
    if (!Number.isFinite(at) || at < now - 300_000 || at > now + 30_000) return null;
    const binding = boundary.binding;
    if (!validPrivateChannel(binding, await d.facts(binding))) return null;
    // A pause may have arrived while the remote membership check was in flight.
    const current = cosBoundary(session, d.db);
    if (!current.restricted || current.paused || !current.binding || current.ingressId !== boundary.ingressId)
      return null;
    return {
      scopeId: binding.scopeId,
      ownerId: binding.ownerId,
      sessionId: session.id,
      agentGroupId: binding.agentGroupId,
      ingressId: boundary.ingressId,
    };
  }
}
