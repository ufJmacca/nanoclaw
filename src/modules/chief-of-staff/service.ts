import type { PriorityStore } from './store/priorities.js';
import { createCosRuntime, type RuntimeDependencies } from './runtime.js';
import { DatabaseConfigurationError } from './store/config.js';
import type { CosBinding } from '../../cos-boundary.js';
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
  async tick(): Promise<void> {
    if (this.stopped || !this.dependencies.enabled || this.inFlight) return;
    const run = async () => {
      try {
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
        const rows = this.dependencies.db
          .prepare('SELECT binding FROM cos_identity_boundaries WHERE paused=0')
          .all() as Array<{ binding: string }>;
        for (const row of rows) {
          if (this.stopped) return;
          await this.runtime.pump(JSON.parse(row.binding) as CosBinding);
        }
      } catch (error) {
        this.status = error instanceof DatabaseConfigurationError ? 'misconfigured' : 'unreachable';
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
