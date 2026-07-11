export interface HostShutdownDependencies {
  stopHostSweep(): void;
  stopDeliveryPolls(): void;
  stopContainerAdmissions(): void;
  stopExternalIngress(): Promise<void>;
  teardownChannelAdapters(): Promise<void>;
  awaitDeliveryDrains(): Promise<void>;
  awaitContainerSpawns(): Promise<void>;
  stopAllActiveContainers(): Promise<void>;
  releaseHostExecutionLease(): void;
}

export interface HostShutdownOptions {
  /** Maximum time granted to any one asynchronous shutdown stage. */
  stageTimeoutMs?: number;
}

const DEFAULT_STAGE_TIMEOUT_MS = 30_000;

export interface HostExecutionStartupDependencies<Database, Lease> {
  initializeDatabase(): Database;
  migrateDatabase(db: Database): void;
  acquireExecutionLease(db: Database): Lease;
  migrateFilesystem(): void;
  ensureContainerRuntime(): void;
  cleanupOrphans(): void;
  openContainerAdmissions(): void;
  openDeliveryIntake(): void;
}

/** Establish exclusive execution ownership before any shared runtime mutation. */
export function prepareHostExecutionOwnership<Database, Lease>(
  dependencies: HostExecutionStartupDependencies<Database, Lease>,
): { db: Database; lease: Lease } {
  const db = dependencies.initializeDatabase();
  dependencies.migrateDatabase(db);
  const lease = dependencies.acquireExecutionLease(db);
  dependencies.migrateFilesystem();
  dependencies.ensureContainerRuntime();
  dependencies.cleanupOrphans();
  dependencies.openContainerAdmissions();
  dependencies.openDeliveryIntake();
  return { db, lease };
}

/**
 * Run startup as explicit stages so a termination request observed at any
 * asynchronous boundary prevents later stages from reopening host intake.
 * Returns false when startup was cancelled, rather than treating a normal
 * termination request as a startup failure.
 */
export async function runHostStartupStages(
  stages: ReadonlyArray<() => void | Promise<void>>,
  signal: AbortSignal,
): Promise<boolean> {
  for (const stage of stages) {
    if (signal.aborted) return false;
    await stage();
    if (signal.aborted) return false;
  }
  return true;
}

async function runWithTimeout(operation: () => Promise<void>, label: string, timeoutMs: number): Promise<void> {
  const running = operation();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`Host shutdown stage timed out: ${label}`)), timeoutMs);
  });
  try {
    await Promise.race([running, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function performHostShutdown(
  dependencies: HostShutdownDependencies,
  options: HostShutdownOptions = {},
): Promise<void> {
  const failures: unknown[] = [];
  const stageTimeoutMs = options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
  if (!Number.isFinite(stageTimeoutMs) || stageTimeoutMs <= 0) {
    throw new Error('Host shutdown stage timeout must be a positive finite number');
  }
  const runSync = (operation: () => void): void => {
    try {
      operation();
      // Every shutdown stage is attempted before the aggregate failure is raised.
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (err) {
      failures.push(err);
    }
  };
  const runAsync = async (label: string, operation: () => Promise<void>): Promise<void> => {
    try {
      await runWithTimeout(operation, label, stageTimeoutMs);
      // Every shutdown stage is attempted before the aggregate failure is raised.
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (err) {
      failures.push(err);
    }
  };

  runSync(dependencies.stopHostSweep);
  runSync(dependencies.stopDeliveryPolls);
  runSync(dependencies.stopContainerAdmissions);
  await runAsync('stop external ingress', dependencies.stopExternalIngress);
  await runAsync('teardown channel adapters', dependencies.teardownChannelAdapters);
  await runAsync('drain deliveries', dependencies.awaitDeliveryDrains);
  await runAsync('drain container spawns', dependencies.awaitContainerSpawns);
  await runAsync('stop active containers', dependencies.stopAllActiveContainers);
  if (failures.length > 0) throw new AggregateError(failures, 'Host shutdown incomplete');
  runSync(dependencies.releaseHostExecutionLease);
  if (failures.length > 0) throw new AggregateError(failures, 'Host shutdown incomplete');
}
