import { describe, expect, it, vi } from 'vitest';

import { createMattermostAdapter } from './mattermost-adapter.js';
import { getChannelContainerConfig, getRegisteredChannelNames } from './channel-registry.js';
import type { MattermostTransport, MattermostWebSocket } from './mattermost-client.js';

class FakeSocket implements MattermostWebSocket {
  readonly send = vi.fn();
  readonly close = vi.fn();
  private readonly listeners = new Set<(payload: string) => void>();

  onMessage(listener: (payload: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(payload: string): void {
    for (const listener of this.listeners) listener(payload);
  }
}

function fakeTransport(): MattermostTransport {
  return {
    request: vi.fn(),
    openWebSocket: vi.fn(),
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
