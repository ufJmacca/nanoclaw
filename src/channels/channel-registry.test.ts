/**
 * Tests for the v2 channel adapter registry and integration with host.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';

import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';

// Mock container runner
vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Override DATA_DIR for tests
vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-channels' };
});

const TEST_DIR = '/tmp/nanoclaw-test-channels';

function now() {
  return new Date().toISOString();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Create a mock ChannelAdapter for testing. */
function createMockAdapter(
  channelType: string,
): ChannelAdapter & { delivered: OutboundMessage[]; inbound: InboundMessage[] } {
  const delivered: OutboundMessage[] = [];
  const inbound: InboundMessage[] = [];
  let setupConfig: ChannelSetup | null = null;

  return {
    name: channelType,
    channelType,
    supportsThreads: false,
    delivered,
    inbound,

    async setup(config: ChannelSetup) {
      setupConfig = config;
    },

    async teardown() {
      setupConfig = null;
    },

    isConnected() {
      return setupConfig !== null;
    },

    async deliver(
      _platformId: string,
      _threadId: string | null,
      message: OutboundMessage,
    ): Promise<string | undefined> {
      delivered.push(message);
      return undefined;
    },

    async setTyping() {},
  };
}

describe('channel registry', () => {
  // Import fresh modules for each test to avoid registry pollution
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('should register and retrieve channel adapters', async () => {
    const { registerChannelAdapter, getRegisteredChannelNames, getChannelContainerConfig } =
      await import('./channel-registry.js');

    registerChannelAdapter('test-channel', {
      factory: () => createMockAdapter('test'),
      containerConfig: {
        env: { TEST_KEY: 'value' },
      },
    });

    expect(getRegisteredChannelNames()).toContain('test-channel');
    expect(getChannelContainerConfig('test-channel')).toEqual({
      env: { TEST_KEY: 'value' },
    });
  });

  it('should skip adapters that return null (missing credentials)', async () => {
    const { registerChannelAdapter, initChannelAdapters, getActiveAdapters } = await import('./channel-registry.js');

    registerChannelAdapter('no-creds', {
      factory: () => null,
    });

    await initChannelAdapters(() => ({
      conversations: [],
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    // Should not have any active adapters for channels with null factory returns
    const active = getActiveAdapters();
    const noCreds = active.find((a) => a.name === 'no-creds');
    expect(noCreds).toBeUndefined();
  });

  it('propagates a strict adapter recovery failure before host work can start', async () => {
    const { registerChannelAdapter, initChannelAdapters, getActiveAdapters } = await import('./channel-registry.js');
    const adapter = createMockAdapter('strict-recovery');
    adapter.setup = vi.fn().mockRejectedValue(new Error('injected strict recovery failure'));
    let created = false;
    registerChannelAdapter('strict-recovery-registration', {
      factory: () => {
        if (created) return null;
        created = true;
        return adapter;
      },
    });

    await expect(
      initChannelAdapters(
        () => ({
          onInbound: () => {},
          onInboundEvent: () => {},
          onMetadata: () => {},
          onAction: () => {},
        }),
        { strictChannels: ['strict-recovery-registration'] },
      ),
    ).rejects.toThrow('injected strict recovery failure');
    expect(getActiveAdapters()).not.toContain(adapter);
  });

  it('fails closed when durable state requires an adapter whose credentials are missing', async () => {
    const { registerChannelAdapter, initChannelAdapters } = await import('./channel-registry.js');
    registerChannelAdapter('required-missing-registration', { factory: () => null });

    await expect(
      initChannelAdapters(
        () => ({
          onInbound: () => {},
          onInboundEvent: () => {},
          onMetadata: () => {},
          onAction: () => {},
        }),
        { requiredChannels: ['required-missing-registration'] },
      ),
    ).rejects.toThrow('Required channel adapter credentials are missing');
  });

  it('requires the active adapter to match every persisted platform instance', async () => {
    const registry = await import('./channel-registry.js');
    const requireInstances = (
      registry as typeof registry & {
        requireChannelAdapterInstances?: (channelType: string, instanceKeys: ReadonlySet<string>) => void;
      }
    ).requireChannelAdapterInstances;
    expect(requireInstances).toBeTypeOf('function');
    if (!requireInstances) return;
    const adapter = {
      ...createMockAdapter('instance-bound'),
      platformInstanceKey: 'primary',
    };
    let created = false;
    registry.registerChannelAdapter('instance-bound-registration', {
      factory: () => {
        if (created) return null;
        created = true;
        return adapter;
      },
    });
    await registry.initChannelAdapters(() => ({
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    expect(() => requireInstances('instance-bound', new Set(['secondary']))).toThrow(
      'Configured channel adapter does not cover persisted instance state',
    );
    expect(() => requireInstances('instance-bound', new Set(['primary']))).not.toThrow();
  });

  it('rejects a persisted instance mismatch before adapter setup can mutate state', async () => {
    const registry = await import('./channel-registry.js');
    const adapter = {
      ...createMockAdapter('pre-setup-instance-bound'),
      platformInstanceKey: 'primary',
      setup: vi.fn().mockResolvedValue(undefined),
    };
    let created = false;
    registry.registerChannelAdapter('pre-setup-instance-registration', {
      factory: () => {
        if (created) return null;
        created = true;
        return adapter;
      },
    });

    await expect(
      registry.initChannelAdapters(
        () => ({
          onInbound: () => {},
          onInboundEvent: () => {},
          onMetadata: () => {},
          onAction: () => {},
        }),
        { requiredInstances: { 'pre-setup-instance-registration': ['secondary'] } },
      ),
    ).rejects.toThrow('Configured channel adapter does not cover persisted instance state');
    expect(adapter.setup).not.toHaveBeenCalled();
  });

  it('stops every active adapter and reports teardown failures', async () => {
    const { registerChannelAdapter, initChannelAdapters, teardownChannelAdapters, getActiveAdapters } =
      await import('./channel-registry.js');
    const failing = createMockAdapter('teardown-failing');
    const healthy = createMockAdapter('teardown-healthy');
    const failure = new Error('injected adapter drain failure');
    failing.teardown = vi.fn().mockRejectedValue(failure);
    healthy.teardown = vi.fn().mockResolvedValue(undefined);
    let failingCreated = false;
    let healthyCreated = false;
    registerChannelAdapter('teardown-failing-registration', {
      factory: () => {
        if (failingCreated) return null;
        failingCreated = true;
        return failing;
      },
    });
    registerChannelAdapter('teardown-healthy-registration', {
      factory: () => {
        if (healthyCreated) return null;
        healthyCreated = true;
        return healthy;
      },
    });
    await initChannelAdapters(() => ({
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    await expect(teardownChannelAdapters()).rejects.toThrow('Channel adapter teardown incomplete');

    expect(failing.teardown).toHaveBeenCalledOnce();
    expect(healthy.teardown).toHaveBeenCalledOnce();
    expect(getActiveAdapters()).toEqual([]);
  });

  it('tracks an initializing adapter so termination cannot leave it active after teardown', async () => {
    const { registerChannelAdapter, initChannelAdapters, teardownChannelAdapters, getActiveAdapters } =
      await import('./channel-registry.js');
    const setupStarted = deferred<void>();
    const releaseSetup = deferred<void>();
    let connected = false;
    const adapter = createMockAdapter('startup-race');
    adapter.setup = vi.fn(async () => {
      setupStarted.resolve(undefined);
      await releaseSetup.promise;
      connected = true;
    });
    adapter.teardown = vi.fn(async () => {
      connected = false;
    });
    adapter.isConnected = () => connected;
    let created = false;
    registerChannelAdapter('startup-race-registration', {
      factory: () => {
        if (created) return null;
        created = true;
        return adapter;
      },
    });
    const controller = new AbortController();
    const initialize = (
      initChannelAdapters as typeof initChannelAdapters & {
        (setupFn: (adapter: ChannelAdapter) => ChannelSetup, options: { signal: AbortSignal }): Promise<void>;
      }
    )(
      () => ({
        onInbound: () => {},
        onInboundEvent: () => {},
        onMetadata: () => {},
        onAction: () => {},
      }),
      { signal: controller.signal },
    );
    await setupStarted.promise;

    controller.abort();
    let teardownComplete = false;
    const teardown = teardownChannelAdapters().then(() => {
      teardownComplete = true;
    });
    await Promise.resolve();
    expect(teardownComplete).toBe(false);

    releaseSetup.resolve(undefined);
    await Promise.all([initialize, teardown]);

    expect(adapter.teardown).toHaveBeenCalledOnce();
    expect(adapter.isConnected()).toBe(false);
    expect(getActiveAdapters()).not.toContain(adapter);
  });

  it('does not retry adapter setup after startup cancellation', async () => {
    vi.useFakeTimers();
    try {
      const { registerChannelAdapter, initChannelAdapters, teardownChannelAdapters } =
        await import('./channel-registry.js');
      const networkFailure = new Error('temporary network failure');
      networkFailure.name = 'NetworkError';
      const adapter = createMockAdapter('startup-retry-race');
      adapter.setup = vi
        .fn()
        .mockRejectedValueOnce(networkFailure)
        .mockImplementationOnce(async () => {});
      adapter.teardown = vi.fn().mockResolvedValue(undefined);
      let created = false;
      registerChannelAdapter('startup-retry-race-registration', {
        factory: () => {
          if (created) return null;
          created = true;
          return adapter;
        },
      });
      const controller = new AbortController();
      const initialize = initChannelAdapters(
        () => ({
          onInbound: () => {},
          onInboundEvent: () => {},
          onMetadata: () => {},
          onAction: () => {},
        }),
        { signal: controller.signal },
      );
      await vi.waitFor(() => expect(adapter.setup).toHaveBeenCalledOnce());

      controller.abort();
      const teardown = teardownChannelAdapters();
      await vi.runAllTimersAsync();
      await Promise.all([initialize, teardown]);

      expect(adapter.setup).toHaveBeenCalledOnce();
      expect(adapter.teardown).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('channel + router integration', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const { initTestDb, runMigrations, createAgentGroup, createMessagingGroup, createMessagingGroupAgent } =
      await import('../db/index.js');
    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'mock',
      platform_id: 'chan-100',
      name: 'Test Channel',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  });

  afterEach(async () => {
    const { closeDb } = await import('../db/index.js');
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('should route inbound message from adapter to session DB', async () => {
    const { routeInbound } = await import('../router.js');
    const { findSession } = await import('../db/sessions.js');
    const { inboundDbPath } = await import('../session-manager.js');

    // Simulate what the adapter bridge does: stringify content, call routeInbound
    const inboundContent = { sender: 'TestUser', senderId: 'u1', text: 'Hello from adapter', isFromMe: false };

    await routeInbound({
      channelType: 'mock',
      platformId: 'chan-100',
      threadId: null,
      message: {
        id: 'msg-adapter-1',
        kind: 'chat',
        content: JSON.stringify(inboundContent),
        timestamp: now(),
      },
    });

    // Verify session was created and message written
    const session = findSession('mg-1', null);
    expect(session).toBeDefined();

    const dbPath = inboundDbPath('ag-1', session!.id);
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT * FROM messages_in').all() as Array<{ id: string; content: string }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('Hello from adapter');
  });

  it('should deliver outbound message through delivery adapter bridge', async () => {
    const { setDeliveryAdapter } = await import('../delivery.js');
    const { getChannelAdapter, registerChannelAdapter, initChannelAdapters } = await import('./channel-registry.js');

    // Register and init a mock adapter
    const mockAdapter = createMockAdapter('mock');
    registerChannelAdapter('mock-delivery', {
      factory: () => mockAdapter,
    });

    await initChannelAdapters(() => ({
      conversations: [],
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    // Set up delivery adapter bridge (same pattern as index.ts)
    setDeliveryAdapter({
      async deliver(channelType, platformId, threadId, kind, content) {
        const adapter = getChannelAdapter(channelType);
        if (!adapter) return undefined;
        return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content) });
      },
    });

    // Simulate delivery
    const adapter = getChannelAdapter('mock');
    if (adapter) {
      await adapter.deliver('chan-100', null, { kind: 'chat', content: { text: 'Agent response' } });
    }

    expect(mockAdapter.delivered).toHaveLength(1);
    expect((mockAdapter.delivered[0].content as { text: string }).text).toBe('Agent response');
  });
});
