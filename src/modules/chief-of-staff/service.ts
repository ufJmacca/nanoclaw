import type { PriorityStore } from './store/priorities.js';
import { createCosRuntime, type RuntimeDependencies } from './runtime.js';
import { DatabasePreflightError } from './store/preflight.js';
import { DatabaseConfigurationError } from './store/config.js';
import type { CosBinding } from '../../cos-boundary.js';
import { interruptReviewOrigin } from './missions/review-origin.js';
import { interruptScheduledOrigin } from './automation/scheduled-origin.js';
export type ServiceDependencies = Omit<RuntimeDependencies, 'store'> & { connect(): Promise<PriorityStore> };
export class CosService {
  runtime: ReturnType<typeof createCosRuntime>;
  status = 'disabled';
  private store: PriorityStore | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;
  private closed = false;
  constructor(readonly dependencies: ServiceDependencies) {
    this.runtime = createCosRuntime({ ...dependencies, enabled: false });
  }
  private fenceExecutions(): void {
    const d = this.dependencies;
    const bindings = d.db.prepare('SELECT binding FROM cos_identity_boundaries').all() as Array<{ binding: string }>;
    for (const item of bindings) {
      try {
        const binding = JSON.parse(item.binding) as CosBinding;
        interruptReviewOrigin(d.db, binding);
        interruptScheduledOrigin(d.db, binding);
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
        if (this.dependencies.admission && !this.dependencies.admission()) {
          this.status = 'maintenance';
          this.runtime.dispose();
          this.runtime = createCosRuntime({ ...this.dependencies, enabled: false });
          this.fenceExecutions();
          if (this.store) {
            const old = this.store;
            this.store = undefined;
            await old.database.pool.end();
          }
          return;
        }
        if (!this.store) {
          this.status = 'reconciling';
          this.store = await this.dependencies.connect();
          if (this.stopped) return;
          this.runtime.dispose();
          this.runtime = createCosRuntime({ ...this.dependencies, store: this.store });
        }
        await this.store.database.run((client) => client.query('SELECT 1'));
        if (this.stopped) return;
        this.status = 'ready';
        const rows = this.dependencies.db.prepare('SELECT binding FROM cos_identity_boundaries').all() as Array<{
          binding: string;
        }>;
        for (const row of rows) {
          if (this.stopped) return;
          await this.runtime.pump(JSON.parse(row.binding) as CosBinding);
        }
      } catch (error) {
        this.fenceExecutions();
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
    this.stopped = true;
    this.runtime.dispose();
    await this.inFlight;
    if (!this.closed) {
      this.closed = true;
      await this.store?.database.pool.end();
    }
  }
}
