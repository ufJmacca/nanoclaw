import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMattermostAdapter } from './mattermost-adapter.js';
import { getChannelContainerConfig, getRegisteredChannelNames } from './channel-registry.js';
import type { MattermostTransport, MattermostWebSocket } from './mattermost-client.js';
import { normalizeMattermostPayload } from './mattermost-inbound.js';
import {
  advanceMattermostRecoveryCursor,
  claimMattermostPostReceipt,
  listActiveMattermostRecoveryChannels,
} from './mattermost-recovery.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../db/index.js';

function seedActiveMattermostSubscription(channelId: string): {
  id: string;
  channel_id: string;
  user_id: string;
  root_id: string;
  message: string;
  create_at: number;
} {
  const createdAt = '2026-07-11T00:00:00.000Z';
  getDb()
    .prepare('INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)')
    .run('ag-recovery', 'Recovery agent', 'recovery-agent', createdAt);
  getDb()
    .prepare(
      `INSERT INTO messaging_groups (
         id, channel_type, platform_id, name, is_group, unknown_sender_policy, denied_at, created_at
       ) VALUES (?, 'mattermost', ?, ?, 1, 'strict', NULL, ?)`,
    )
    .run('mg-recovery', `mattermost:primary:${channelId}`, 'Recovery channel', createdAt);
  getDb()
    .prepare(
      `INSERT INTO messaging_group_agents (
         id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
         sender_scope, ignored_message_policy, session_mode, priority, created_at
       ) VALUES (?, ?, ?, 'pattern', '.', 'known', 'drop', 'shared', 0, ?)`,
    )
    .run('mga-recovery', 'mg-recovery', 'ag-recovery', createdAt);
  getDb()
    .prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, 'channel', 'channel', ?, ?)`,
    )
    .run('ag-recovery', 'mg-recovery', createdAt);
  getDb()
    .prepare(
      `INSERT INTO mattermost_subscriptions (
         instance_key, channel_id, messaging_group_id, agent_group_id, wiring_id,
         status, created_at, archived_at
       ) VALUES ('primary', ?, 'mg-recovery', 'ag-recovery', 'mga-recovery', 'active', ?, NULL)`,
    )
    .run(channelId, createdAt);
  const baseline = {
    id: `post-bootstrap-${channelId}`,
    channel_id: channelId,
    user_id: 'user-bootstrap',
    root_id: '',
    message: 'trusted adapter bootstrap',
    create_at: 100,
  };
  advanceMattermostRecoveryCursor({
    instanceKey: 'primary',
    channelId,
    lastPostCreatedAt: baseline.create_at,
    lastPostId: baseline.id,
  });
  return baseline;
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

class FakeSocket implements MattermostWebSocket {
  readonly send = vi.fn();
  readonly close = vi.fn();
  private readonly listeners = new Set<(payload: string) => void>();
  private readonly closeListeners = new Set<() => void>();

  onMessage(listener: (payload: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  emit(payload: string): void {
    for (const listener of [...this.listeners]) listener(payload);
  }

  terminate(): void {
    for (const listener of this.closeListeners) listener();
  }
}

function fakeTransport(): MattermostTransport {
  return {
    request: vi.fn(),
    openWebSocket: vi.fn(),
  };
}

function currentMattermostChannels(channelId: string, displayName = 'Recovery channel') {
  return {
    status: 200,
    body: [{ id: channelId, name: 'recovery-channel', display_name: displayName, type: 'O', delete_at: 0 }],
  };
}

function setupCallbacks(onInbound = vi.fn()) {
  return {
    onInbound,
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
    onLifecycle: vi.fn(),
  };
}

describe('Mattermost channel adapter assembly', () => {
  it('is reachable from the production channel registration barrel', async () => {
    await import('./index.js');

    expect(getRegisteredChannelNames()).toContain('mattermost');
    expect(getRegisteredChannelNames().indexOf('telegram')).toBeLessThan(
      getRegisteredChannelNames().indexOf('mattermost'),
    );
    expect(getChannelContainerConfig('mattermost')).toBeUndefined();
  });

  it('creates an adapter only from a complete host-side Mattermost configuration', async () => {
    const registration = (await import('./mattermost.js')) as typeof import('./mattermost.js') & {
      createMattermostAdapterFromHostConfig?: (
        env: Record<string, string | undefined>,
        transport: MattermostTransport,
      ) => ReturnType<typeof createMattermostAdapter> | null;
    };
    expect(registration.createMattermostAdapterFromHostConfig).toBeTypeOf('function');
    const create = registration.createMattermostAdapterFromHostConfig as NonNullable<
      typeof registration.createMattermostAdapterFromHostConfig
    >;

    expect(create({}, fakeTransport())).toBeNull();
    expect(() =>
      create(
        {
          MATTERMOST_URL: 'https://mattermost.example.test',
          MATTERMOST_BOT_TOKEN: 'must-not-appear-in-error',
        },
        fakeTransport(),
      ),
    ).toThrowError(new Error('Mattermost configuration requires URL, bot token, and instance key'));
    const adapter = create(
      {
        MATTERMOST_URL: 'https://mattermost.example.test',
        MATTERMOST_BOT_TOKEN: 'host-only-fixture-token',
        MATTERMOST_INSTANCE: 'primary',
      },
      fakeTransport(),
    );
    expect(adapter).toMatchObject({ channelType: 'mattermost', threadSessionPolicy: 'honor-wiring' });
    expect(getChannelContainerConfig('mattermost')).toBeUndefined();
  });

  it('supports thread-aware delivery while honoring the shared wiring session', () => {
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-fixture-credential',
        instanceKey: 'primary',
      },
      fakeTransport(),
    );

    expect(adapter.channelType).toBe('mattermost');
    expect(adapter.supportsThreads).toBe(true);
    expect(adapter.threadSessionPolicy).toBe('honor-wiring');
  });

  it('authenticates and forwards a Mattermost thread reply through the host setup boundary', async () => {
    const socket = new FakeSocket();
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
      openWebSocket: vi.fn().mockResolvedValue(socket),
    };
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );
    const setup = setupCallbacks();

    const setupPromise = adapter.setup(setup);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    socket.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setupPromise;
    socket.emit(
      JSON.stringify({
        event: 'posted',
        data: {
          sender_name: 'Ada',
          post: JSON.stringify({
            id: 'reply-post-id',
            channel_id: 'channel-a',
            user_id: 'user-a',
            root_id: 'root-post-id',
            message: 'Thread response',
            create_at: 1_700_000_000_000,
          }),
        },
      }),
    );

    await vi.waitFor(() => expect(setup.onInbound).toHaveBeenCalledOnce());
    expect(setup.onInbound).toHaveBeenCalledWith(
      'mattermost:primary:channel-a',
      'root-post-id',
      expect.objectContaining({ id: 'reply-post-id', isGroup: true }),
    );
    expect(adapter.isConnected()).toBe(true);
  });

  it('reports the adapter unavailable while its authenticated WebSocket reconnects', async () => {
    const socket = new FakeSocket();
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
      openWebSocket: vi.fn().mockResolvedValue(socket),
    };
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-connection-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );
    const setupPromise = adapter.setup(setupCallbacks());
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    socket.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setupPromise;
    expect(adapter.isConnected()).toBe(true);

    socket.terminate();

    expect(adapter.isConnected()).toBe(false);
    await adapter.teardown();
  });

  it('forwards only an authenticated removal of this bot as a channel lifecycle event', async () => {
    const socket = new FakeSocket();
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
      openWebSocket: vi.fn().mockResolvedValue(socket),
    };
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );
    const setup = setupCallbacks();
    const setupPromise = adapter.setup(setup);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    socket.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setupPromise;

    socket.emit(
      JSON.stringify({
        event: 'user_removed',
        data: { channel_id: 'channel-a', remover_id: 'owner-user-id' },
        broadcast: { user_id: 'bot-user-id', channel_id: '' },
      }),
    );
    socket.emit(
      JSON.stringify({
        event: 'user_removed',
        data: { channel_id: 'channel-a', remover_id: 'owner-user-id' },
        broadcast: { user_id: 'other-user-id', channel_id: '' },
      }),
    );
    socket.emit(
      JSON.stringify({
        event: 'user_removed',
        data: { channel_id: 'channel-b', user_id: 'bot-user-id' },
        broadcast: { channel_id: 'channel-b' },
      }),
    );

    await vi.waitFor(() => expect(setup.onLifecycle).toHaveBeenCalledOnce());
    expect(setup.onLifecycle).toHaveBeenCalledWith({
      kind: 'bot_removed',
      platformId: 'mattermost:primary:channel-a',
    });
    expect(setup.onInbound).not.toHaveBeenCalled();
  });

  it('waits for accepted inbound routing to settle during teardown', async () => {
    const socket = new FakeSocket();
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
      openWebSocket: vi.fn().mockResolvedValue(socket),
    };
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );
    let releaseInbound: (() => void) | undefined;
    const inboundPending = new Promise<void>((resolve) => {
      releaseInbound = resolve;
    });
    const setup = setupCallbacks(vi.fn(() => inboundPending));
    const setupPromise = adapter.setup(setup);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    socket.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setupPromise;
    socket.emit(
      JSON.stringify({
        event: 'posted',
        data: {
          post: JSON.stringify({
            id: 'post-in-flight',
            channel_id: 'channel-a',
            user_id: 'user-a',
            root_id: '',
            message: 'in flight',
            create_at: 1_700_000_000_000,
          }),
        },
      }),
    );
    await vi.waitFor(() => expect(setup.onInbound).toHaveBeenCalledOnce());

    let teardownComplete = false;
    const teardown = adapter.teardown().then(() => {
      teardownComplete = true;
    });
    await Promise.resolve();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(teardownComplete).toBe(false);

    releaseInbound?.();
    await teardown;
    expect(teardownComplete).toBe(true);
  });

  it('recovers durable channel posts before releasing newer live traffic', async () => {
    const bootstrap = seedActiveMattermostSubscription('channel-a');
    const socket = new FakeSocket();
    let releaseCatchUp: ((response: { status: number; body: unknown }) => void) | undefined;
    const catchUpResponse = new Promise<{ status: number; body: unknown }>((resolve) => {
      releaseCatchUp = resolve;
    });
    const request = vi.fn((input: { url: string }) => {
      if (input.url.endsWith('/api/v4/users/me')) {
        return Promise.resolve({ status: 200, body: { id: 'bot-user-id' } });
      }
      if (input.url.endsWith('/api/v4/users/me/channels?include_deleted=false')) {
        return Promise.resolve(currentMattermostChannels('channel-a'));
      }
      return catchUpResponse;
    });
    const transport: MattermostTransport = {
      request,
      openWebSocket: vi.fn().mockResolvedValue(socket),
    };
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-recovery-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );
    const setup = setupCallbacks(vi.fn().mockResolvedValue(undefined));
    const setupPromise = adapter.setup(setup);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    socket.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('/api/v4/channels/channel-a/posts?per_page=200&skipFetchThreads=true'),
        }),
      ),
    );
    socket.emit(JSON.stringify({ event: 'hello', seq: 0, data: { connection_id: 'connection-a' } }));
    socket.emit(
      JSON.stringify({
        event: 'posted',
        seq: 1,
        data: {
          post: JSON.stringify({
            id: 'post-live',
            channel_id: 'channel-a',
            user_id: 'user-a',
            root_id: '',
            message: 'live',
            create_at: 200,
          }),
        },
      }),
    );
    expect(setup.onInbound).not.toHaveBeenCalled();

    const missedPost = {
      id: 'post-missed',
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: 'missed',
      create_at: 100,
    };
    releaseCatchUp?.({
      status: 200,
      body: {
        order: [missedPost.id, bootstrap.id],
        posts: { [missedPost.id]: missedPost, [bootstrap.id]: bootstrap },
      },
    });
    await setupPromise;
    await vi.waitFor(() => expect(setup.onInbound).toHaveBeenCalledTimes(2));

    expect(setup.onInbound.mock.calls.map(([, , message]) => message.id)).toEqual(['post-missed', 'post-live']);
    await adapter.teardown();
  });

  it('cannot report connected when teardown interrupts startup catch-up', async () => {
    const bootstrap = seedActiveMattermostSubscription('channel-startup-race');
    const socket = new FakeSocket();
    let releaseCatchUp: ((response: { status: number; body: unknown }) => void) | undefined;
    const catchUpResponse = new Promise<{ status: number; body: unknown }>((resolve) => {
      releaseCatchUp = resolve;
    });
    const request = vi.fn((input: { url: string }) => {
      if (input.url.endsWith('/api/v4/users/me')) {
        return Promise.resolve({ status: 200, body: { id: 'bot-user-id' } });
      }
      if (input.url.endsWith('/api/v4/users/me/channels?include_deleted=false')) {
        return Promise.resolve(currentMattermostChannels('channel-startup-race'));
      }
      return catchUpResponse;
    });
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-startup-race-fixture-credential',
        instanceKey: 'primary',
      },
      { request, openWebSocket: vi.fn().mockResolvedValue(socket) },
    );
    const setup = adapter.setup(setupCallbacks());
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    socket.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining(
            '/api/v4/channels/channel-startup-race/posts?per_page=200&skipFetchThreads=true',
          ),
        }),
      ),
    );

    const setupOutcome = expect(setup).rejects.toThrow('Mattermost adapter setup cancelled');
    const teardown = adapter.teardown();
    releaseCatchUp?.({
      status: 200,
      body: { order: [bootstrap.id], posts: { [bootstrap.id]: bootstrap } },
    });

    await Promise.all([setupOutcome, teardown]);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(adapter.isConnected()).toBe(false);
  });

  it('remains unavailable when the authenticated socket closes during startup recovery', async () => {
    const bootstrap = seedActiveMattermostSubscription('channel-startup-disconnect');
    const socket = new FakeSocket();
    let releaseCatchUp: ((response: { status: number; body: unknown }) => void) | undefined;
    const catchUpResponse = new Promise<{ status: number; body: unknown }>((resolve) => {
      releaseCatchUp = resolve;
    });
    const request = vi.fn((input: { url: string }) => {
      if (input.url.endsWith('/api/v4/users/me')) {
        return Promise.resolve({ status: 200, body: { id: 'bot-user-id' } });
      }
      if (input.url.endsWith('/api/v4/users/me/channels?include_deleted=false')) {
        return Promise.resolve(currentMattermostChannels('channel-startup-disconnect'));
      }
      return catchUpResponse;
    });
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-startup-disconnect-fixture-credential',
        instanceKey: 'primary',
      },
      { request, openWebSocket: vi.fn().mockResolvedValue(socket) },
    );
    const setupPromise = adapter.setup(setupCallbacks());
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    socket.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));

    socket.terminate();
    releaseCatchUp?.({
      status: 200,
      body: { order: [bootstrap.id], posts: { [bootstrap.id]: bootstrap } },
    });
    await setupPromise;

    expect(adapter.isConnected()).toBe(false);
    await adapter.teardown();
  });

  it('settles a pre-initialization sequence-gap hook when teardown cancels setup', async () => {
    const socket = new FakeSocket();
    const request = vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } });
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-pre-init-gap-fixture-credential',
        instanceKey: 'primary',
      },
      { request, openWebSocket: vi.fn().mockResolvedValue(socket) },
    );
    const setupPromise = adapter.setup(setupCallbacks());
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());

    socket.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    socket.emit(JSON.stringify({ event: 'typing', seq: 2, data: {}, broadcast: { channel_id: 'channel-a' } }));
    await Promise.resolve();
    let teardownSettled = false;
    const teardown = adapter.teardown().then(() => {
      teardownSettled = true;
    });

    await expect(setupPromise).rejects.toThrow('Mattermost adapter setup cancelled');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(teardownSettled).toBe(true);
    await teardown;
    expect(request).toHaveBeenCalledOnce();
    expect(adapter.isConnected()).toBe(false);
  });

  it('fails setup closed when the durable recovery watermark cannot be proven', async () => {
    seedActiveMattermostSubscription('channel-a');
    advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-missing-from-history',
    });
    const socket = new FakeSocket();
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-unproven-watermark-fixture-credential',
        instanceKey: 'primary',
      },
      {
        request: vi.fn((input: { url: string }) => {
          if (input.url.endsWith('/api/v4/users/me')) {
            return Promise.resolve({ status: 200, body: { id: 'bot-user-id' } });
          }
          if (input.url.endsWith('/api/v4/users/me/channels?include_deleted=false')) {
            return Promise.resolve(currentMattermostChannels('channel-a'));
          }
          return Promise.resolve({ status: 200, body: { order: [], posts: {} } });
        }),
        openWebSocket: vi.fn().mockResolvedValue(socket),
      },
    );
    const setup = adapter.setup(setupCallbacks());
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    socket.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));

    await expect(setup).rejects.toThrow('Mattermost catch-up durable watermark was not found');
    await Promise.resolve();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(adapter.isConnected()).toBe(false);
  });

  it('tears down authenticated transport when post-auth initialization fails', async () => {
    const socket = new FakeSocket();
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-post-auth-failure-fixture-credential',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
        openWebSocket: vi.fn().mockResolvedValue(socket),
      },
    );
    const setupPromise = adapter.setup(setupCallbacks());
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    closeDb();

    socket.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await expect(setupPromise).rejects.toThrow('Database not initialized');
    const closeCallsBeforeExplicitTeardown = socket.close.mock.calls.length;
    await adapter.teardown();

    expect(closeCallsBeforeExplicitTeardown).toBe(1);
    expect(adapter.isConnected()).toBe(false);
  });

  it('releases crash-left processing receipts before startup catch-up', async () => {
    const bootstrap = seedActiveMattermostSubscription('channel-a');
    const post = {
      id: 'post-crash-left-processing',
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: 'recover after restart',
      create_at: 150,
    };
    const frame = JSON.stringify({ event: 'posted', data: { post: JSON.stringify(post) } });
    const normalized = normalizeMattermostPayload(frame, { instanceKey: 'primary', botUserId: 'bot-user-id' });
    if (normalized.kind !== 'accepted') throw new Error('Recovery fixture did not normalize');
    claimMattermostPostReceipt({
      instanceKey: normalized.diagnostics.instanceKey,
      postId: normalized.diagnostics.postId,
      channelId: normalized.diagnostics.channelId,
      createAt: normalized.diagnostics.createAt,
      payloadDigest: normalized.diagnostics.payloadDigest,
    });
    const socket = new FakeSocket();
    const transport: MattermostTransport = {
      request: vi.fn((input: { url: string }) => {
        if (input.url.endsWith('/api/v4/users/me')) {
          return Promise.resolve({ status: 200, body: { id: 'bot-user-id' } });
        }
        if (input.url.endsWith('/api/v4/users/me/channels?include_deleted=false')) {
          return Promise.resolve(currentMattermostChannels('channel-a'));
        }
        return Promise.resolve({
          status: 200,
          body: { order: [post.id, bootstrap.id], posts: { [post.id]: post, [bootstrap.id]: bootstrap } },
        });
      }),
      openWebSocket: vi.fn().mockResolvedValue(socket),
    };
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-processing-reset-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );
    const setup = setupCallbacks(vi.fn().mockResolvedValue(undefined));
    const setupPromise = adapter.setup(setup);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    socket.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setupPromise;

    expect(setup.onInbound).toHaveBeenCalledOnce();
    expect(setup.onInbound.mock.calls[0][2]).toMatchObject({ id: post.id });
    await adapter.teardown();
  });

  it('drains earlier channel routing before starting a sequence-gap catch-up', async () => {
    const bootstrap = seedActiveMattermostSubscription('channel-a');
    const socket = new FakeSocket();
    let catchUpCall = 0;
    const request = vi.fn((input: { url: string }) => {
      if (input.url.endsWith('/api/v4/users/me')) {
        return Promise.resolve({ status: 200, body: { id: 'bot-user-id' } });
      }
      if (input.url.endsWith('/api/v4/users/me/channels?include_deleted=false')) {
        return Promise.resolve(currentMattermostChannels('channel-a'));
      }
      catchUpCall += 1;
      if (catchUpCall === 1) {
        return Promise.resolve({
          status: 200,
          body: { order: [bootstrap.id], posts: { [bootstrap.id]: bootstrap } },
        });
      }
      const watermark = {
        id: 'post-before-gap',
        channel_id: 'channel-a',
        user_id: 'user-a',
        root_id: '',
        message: 'post-before-gap',
        create_at: 101,
      };
      return Promise.resolve({
        status: 200,
        body: { order: [watermark.id], posts: { [watermark.id]: watermark } },
      });
    });
    const transport: MattermostTransport = {
      request,
      openWebSocket: vi.fn().mockResolvedValue(socket),
    };
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-gap-drain-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );
    let releaseFirstPost: (() => void) | undefined;
    const firstPostPending = new Promise<void>((resolve) => {
      releaseFirstPost = resolve;
    });
    const setup = setupCallbacks(
      vi.fn((_platformId: string, _threadId: string | null, message: { id: string }) =>
        message.id === 'post-before-gap' ? firstPostPending : Promise.resolve(),
      ),
    );
    const setupPromise = adapter.setup(setup);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    socket.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setupPromise;
    expect(request).toHaveBeenCalledTimes(3);
    socket.emit(JSON.stringify({ event: 'hello', seq: 0, data: { connection_id: 'connection-a' } }));
    const post = (id: string, seq: number) =>
      JSON.stringify({
        event: 'posted',
        seq,
        data: {
          post: JSON.stringify({
            id,
            channel_id: 'channel-a',
            user_id: 'user-a',
            root_id: '',
            message: id,
            create_at: 100 + seq,
          }),
        },
      });
    socket.emit(post('post-before-gap', 1));
    await vi.waitFor(() => expect(setup.onInbound).toHaveBeenCalledOnce());

    socket.emit(post('post-after-gap', 3));
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(3);

    releaseFirstPost?.();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(5));
    await vi.waitFor(() => expect(setup.onInbound).toHaveBeenCalledTimes(2));
    expect(setup.onInbound.mock.calls.map(([, , message]) => message.id)).toEqual([
      'post-before-gap',
      'post-after-gap',
    ]);
    await adapter.teardown();
  });

  it('waits for in-flight catch-up work during teardown', async () => {
    const bootstrap = seedActiveMattermostSubscription('channel-a');
    const socket = new FakeSocket();
    let catchUpCall = 0;
    let releaseRuntimeCatchUp: ((response: { status: number; body: unknown }) => void) | undefined;
    const runtimeCatchUp = new Promise<{ status: number; body: unknown }>((resolve) => {
      releaseRuntimeCatchUp = resolve;
    });
    const request = vi.fn((input: { url: string }) => {
      if (input.url.endsWith('/api/v4/users/me')) {
        return Promise.resolve({ status: 200, body: { id: 'bot-user-id' } });
      }
      if (input.url.endsWith('/api/v4/users/me/channels?include_deleted=false')) {
        return Promise.resolve(currentMattermostChannels('channel-a'));
      }
      catchUpCall += 1;
      return catchUpCall === 1
        ? Promise.resolve({
            status: 200,
            body: { order: [bootstrap.id], posts: { [bootstrap.id]: bootstrap } },
          })
        : runtimeCatchUp;
    });
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-teardown-catchup-fixture-credential',
        instanceKey: 'primary',
      },
      { request, openWebSocket: vi.fn().mockResolvedValue(socket) },
    );
    const setup = setupCallbacks(vi.fn().mockResolvedValue(undefined));
    const setupPromise = adapter.setup(setup);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    socket.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setupPromise;
    socket.emit(JSON.stringify({ event: 'hello', seq: 0, data: { connection_id: 'connection-a' } }));
    socket.emit(
      JSON.stringify({
        event: 'posted',
        seq: 2,
        data: {
          post: JSON.stringify({
            id: 'post-triggering-gap',
            channel_id: 'channel-a',
            user_id: 'user-a',
            root_id: '',
            message: 'trigger gap',
            create_at: 300,
          }),
        },
      }),
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(5));

    let teardownComplete = false;
    const teardown = adapter.teardown().then(() => {
      teardownComplete = true;
    });
    await Promise.resolve();
    expect(teardownComplete).toBe(false);

    const missedPost = {
      id: 'post-caught-during-teardown',
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: 'finish durably',
      create_at: 250,
    };
    releaseRuntimeCatchUp?.({
      status: 200,
      body: {
        order: [missedPost.id, bootstrap.id],
        posts: { [missedPost.id]: missedPost, [bootstrap.id]: bootstrap },
      },
    });
    await teardown;

    expect(setup.onInbound).toHaveBeenCalledOnce();
    expect(setup.onInbound.mock.calls[0][2]).toMatchObject({ id: missedPost.id });
  });

  it('waits for gap recovery still blocked behind earlier ingress during teardown', async () => {
    const bootstrap = seedActiveMattermostSubscription('channel-a');
    const socket = new FakeSocket();
    let catchUpCall = 0;
    let releaseRuntimeCatchUp: ((response: { status: number; body: unknown }) => void) | undefined;
    const runtimeCatchUp = new Promise<{ status: number; body: unknown }>((resolve) => {
      releaseRuntimeCatchUp = resolve;
    });
    const request = vi.fn((input: { url: string }) => {
      if (input.url.endsWith('/api/v4/users/me')) {
        return Promise.resolve({ status: 200, body: { id: 'bot-user-id' } });
      }
      if (input.url.endsWith('/api/v4/users/me/channels?include_deleted=false')) {
        return Promise.resolve(currentMattermostChannels('channel-a'));
      }
      catchUpCall += 1;
      return catchUpCall === 1
        ? Promise.resolve({
            status: 200,
            body: { order: [bootstrap.id], posts: { [bootstrap.id]: bootstrap } },
          })
        : runtimeCatchUp;
    });
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-pre-drain-teardown-fixture-credential',
        instanceKey: 'primary',
      },
      { request, openWebSocket: vi.fn().mockResolvedValue(socket) },
    );
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const setup = setupCallbacks(
      vi.fn((_platformId: string, _threadId: string | null, message: { id: string }) =>
        message.id === 'post-before-pre-drain-gap' ? firstPending : Promise.resolve(),
      ),
    );
    const setupPromise = adapter.setup(setup);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    socket.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setupPromise;
    socket.emit(JSON.stringify({ event: 'hello', seq: 0, data: { connection_id: 'connection-a' } }));
    const post = (id: string, seq: number, createAt: number) =>
      JSON.stringify({
        event: 'posted',
        seq,
        data: {
          post: JSON.stringify({
            id,
            channel_id: 'channel-a',
            user_id: 'user-a',
            root_id: '',
            message: id,
            create_at: createAt,
          }),
        },
      });
    socket.emit(post('post-before-pre-drain-gap', 1, 101));
    await vi.waitFor(() => expect(setup.onInbound).toHaveBeenCalledOnce());
    socket.emit(post('post-triggering-pre-drain-gap', 3, 103));
    await Promise.resolve();

    let teardownComplete = false;
    const teardown = adapter.teardown().then(() => {
      teardownComplete = true;
    });
    releaseFirst?.();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(5));
    await Promise.resolve();
    expect(teardownComplete).toBe(false);

    const watermark = {
      id: 'post-before-pre-drain-gap',
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: 'post-before-pre-drain-gap',
      create_at: 101,
    };
    const missed = {
      id: 'post-missed-before-teardown',
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: 'post-missed-before-teardown',
      create_at: 102,
    };
    releaseRuntimeCatchUp?.({
      status: 200,
      body: { order: [missed.id, watermark.id], posts: { [missed.id]: missed, [watermark.id]: watermark } },
    });
    await teardown;

    expect(setup.onInbound.mock.calls.map(([, , message]) => message.id)).toEqual([watermark.id, missed.id]);
    expect(listActiveMattermostRecoveryChannels('primary')).toEqual([
      { channelId: 'channel-a', lastPostCreatedAt: missed.create_at, lastPostId: missed.id },
    ]);
  });

  it('forwards a channel rename using only the stable channel identity', async () => {
    const bootstrap = seedActiveMattermostSubscription('channel-a');
    const socket = new FakeSocket();
    const transport: MattermostTransport = {
      request: vi.fn((input: { url: string }) => {
        if (input.url.endsWith('/api/v4/users/me')) {
          return Promise.resolve({ status: 200, body: { id: 'bot-user-id' } });
        }
        if (input.url.endsWith('/api/v4/users/me/channels?include_deleted=false')) {
          return Promise.resolve(currentMattermostChannels('channel-a'));
        }
        return Promise.resolve({ status: 200, body: { order: [bootstrap.id], posts: { [bootstrap.id]: bootstrap } } });
      }),
      openWebSocket: vi.fn().mockResolvedValue(socket),
    };
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-rename-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );
    const setup = setupCallbacks();
    const setupPromise = adapter.setup(setup);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    socket.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setupPromise;
    setup.onMetadata.mockClear();

    socket.emit(
      JSON.stringify({
        event: 'channel_updated',
        seq: 0,
        data: {
          channel: JSON.stringify({ id: 'channel-a', name: 'renamed-channel', display_name: 'Renamed Channel' }),
        },
        broadcast: { channel_id: 'channel-a' },
      }),
    );

    await vi.waitFor(() => expect(setup.onMetadata).toHaveBeenCalledOnce());
    expect(setup.onMetadata).toHaveBeenCalledWith('mattermost:primary:channel-a', 'Renamed Channel', true);
    expect(
      getDb()
        .prepare(
          `SELECT ms.channel_id, ms.messaging_group_id, ms.agent_group_id, ms.wiring_id,
                  mg.platform_id, ag.folder
             FROM mattermost_subscriptions ms
             JOIN messaging_groups mg ON mg.id = ms.messaging_group_id
             JOIN agent_groups ag ON ag.id = ms.agent_group_id
            WHERE ms.instance_key = 'primary' AND ms.channel_id = 'channel-a'`,
        )
        .get(),
    ).toEqual({
      channel_id: 'channel-a',
      messaging_group_id: 'mg-recovery',
      agent_group_id: 'ag-recovery',
      wiring_id: 'mga-recovery',
      platform_id: 'mattermost:primary:channel-a',
      folder: 'recovery-agent',
    });
    await adapter.teardown();
  });

  it('reconciles a missed channel rename before releasing the gap-triggering post', async () => {
    const bootstrap = seedActiveMattermostSubscription('channel-a');
    const socket = new FakeSocket();
    let displayName = 'Recovery channel';
    const request = vi.fn((input: { url: string }) => {
      if (input.url.endsWith('/api/v4/users/me')) {
        return Promise.resolve({ status: 200, body: { id: 'bot-user-id' } });
      }
      if (input.url.endsWith('/api/v4/users/me/channels?include_deleted=false')) {
        return Promise.resolve({
          status: 200,
          body: [{ id: 'channel-a', name: 'recovery-channel', display_name: displayName, type: 'O', delete_at: 0 }],
        });
      }
      return Promise.resolve({
        status: 200,
        body: { order: [bootstrap.id], posts: { [bootstrap.id]: bootstrap } },
      });
    });
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-missed-rename-fixture-credential',
        instanceKey: 'primary',
      },
      { request, openWebSocket: vi.fn().mockResolvedValue(socket) },
    );
    const callbackOrder: string[] = [];
    const setup = setupCallbacks(
      vi.fn().mockImplementation(() => {
        callbackOrder.push('post');
        return Promise.resolve();
      }),
    );
    setup.onMetadata.mockImplementation(() => {
      callbackOrder.push('metadata');
    });
    const setupPromise = adapter.setup(setup);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    socket.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setupPromise;
    callbackOrder.length = 0;
    setup.onMetadata.mockClear();

    socket.emit(JSON.stringify({ event: 'hello', seq: 0, data: { connection_id: 'connection-a' } }));
    await Promise.resolve();
    displayName = 'Renamed while disconnected';
    socket.emit(
      JSON.stringify({
        event: 'posted',
        seq: 2,
        data: {
          post: JSON.stringify({
            id: 'post-after-missed-rename',
            channel_id: 'channel-a',
            user_id: 'user-a',
            root_id: '',
            message: 'release only after metadata reconciliation',
            create_at: 2,
          }),
        },
      }),
    );

    await vi.waitFor(() => expect(setup.onInbound).toHaveBeenCalledOnce());
    expect(setup.onMetadata).toHaveBeenCalledWith('mattermost:primary:channel-a', 'Renamed while disconnected', true);
    expect(callbackOrder).toEqual(['metadata', 'post']);
    expect(request.mock.calls.map(([input]) => input.url)).toContain(
      'https://mattermost.example.test/api/v4/users/me/channels?include_deleted=false',
    );
    await adapter.teardown();
  });

  it('reconciles a missed bot removal before declaring the sequence gap recovered', async () => {
    const bootstrap = seedActiveMattermostSubscription('channel-a');
    const socket = new FakeSocket();
    let botIsMember = true;
    const request = vi.fn((input: { url: string }) => {
      if (input.url.endsWith('/api/v4/users/me')) {
        return Promise.resolve({ status: 200, body: { id: 'bot-user-id' } });
      }
      if (input.url.endsWith('/api/v4/users/me/channels?include_deleted=false')) {
        return Promise.resolve(botIsMember ? currentMattermostChannels('channel-a') : { status: 200, body: [] });
      }
      return Promise.resolve({
        status: 200,
        body: { order: [bootstrap.id], posts: { [bootstrap.id]: bootstrap } },
      });
    });
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-missed-removal-fixture-credential',
        instanceKey: 'primary',
      },
      { request, openWebSocket: vi.fn().mockResolvedValue(socket) },
    );
    const setup = setupCallbacks();
    const setupPromise = adapter.setup(setup);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    socket.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setupPromise;
    setup.onLifecycle.mockClear();

    socket.emit(JSON.stringify({ event: 'hello', seq: 0, data: { connection_id: 'connection-a' } }));
    await Promise.resolve();
    botIsMember = false;
    socket.emit(JSON.stringify({ event: 'typing', seq: 2, data: {}, broadcast: { channel_id: 'channel-a' } }));

    await vi.waitFor(() => expect(setup.onLifecycle).toHaveBeenCalledOnce());
    expect(setup.onLifecycle).toHaveBeenCalledWith({
      kind: 'bot_removed',
      platformId: 'mattermost:primary:channel-a',
    });
    await adapter.teardown();
  });

  it('waits for an in-flight current-state callback during teardown', async () => {
    const bootstrap = seedActiveMattermostSubscription('channel-a');
    const socket = new FakeSocket();
    let stateRequestCount = 0;
    const request = vi.fn((input: { url: string }) => {
      if (input.url.endsWith('/api/v4/users/me')) {
        return Promise.resolve({ status: 200, body: { id: 'bot-user-id' } });
      }
      if (input.url.endsWith('/api/v4/users/me/channels?include_deleted=false')) {
        stateRequestCount += 1;
        return Promise.resolve(
          currentMattermostChannels(
            'channel-a',
            stateRequestCount === 1 ? 'Recovery channel' : 'Renamed during teardown',
          ),
        );
      }
      return Promise.resolve({
        status: 200,
        body: { order: [bootstrap.id], posts: { [bootstrap.id]: bootstrap } },
      });
    });
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-state-teardown-fixture-credential',
        instanceKey: 'primary',
      },
      { request, openWebSocket: vi.fn().mockResolvedValue(socket) },
    );
    let releaseMetadata: (() => void) | undefined;
    const pendingMetadata = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    const setup = setupCallbacks();
    setup.onMetadata.mockImplementation((_platformId, name) =>
      name === 'Renamed during teardown' ? pendingMetadata : undefined,
    );
    const setupPromise = adapter.setup(setup);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    socket.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setupPromise;

    socket.emit(JSON.stringify({ event: 'hello', seq: 0, data: { connection_id: 'connection-a' } }));
    socket.emit(JSON.stringify({ event: 'typing', seq: 2, data: {}, broadcast: { channel_id: 'channel-a' } }));
    await vi.waitFor(() =>
      expect(setup.onMetadata).toHaveBeenCalledWith('mattermost:primary:channel-a', 'Renamed during teardown', true),
    );

    let teardownComplete = false;
    const teardown = adapter.teardown().then(() => {
      teardownComplete = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(teardownComplete).toBe(false);

    releaseMetadata?.();
    await teardown;
    expect(teardownComplete).toBe(true);
  });

  it('orders bot removal behind earlier accepted work in the same channel', async () => {
    const socket = new FakeSocket();
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
      openWebSocket: vi.fn().mockResolvedValue(socket),
    };
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );
    let releasePost: (() => void) | undefined;
    const postPending = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    const order: string[] = [];
    const setup = setupCallbacks(
      vi.fn(async () => {
        order.push('post');
        await postPending;
      }),
    );
    setup.onLifecycle.mockImplementation(() => {
      order.push('removed');
    });
    const setupPromise = adapter.setup(setup);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    socket.emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setupPromise;
    socket.emit(
      JSON.stringify({
        event: 'posted',
        seq: 0,
        data: {
          post: JSON.stringify({
            id: 'post-before-removal',
            channel_id: 'channel-a',
            user_id: 'user-a',
            root_id: '',
            message: 'before removal',
            create_at: 1_700_000_000_000,
          }),
        },
      }),
    );
    socket.emit(
      JSON.stringify({
        event: 'user_removed',
        seq: 1,
        data: { channel_id: 'channel-a' },
        broadcast: { user_id: 'bot-user-id', channel_id: '' },
      }),
    );
    await vi.waitFor(() => expect(setup.onInbound).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(order).toEqual(['post']);

    releasePost?.();
    await vi.waitFor(() => expect(setup.onLifecycle).toHaveBeenCalledOnce());
    expect(order).toEqual(['post', 'removed']);
    await adapter.teardown();
  });

  it('delivers the shared-session reply with its per-message Mattermost root id', async () => {
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 201, body: { id: 'mattermost-reply-id' } }),
      openWebSocket: vi.fn(),
    };
    const adapter = createMattermostAdapter(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'adapter-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );

    await expect(
      adapter.deliver('mattermost:primary:channel-a', 'root-post-id', {
        kind: 'chat',
        content: { text: 'Shared context, threaded reply' },
        deliveryId: 'shared-session-outbox-id',
      }),
    ).resolves.toBe('mattermost-reply-id');

    const request = vi.mocked(transport.request).mock.calls[0][0];
    expect(JSON.parse(request.body ?? '{}')).toMatchObject({
      channel_id: 'channel-a',
      root_id: 'root-post-id',
      message: 'Shared context, threaded reply',
    });
  });
});
