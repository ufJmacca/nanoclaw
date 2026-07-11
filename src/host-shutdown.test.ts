import { expect, it, vi } from 'vitest';

import * as shutdownModule from './host-shutdown.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve?.() };
}

it('closes every ingress boundary before draining and stopping exact executions', async () => {
  const performShutdown = (
    shutdownModule as typeof shutdownModule & {
      performHostShutdown?: (dependencies: shutdownModule.HostShutdownDependencies) => Promise<void>;
    }
  ).performHostShutdown;
  expect(performShutdown).toBeTypeOf('function');
  if (!performShutdown) return;
  const order: string[] = [];
  const externalIngress = deferred();
  const adapterIngress = deferred();
  const deliveries = deferred();
  const spawns = deferred();
  const stopContainers = deferred();
  const dependencies: shutdownModule.HostShutdownDependencies = {
    stopHostSweep: vi.fn(() => order.push('stop-host-sweep')),
    stopDeliveryPolls: vi.fn(() => order.push('stop-delivery-intake')),
    stopContainerAdmissions: vi.fn(() => order.push('stop-container-admission')),
    stopExternalIngress: vi.fn(async () => {
      order.push('stop-external-ingress');
      await externalIngress.promise;
    }),
    teardownChannelAdapters: vi.fn(async () => {
      order.push('teardown-adapter-ingress');
      await adapterIngress.promise;
    }),
    awaitDeliveryDrains: vi.fn(async () => {
      order.push('drain-delivery');
      await deliveries.promise;
    }),
    awaitContainerSpawns: vi.fn(async () => {
      order.push('drain-spawns');
      await spawns.promise;
    }),
    stopAllActiveContainers: vi.fn(async () => {
      order.push('stop-active-containers');
      await stopContainers.promise;
    }),
    releaseHostExecutionLease: vi.fn(() => order.push('release-host-lease')),
  };

  let complete = false;
  const shutdown = performShutdown(dependencies).then(() => {
    complete = true;
  });
  expect(order).toEqual([
    'stop-host-sweep',
    'stop-delivery-intake',
    'stop-container-admission',
    'stop-external-ingress',
  ]);
  externalIngress.resolve();
  await vi.waitFor(() => expect(order).toContain('teardown-adapter-ingress'));
  expect(order).not.toContain('drain-delivery');
  adapterIngress.resolve();
  await vi.waitFor(() => expect(order).toContain('drain-delivery'));
  deliveries.resolve();
  await vi.waitFor(() => expect(order).toContain('drain-spawns'));
  spawns.resolve();
  await vi.waitFor(() => expect(order).toContain('stop-active-containers'));
  expect(complete).toBe(false);
  stopContainers.resolve();
  await shutdown;

  expect(order).toEqual([
    'stop-host-sweep',
    'stop-delivery-intake',
    'stop-container-admission',
    'stop-external-ingress',
    'teardown-adapter-ingress',
    'drain-delivery',
    'drain-spawns',
    'stop-active-containers',
    'release-host-lease',
  ]);
});

it('continues durable drains and container stops while reporting shutdown failures', async () => {
  const calls: string[] = [];
  const failure = new Error('injected external ingress stop failure');
  const deliveryFailure = new Error('injected delivery drain failure');
  const dependencies: shutdownModule.HostShutdownDependencies = {
    stopHostSweep: () => calls.push('stop-host-sweep'),
    stopDeliveryPolls: () => calls.push('stop-delivery-intake'),
    stopContainerAdmissions: () => calls.push('stop-container-admission'),
    stopExternalIngress: async () => {
      calls.push('stop-external-ingress');
      throw failure;
    },
    teardownChannelAdapters: async () => {
      calls.push('teardown-adapter-ingress');
    },
    awaitDeliveryDrains: async () => {
      calls.push('drain-delivery');
      throw deliveryFailure;
    },
    awaitContainerSpawns: async () => {
      calls.push('drain-spawns');
    },
    stopAllActiveContainers: async () => {
      calls.push('stop-active-containers');
    },
    releaseHostExecutionLease: () => calls.push('release-host-lease'),
  };

  await expect(shutdownModule.performHostShutdown(dependencies)).rejects.toThrow('Host shutdown incomplete');
  expect(calls).toEqual([
    'stop-host-sweep',
    'stop-delivery-intake',
    'stop-container-admission',
    'stop-external-ingress',
    'teardown-adapter-ingress',
    'drain-delivery',
    'drain-spawns',
    'stop-active-containers',
  ]);
});

it('bounds a hung shutdown stage and continues every later best-effort stop', async () => {
  vi.useFakeTimers();
  try {
    const calls: string[] = [];
    const neverSettles = new Promise<void>(() => {});
    const dependencies: shutdownModule.HostShutdownDependencies = {
      stopHostSweep: () => calls.push('stop-host-sweep'),
      stopDeliveryPolls: () => calls.push('stop-delivery-intake'),
      stopContainerAdmissions: () => calls.push('stop-container-admission'),
      stopExternalIngress: async () => {
        calls.push('stop-external-ingress');
        await neverSettles;
      },
      teardownChannelAdapters: async () => {
        calls.push('teardown-adapter-ingress');
      },
      awaitDeliveryDrains: async () => {
        calls.push('drain-delivery');
      },
      awaitContainerSpawns: async () => {
        calls.push('drain-spawns');
      },
      stopAllActiveContainers: async () => {
        calls.push('stop-active-containers');
      },
      releaseHostExecutionLease: () => calls.push('release-host-lease'),
    };

    const shutdown = shutdownModule.performHostShutdown(dependencies, { stageTimeoutMs: 1_000 });
    const outcome = expect(shutdown).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AggregateError &&
        err.errors.some(
          (failure) =>
            failure instanceof Error && failure.message === 'Host shutdown stage timed out: stop external ingress',
        ),
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await outcome;
    expect(calls).toEqual([
      'stop-host-sweep',
      'stop-delivery-intake',
      'stop-container-admission',
      'stop-external-ingress',
      'teardown-adapter-ingress',
      'drain-delivery',
      'drain-spawns',
      'stop-active-containers',
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it('does not run later startup stages after termination interrupts an async stage', async () => {
  const runStartup = (
    shutdownModule as typeof shutdownModule & {
      runHostStartupStages?: (
        stages: ReadonlyArray<() => void | Promise<void>>,
        signal: AbortSignal,
      ) => Promise<boolean>;
    }
  ).runHostStartupStages;
  expect(runStartup).toBeTypeOf('function');
  if (!runStartup) return;

  const startupGate = deferred();
  const controller = new AbortController();
  const calls: string[] = [];
  const startup = runStartup(
    [
      async () => {
        calls.push('async-startup');
        await startupGate.promise;
      },
      () => {
        calls.push('reopen-container-admissions');
      },
      () => {
        calls.push('reopen-delivery-intake');
      },
      () => {
        calls.push('start-channel-adapters');
      },
    ],
    controller.signal,
  );
  expect(calls).toEqual(['async-startup']);

  controller.abort();
  startupGate.resolve();

  await expect(startup).resolves.toBe(false);
  expect(calls).toEqual(['async-startup']);
});

it('acquires exclusive host execution ownership before shared mutation or admission', () => {
  const prepare = (
    shutdownModule as typeof shutdownModule & {
      prepareHostExecutionOwnership?: <Database, Lease>(dependencies: {
        initializeDatabase(): Database;
        migrateDatabase(db: Database): void;
        acquireExecutionLease(db: Database): Lease;
        migrateFilesystem(): void;
        ensureContainerRuntime(): void;
        cleanupOrphans(): void;
        openContainerAdmissions(): void;
        openDeliveryIntake(): void;
      }) => { db: Database; lease: Lease };
    }
  ).prepareHostExecutionOwnership;
  expect(prepare).toBeTypeOf('function');
  if (!prepare) return;

  const order: string[] = [];
  const result = prepare({
    initializeDatabase: () => {
      order.push('initialize-db');
      return { id: 'central-db' };
    },
    migrateDatabase: () => order.push('migrate-db'),
    acquireExecutionLease: () => {
      order.push('acquire-lease');
      return { ownerId: 'host-owner', pid: 101 };
    },
    migrateFilesystem: () => order.push('migrate-filesystem'),
    ensureContainerRuntime: () => order.push('ensure-runtime'),
    cleanupOrphans: () => order.push('cleanup-orphans'),
    openContainerAdmissions: () => order.push('open-container-admissions'),
    openDeliveryIntake: () => order.push('open-delivery-intake'),
  });
  expect(result).toEqual({ db: { id: 'central-db' }, lease: { ownerId: 'host-owner', pid: 101 } });
  expect(order).toEqual([
    'initialize-db',
    'migrate-db',
    'acquire-lease',
    'migrate-filesystem',
    'ensure-runtime',
    'cleanup-orphans',
    'open-container-admissions',
    'open-delivery-intake',
  ]);

  const afterRejectedLease = vi.fn();
  expect(() =>
    prepare({
      initializeDatabase: () => ({ id: 'central-db' }),
      migrateDatabase: () => {},
      acquireExecutionLease: () => {
        throw new Error('live host already owns execution');
      },
      migrateFilesystem: afterRejectedLease,
      ensureContainerRuntime: afterRejectedLease,
      cleanupOrphans: afterRejectedLease,
      openContainerAdmissions: afterRejectedLease,
      openDeliveryIntake: afterRejectedLease,
    }),
  ).toThrow('live host already owns execution');
  expect(afterRejectedLease).not.toHaveBeenCalled();
});

it('releases the host execution lease only after every drain and container stop succeeds', async () => {
  const successfulOrder: string[] = [];
  await shutdownModule.performHostShutdown({
    stopHostSweep: () => {},
    stopDeliveryPolls: () => {},
    stopContainerAdmissions: () => {},
    stopExternalIngress: async () => {},
    teardownChannelAdapters: async () => {},
    awaitDeliveryDrains: async () => {},
    awaitContainerSpawns: async () => {},
    stopAllActiveContainers: async () => {
      successfulOrder.push('stop-containers');
    },
    releaseHostExecutionLease: () => {
      successfulOrder.push('release-lease');
    },
  } as shutdownModule.HostShutdownDependencies);
  expect(successfulOrder).toEqual(['stop-containers', 'release-lease']);

  const failedRelease = vi.fn();
  await expect(
    shutdownModule.performHostShutdown({
      stopHostSweep: () => {},
      stopDeliveryPolls: () => {},
      stopContainerAdmissions: () => {},
      stopExternalIngress: async () => {},
      teardownChannelAdapters: async () => {},
      awaitDeliveryDrains: async () => {},
      awaitContainerSpawns: async () => {},
      stopAllActiveContainers: async () => {
        throw new Error('injected surviving container');
      },
      releaseHostExecutionLease: failedRelease,
    } as shutdownModule.HostShutdownDependencies),
  ).rejects.toThrow('Host shutdown incomplete');
  expect(failedRelease).not.toHaveBeenCalled();
});
