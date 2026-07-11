/**
 * Channel adapter registry.
 *
 * Channels self-register on import. The host calls initChannelAdapters() at startup
 * to instantiate and set up all registered adapters.
 */
import type { ChannelAdapter, ChannelRegistration, ChannelSetup } from './adapter.js';
import { log } from '../log.js';

const SETUP_RETRY_DELAYS_MS = [2000, 5000, 10000];

/** Duck-type check — adapters that throw an Error with `name === 'NetworkError'`
 * (Chat SDK's `@chat-adapter/shared.NetworkError` and similar) get a retry on
 * setup. Avoids depending on `@chat-adapter/shared` at trunk level. */
function isNetworkError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'NetworkError';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise<void>((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

const registry = new Map<string, ChannelRegistration>();
const activeAdapters = new Map<string, ChannelAdapter>();
const initializingAdapters = new Set<Promise<void>>();

export interface ChannelAdapterInitOptions {
  signal?: AbortSignal;
  strictChannels?: readonly string[];
  requiredChannels?: readonly string[];
  requiredInstances?: Readonly<Record<string, readonly string[]>>;
}

/** Register a channel adapter factory. Called by channel modules on import. */
export function registerChannelAdapter(name: string, registration: ChannelRegistration): void {
  registry.set(name, registration);
}

/** Get a live adapter by channel type. */
export function getChannelAdapter(channelType: string): ChannelAdapter | undefined {
  return activeAdapters.get(channelType);
}

/** Get all active adapters. */
export function getActiveAdapters(): ChannelAdapter[] {
  return [...activeAdapters.values()];
}

/** Fail closed when durable instance state is not owned by the active adapter. */
export function requireChannelAdapterInstances(channelType: string, instanceKeys: ReadonlySet<string>): void {
  if (instanceKeys.size === 0) return;
  const adapter = activeAdapters.get(channelType);
  if (!adapter?.platformInstanceKey || instanceKeys.size !== 1 || !instanceKeys.has(adapter.platformInstanceKey)) {
    throw new Error('Configured channel adapter does not cover persisted instance state');
  }
}

/** Get all registered channel names. */
export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}

/** Get container config for a channel (used by container-runner for additional mounts/env). */
export function getChannelContainerConfig(name: string): ChannelRegistration['containerConfig'] {
  return registry.get(name)?.containerConfig;
}

/**
 * Instantiate and set up all registered channel adapters.
 * Skips adapters that return null (missing credentials).
 */
export async function initChannelAdapters(
  setupFn: (adapter: ChannelAdapter) => ChannelSetup,
  options: ChannelAdapterInitOptions = {},
): Promise<void> {
  for (const [name, registration] of registry) {
    if (options.signal?.aborted) break;
    const initializing = initializeChannelAdapter(
      name,
      registration,
      setupFn,
      options.signal,
      options.requiredChannels?.includes(name) ?? false,
      new Set(options.requiredInstances?.[name] ?? []),
    );
    initializingAdapters.add(initializing);
    try {
      await initializing;
    } catch (err) {
      log.error('Failed to start channel adapter', { channel: name, err });
      if (
        options.strictChannels?.includes(name) ||
        options.requiredChannels?.includes(name) ||
        options.requiredInstances?.[name]
      ) {
        throw err;
      }
    } finally {
      initializingAdapters.delete(initializing);
    }
  }
}

async function initializeChannelAdapter(
  name: string,
  registration: ChannelRegistration,
  setupFn: (adapter: ChannelAdapter) => ChannelSetup,
  signal?: AbortSignal,
  required = false,
  requiredInstances: ReadonlySet<string> = new Set(),
): Promise<void> {
  const adapter = await registration.factory();
  if (!adapter) {
    if (required) throw new Error(`Required channel adapter credentials are missing: ${name}`);
    log.warn('Channel credentials missing, skipping', { channel: name });
    return;
  }
  if (
    requiredInstances.size > 0 &&
    (!adapter.platformInstanceKey ||
      requiredInstances.size !== 1 ||
      !requiredInstances.has(adapter.platformInstanceKey))
  ) {
    throw new Error('Configured channel adapter does not cover persisted instance state');
  }
  if (signal?.aborted) return;

  const setup = setupFn(adapter);
  // Transient network failures during adapter init (e.g. Telegram deleteWebhook
  // hitting a DNS hiccup at boot) would otherwise leave the channel permanently
  // dead until manual restart. Retry only on NetworkError so misconfigs (bad
  // tokens, etc.) still fail fast.
  let attempt = 0;
  while (true) {
    if (signal?.aborted) {
      await adapter.teardown();
      return;
    }
    try {
      await adapter.setup(setup);
      break;
    } catch (err) {
      if (signal?.aborted) {
        await adapter.teardown();
        return;
      }
      if (isNetworkError(err) && attempt < SETUP_RETRY_DELAYS_MS.length) {
        const delay = SETUP_RETRY_DELAYS_MS[attempt]!;
        log.warn('Channel adapter setup failed with network error, retrying', {
          channel: name,
          attempt: attempt + 1,
          delayMs: delay,
          err: err.message,
        });
        await sleep(delay, signal);
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
  if (signal?.aborted) {
    await adapter.teardown();
    return;
  }
  activeAdapters.set(adapter.channelType, adapter);
  log.info('Channel adapter started', { channel: name, type: adapter.channelType });
}

/** Tear down all active adapters. */
export async function teardownChannelAdapters(): Promise<void> {
  const failures: unknown[] = [];
  const teardownActive = async (): Promise<void> => {
    for (const [name, adapter] of [...activeAdapters]) {
      activeAdapters.delete(name);
      try {
        await adapter.teardown();
        log.info('Channel adapter stopped', { channel: name });
      } catch (err) {
        log.error('Failed to stop channel adapter', { channel: name, err });
        failures.push(err);
      }
    }
  };
  await teardownActive();
  if (initializingAdapters.size > 0) {
    const results = await Promise.allSettled([...initializingAdapters]);
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
  }
  await teardownActive();
  if (failures.length > 0) throw new AggregateError(failures, 'Channel adapter teardown incomplete');
}
