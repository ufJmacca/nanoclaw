import { interruptScheduledOrigin } from '../automation/scheduled-origin.js';
import { interruptReviewOrigin } from '../missions/review-origin.js';
import { automationContext } from '../automation/origin.js';
import type Database from 'better-sqlite3';
import type { Session } from '../../../types.js';
import type { InboundEvent } from '../../../channels/adapter.js';
import type { CosBinding } from '../../../cos-boundary.js';
import { cosBoundary } from '../../../cos-boundary.js';
import type { ChannelFacts } from './identity.js';
import {
  parseControl,
  parseStatusControl,
  verifyIngress,
  validPrivateChannel,
  type VerifiedIngress,
} from './identity.js';
import type { StatusInput } from '../contracts/operations-protocol.js';
import { digest, type Context, type Result } from '../domain/contracts.js';
import { HostOwnerControls, parseOwnerControl, type DenialHandlers } from '../ops/owner-controls.js';
import { hasTable } from '../../../db/connection.js';
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
  verifyScheduled?(context: Context): Promise<boolean>;
  verifyReview?(context: Context): Promise<boolean>;
  inspect?(context: Context, input: StatusInput): Promise<Result>;
  replyStatus?(
    binding: CosBinding,
    ingressId: string,
    result: Result,
    current: () => Promise<boolean>,
  ): Promise<boolean>;
  replyControl?: ControllerDependencies['replyStatus'];
};
export class CosController {
  private readonly ownerControls: HostOwnerControls;
  constructor(readonly dependencies: ControllerDependencies) {
    this.ownerControls = new HostOwnerControls(dependencies);
  }
  reconcileControls(
    binding: CosBinding,
    cancel: (context: Context, id: string) => Promise<Result>,
    handlers?: DenialHandlers,
  ): Promise<void> {
    return this.ownerControls.reconcile(binding, cancel, handlers);
  }
  private async reply(
    binding: CosBinding,
    ingress: VerifiedIngress,
    result: Result,
    deliver: ControllerDependencies['replyStatus'],
  ): Promise<void> {
    const d = this.dependencies;
    d.db.exec(`CREATE TABLE IF NOT EXISTS cos_operator_requests(
      scope_id TEXT NOT NULL,ingress_id TEXT NOT NULL,payload_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('claimed','delivered','withheld','delivery_uncertain')),
      PRIMARY KEY(scope_id,ingress_id))`);
    const payload = digest(ingress);
    if (
      d.db
        .prepare(
          "INSERT OR IGNORE INTO cos_operator_requests(scope_id,ingress_id,payload_digest,state) VALUES(?,?,?,'claimed')",
        )
        .run(binding.scopeId, ingress.id, payload).changes !== 1
    )
      return;
    const current = async () => {
      if (!validPrivateChannel(binding, await d.facts(binding))) return false;
      const session = d.session(binding.sessionId);
      if (!session) return false;
      const fresh = cosBoundary(session, d.db);
      return fresh.restricted && !!fresh.binding && digest(fresh.binding) === digest(binding);
    };
    let state = 'withheld';
    try {
      if ((await current()) && deliver)
        state = (await deliver(binding, ingress.id, result, current)) ? 'delivered' : 'withheld';
      // eslint-disable-next-line no-catch-all/no-catch-all -- An ambiguous send is permanently recorded without private diagnostics or an automatic retry.
    } catch {
      state = 'delivery_uncertain';
    }
    d.db
      .prepare('UPDATE cos_operator_requests SET state=? WHERE scope_id=? AND ingress_id=? AND payload_digest=?')
      .run(state, binding.scopeId, ingress.id, payload);
  }
  async ingress(binding: CosBinding, event: InboundEvent): Promise<boolean> {
    const d = this.dependencies,
      now = d.now?.() ?? Date.now();
    const verified = verifyIngress(binding, await d.facts(binding), event, now);
    if (!verified) return true;
    const session = d.session(binding.sessionId);
    if (!session) return true;
    const boundary = cosBoundary(session, d.db);
    if (!boundary.restricted || !boundary.binding || digest(boundary.binding) !== digest(binding)) return true;
    const payloadDigest = digest(verified);
    const previous = d.db
      .prepare('SELECT payload_digest FROM cos_ingress_receipts WHERE scope_id=? AND ingress_id=?')
      .get(binding.scopeId, verified.id) as { payload_digest: string | null } | undefined;
    if (previous && previous.payload_digest !== payloadDigest) return true;
    if (
      hasTable(d.db, 'cos_operator_requests') &&
      d.db
        .prepare('SELECT 1 FROM cos_operator_requests WHERE scope_id=? AND ingress_id=?')
        .get(binding.scopeId, verified.id)
    )
      return true;
    const inspection = parseStatusControl(verified.text);
    if (inspection) {
      let result: Result = { status: 'unavailable' };
      try {
        result =
          (await d.inspect?.(
            {
              scopeId: binding.scopeId,
              ownerId: binding.ownerId,
              sessionId: binding.sessionId,
              agentGroupId: binding.agentGroupId,
              ingressId: verified.id,
            },
            inspection,
          )) ?? result;
        // eslint-disable-next-line no-catch-all/no-catch-all -- Offline diagnostics must not disclose database/transport details.
      } catch {
        result = { status: 'unavailable' };
      }
      await this.reply(binding, verified, result, d.replyStatus);
      return true;
    }
    const denial = parseOwnerControl(verified.text);
    if (denial) {
      const result = this.ownerControls.record(binding, verified, denial);
      await this.reply(binding, verified, result, d.replyControl);
      return true;
    }
    const control = parseControl(verified.text);
    if (!d.enabled() || boundary.paused) return true;
    if (control && control.kind !== 'pause') {
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
    if (/\bcos\s+(approve|reject|pause|status|stop|cancel|revoke|disable|inspect)\b/i.test(verified.text)) return true;
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
    // A new owner message preempts automation. Keep its local fence until the
    // trusted scheduler durably reconciles the old run, including uncertain sends.
    const scheduledInterrupted = interruptScheduledOrigin(d.db, binding),
      reviewInterrupted = interruptReviewOrigin(d.db, binding);
    if (scheduledInterrupted || reviewInterrupted) d.stop(binding.sessionId);
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
  /** Synchronous fence for pause, current ingress, binding and module admission. */
  localContext(session: Session): Context | null {
    const d = this.dependencies;
    if (!d.enabled()) return null;
    const boundary = cosBoundary(session, d.db);
    if (!boundary.restricted || !boundary.binding || boundary.paused) return null;
    const now = d.now?.() ?? Date.now();
    const automatic = automationContext(session, d.db, now);
    if (automatic !== undefined) return automatic;
    if (!boundary.ingressId || !boundary.ingressAt) return null;
    const at = Date.parse(boundary.ingressAt);
    if (!Number.isFinite(at) || at < now - 300_000 || at > now + 30_000) return null;
    const binding = boundary.binding;
    return {
      scopeId: binding.scopeId,
      ownerId: binding.ownerId,
      sessionId: session.id,
      agentGroupId: binding.agentGroupId,
      ingressId: boundary.ingressId,
    };
  }
  async context(session: Session): Promise<Context | null> {
    const context = this.localContext(session);
    if (!context) return null;
    const boundary = cosBoundary(session, this.dependencies.db);
    if (
      !boundary.restricted ||
      !boundary.binding ||
      !validPrivateChannel(boundary.binding, await this.dependencies.facts(boundary.binding))
    )
      return null;
    if (context.origin) {
      try {
        if (
          !(await (context.origin.kind === 'mission_review'
            ? this.dependencies.verifyReview?.(context)
            : this.dependencies.verifyScheduled?.(context)))
        )
          return null;
      } catch {
        return null;
      }
    }
    // A pause, disabled module or newer ingress may arrive during the remote check.
    const current = this.localContext(session);
    return current && digest(current) === digest(context) ? current : null;
  }
}
