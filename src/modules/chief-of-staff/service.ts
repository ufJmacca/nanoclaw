import type { PriorityStore } from './store/priorities.js';
import { createCosRuntime, type RuntimeDependencies } from './runtime.js';
import { DatabasePreflightError, preflightFailure } from './store/preflight.js';
import { DatabaseConfigurationError } from './store/config.js';
import { cosBoundary, type CosBinding } from '../../cos-boundary.js';
import { interruptReviewOrigin } from './missions/review-origin.js';
import { interruptScheduledOrigin } from './automation/scheduled-origin.js';
import { cosMissionIdentities, missionBoundary } from '../../cos-mission-boundary.js';
import { stopCosMissionAttempt } from '../../cos-mission-stop.js';
import { databaseReadiness } from './ops/database-readiness.js';
import { digest } from './domain/contracts.js';
export type SpecialistLifecycle = {
  /** Stop/reconcile retained allocations only; this phase never dispatches a new worker. */
  recover?(): Promise<void>;
  pump(binding: CosBinding): Promise<void>;
  fenceLocal(): void;
  close(): Promise<void>;
};
export type ServiceDependencies = Omit<RuntimeDependencies, 'store'> & {
  connect(): Promise<PriorityStore>;
  specialists?(store: PriorityStore, executionReady: () => boolean): SpecialistLifecycle;
};
export class CosService {
  runtime: ReturnType<typeof createCosRuntime>;
  status = 'disabled';
  private store: PriorityStore | undefined;
  private inFlight: Promise<void> | undefined;
  private stopInFlight: Promise<void> | undefined;
  private retiringStore: PriorityStore | undefined;
  private stopped = false;
  private closed = false;
  private specialists?: SpecialistLifecycle;
  private specialistsFenced = false;
  private databaseState = databaseReadiness('reconciling');
  constructor(readonly dependencies: ServiceDependencies) {
    this.runtime = createCosRuntime({ ...dependencies, enabled: false });
  }
  private readonly executionReady = () =>
    !this.stopped && this.dependencies.enabled && this.status === 'ready' && (this.dependencies.admission?.() ?? true);
  /** Called in the host process; connection health never supplies scope/model/action consent. */
  healthStatus() {
    return {
      host_process_alive: true,
      component_stopped: this.stopped,
      infrastructure_status: this.status,
      database_readiness: this.databaseState,
      pool: this.store?.database.inspectPool?.() ?? null,
      admission: this.executionReady() ? 'eligible_subject_to_scope_authority' : 'closed',
      live_activation: 'not_verified',
      unknown_effects: 'requires_current_scoped_reconciliation',
    };
  }
  private fenceSpecialists(): void {
    this.specialistsFenced = !!this.specialists;
    this.specialists?.fenceLocal();
  }
  private async closeSpecialists(): Promise<void> {
    this.fenceSpecialists();
    const current = this.specialists;
    await current?.close();
    if (this.specialists === current) {
      this.specialists = undefined;
      this.specialistsFenced = false;
    }
  }
  private async retireStore(): Promise<void> {
    const old = this.retiringStore ?? this.store;
    if (!old) return;
    // Retain uncertainty until the old connections actually close. Never connect a replacement over it.
    this.retiringStore = old;
    await old.database.pool.end();
    if (this.store === old) this.store = undefined;
    if (this.retiringStore === old) this.retiringStore = undefined;
  }
  private fenceExecutions(): void {
    const d = this.dependencies;
    // This also runs before the first successful PostgreSQL connection after a restart.
    for (const identity of cosMissionIdentities(d.db)) {
      try {
        stopCosMissionAttempt(identity, 'authority_lost', d.db);
        const session = d.session(identity.sessionId);
        if (session) {
          const boundary = missionBoundary(session, d.db);
          if (!boundary.restricted || !boundary.identity || digest(boundary.identity) !== digest(identity)) continue;
        }
        d.stop(identity.sessionId);
      } catch {
        // Retain each durable denial; one uncertain stop must not leave other specialists admitted.
      }
    }
    const bindings = d.db.prepare('SELECT binding FROM cos_identity_boundaries').all() as Array<{ binding: string }>;
    for (const item of bindings) {
      try {
        const binding = JSON.parse(item.binding) as CosBinding;
        interruptReviewOrigin(d.db, binding);
        interruptScheduledOrigin(d.db, binding);
        const session = d.session(binding.sessionId);
        if (session) {
          const boundary = cosBoundary(session, d.db);
          if (!boundary.restricted || !boundary.binding || digest(boundary.binding) !== digest(binding)) continue;
        }
        d.stop(binding.sessionId);
      } catch {
        // One uncertain local stop must not prevent fencing the remaining CoS bindings.
      }
    }
  }
  async tick(): Promise<void> {
    if (this.stopped || !this.dependencies.enabled || this.inFlight) return;
    const run = async () => {
      try {
        if (this.retiringStore) {
          this.status = 'reconciling';
          await this.retireStore();
        }
        // Retain an uncertain cleanup owner. Never install replacement hooks over it.
        if (this.specialistsFenced) await this.closeSpecialists();
        if (this.dependencies.admission && !this.dependencies.admission()) {
          this.status = 'maintenance';
          this.runtime.dispose();
          this.runtime = createCosRuntime({ ...this.dependencies, enabled: false });
          this.fenceSpecialists();
          this.fenceExecutions();
          await this.closeSpecialists();
          await this.retireStore();
          return;
        }
        if (!this.store) {
          this.status = 'reconciling';
          this.databaseState = databaseReadiness('reconciling');
          this.store = await this.dependencies.connect();
          if (this.stopped) return;
          this.runtime.dispose();
          this.runtime = createCosRuntime({
            ...this.dependencies,
            store: this.store,
            admission: this.executionReady,
          });
        }
        await this.store.database.run((client) => client.query('SELECT 1'));
        if (this.stopped) return;
        this.databaseState = databaseReadiness(null);
        if (!this.specialists) this.specialists = this.dependencies.specialists?.(this.store, this.executionReady);
        const rows = this.dependencies.db.prepare('SELECT binding FROM cos_identity_boundaries').all() as Array<{
          binding: string;
        }>;
        if (this.status !== 'ready') {
          this.status = 'reconciling';
          // Reconcile owner denials and retained workers before installing a dispatch grant.
          for (const row of rows) {
            if (this.stopped) return;
            await this.runtime.reconcile(JSON.parse(row.binding) as CosBinding);
          }
          await this.specialists?.recover?.();
          if (this.stopped || !(this.dependencies.admission?.() ?? true)) return;
          this.status = 'ready';
        }
        for (const row of rows) {
          if (this.stopped) return;
          const binding = JSON.parse(row.binding) as CosBinding;
          await this.specialists?.pump(binding);
          if (!this.stopped) await this.runtime.pump(binding);
        }
      } catch (error) {
        // Close the actual grant before waiting for any potentially uncertain native cleanup.
        this.status = 'reconciling';
        this.databaseState = databaseReadiness(
          error instanceof DatabaseConfigurationError ? error : preflightFailure(error),
        );
        this.fenceSpecialists();
        this.fenceExecutions();
        try {
          await this.closeSpecialists();
        } catch {
          // Keep the fenced lifecycle and pool for a later cleanup retry.
        }
        this.status =
          error instanceof DatabaseConfigurationError
            ? 'misconfigured'
            : error instanceof DatabasePreflightError
              ? error.code
              : 'unreachable';
      }
    };
    this.inFlight = run();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }
  async stop(): Promise<void> {
    if (this.closed) return;
    if (this.stopInFlight) return this.stopInFlight;
    this.stopInFlight = (async () => {
      this.stopped = true;
      this.runtime.dispose();
      this.fenceSpecialists();
      this.fenceExecutions();
      await this.inFlight;
      await this.closeSpecialists();
      await this.retireStore();
      this.closed = true;
    })();
    try {
      await this.stopInFlight;
    } finally {
      this.stopInFlight = undefined;
    }
  }
}
