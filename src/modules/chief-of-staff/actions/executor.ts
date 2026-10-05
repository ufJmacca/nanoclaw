import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { digest, type Context, type Result } from '../domain/contracts.js';
import type { ActionStore } from './store.js';
import type { ActionLease } from './run-store.js';
import type { ActionWriterBinding } from './binding.js';
import { writerAccessMatches } from './binding.js';
import { CalendarWriteError, type CalendarActionWriter } from './writer.js';

export type ActionNativeAdmission = {
  admitted(): Promise<boolean>;
  local(): boolean;
  signal?: AbortSignal;
};
/** Trusted host only. No model, UI callback or worker gets this executor, a token or a database client. */
export class ActionExecutor {
  private readonly running = new Set<string>();
  constructor(readonly store: ActionStore) {}
  async run(context: Context, actionId: string, native: ActionNativeAdmission): Promise<Result> {
    const dependencies = this.store.dependencies,
      witness = dependencies?.witness;
    if (!dependencies || !witness) return { status: 'unavailable', reason: 'writer_not_configured' };
    const key = digest({ scopeId: context.scopeId, actionId });
    if (this.running.has(key)) return { status: 'pending', reason: 'action_running' };
    this.running.add(key);
    try {
      return await this.execute(context, actionId, native);
    } finally {
      this.running.delete(key);
    }
  }
  private async execute(context: Context, actionId: string, native: ActionNativeAdmission): Promise<Result> {
    const dependencies = this.store.dependencies!,
      witness = dependencies.witness!;
    try {
      const authority = dependencies.authority(context);
      const locallyAdmitted = () =>
        native.local() &&
        !native.signal?.aborted &&
        digest(dependencies.authority(context) ?? null) === digest(authority);
      if (!authority || context.origin || !locallyAdmitted()) return { status: 'denied' };
      if (!(await native.admitted()) || !locallyAdmitted()) return { status: 'denied' };
      // Begin the monotonic cap before requesting the PostgreSQL lease; wall-clock rollback cannot extend it.
      const leaseStart = performance.now(),
        claim = await this.store.runs.claim(context, actionId, randomUUID());
      if (claim.status !== 'ok' || claim.finished) return claim;
      const lease = structuredClone(claim.lease as ActionLease);
      const bindingRead = await this.store.transaction(async (client) => {
        const binding = await this.store.binding(client, context, lease.intent.request.binding_id);
        return binding ? { status: 'ok', body: binding.body } : { status: 'denied' };
      });
      if (bindingRead.status !== 'ok') return bindingRead;
      const binding = bindingRead.body as ActionWriterBinding;
      let writer: CalendarActionWriter | null;
      try {
        writer = dependencies.writer(context, lease.intent.request.binding_id, binding);
        // eslint-disable-next-line no-catch-all/no-catch-all -- Vault diagnostics must not escape the host.
      } catch (_error) {
        return this.store.runs.settle(context, lease, 'blocked', 'writer_unavailable');
      }
      if (!writer) return this.store.runs.settle(context, lease, 'blocked', 'writer_unavailable');
      const leaseCurrent = () =>
        locallyAdmitted() && performance.now() - leaseStart < 120000 && Date.now() < Date.parse(lease.expiresAt);
      if (lease.mode === 'create') {
        if (
          !leaseCurrent() ||
          Date.now() >= Date.parse(lease.intent.expiresAt) ||
          !(await native.admitted()) ||
          !leaseCurrent()
        )
          return this.store.runs.settle(context, lease, 'blocked', 'action_admission_closed');
        try {
          if (!writerAccessMatches(binding, await writer.access()))
            return this.store.runs.settle(context, lease, 'blocked', 'writer_access_changed');
          const inspection = await writer.inspect(lease.intent.request);
          if (!(await native.admitted()) || !leaseCurrent())
            return this.store.runs.settle(context, lease, 'blocked', 'action_admission_closed');
          const start = await this.store.runs.start(context, lease, inspection);
          // An unavailable or pending COMMIT never becomes permission to contact the provider.
          if (start.status === 'pending' || start.status === 'unavailable') return start;
          if (start.status !== 'ok')
            return this.store.runs.settle(context, lease, 'blocked', 'action_observations_changed');
          witness.begin({
            format: 'cos-action-start-witness/v1',
            intent: lease.intent,
            approvedDigest: lease.approvedDigest,
            proposalId: lease.proposalId,
            decisionIngressId: lease.decisionIngressId,
            leaseOwner: lease.owner,
            fence: lease.fence,
            recordedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
          });
          const valid = () =>
            leaseCurrent() &&
            Date.now() < Date.parse(lease.intent.expiresAt) &&
            !witness.cancelled(actionId) &&
            witness.find(actionId)?.approvedDigest === lease.approvedDigest;
          if (!valid()) return this.store.runs.settle(context, lease, 'blocked', 'action_admission_closed');
          // start() has returned its client before either network operation. Insert responses are never verification.
          try {
            await writer.create(lease.intent, lease.approvedDigest, { valid, inspection });
            // eslint-disable-next-line no-catch-all/no-catch-all -- An unknown send outcome requires readback without exposing diagnostics.
          } catch (error) {
            if (error instanceof CalendarWriteError && error.outcome === 'not_sent')
              return this.store.runs.settle(context, lease, 'blocked', 'writer_did_not_send');
            // A thrown request may already have created the event. Preserve its original ID and read it back.
          }
          // eslint-disable-next-line no-catch-all/no-catch-all -- Inspection and filesystem diagnostics stay private to the host.
        } catch (error) {
          if (error instanceof CalendarWriteError)
            return this.store.runs.settle(context, lease, 'blocked', 'writer_inspection_unavailable');
          // No request was made when inspection or witness setup failed. Do not expose vault/filesystem diagnostics.
          return this.store.runs.settle(context, lease, 'blocked', 'action_preflight_unavailable');
        }
      }
      if (!(await native.admitted()) || !leaseCurrent())
        return this.store.runs.settle(context, lease, 'uncertain', 'action_readback_not_admitted');
      try {
        const event = await writer.get(lease.intent, lease.approvedDigest);
        if (!leaseCurrent()) return { status: 'pending', reason: 'action_lease_lost' };
        return this.store.runs.complete(context, lease, event);
        // eslint-disable-next-line no-catch-all/no-catch-all -- Read failures retain uncertainty without exposing provider/account data.
      } catch (_error) {
        return this.store.runs.settle(context, lease, 'uncertain', 'writer_readback_unavailable');
      }
      // eslint-disable-next-line no-catch-all/no-catch-all -- Native/private diagnostics never cross a model boundary.
    } catch (_error) {
      return { status: 'unavailable', reason: 'action_authority_unavailable' };
    }
  }
}
