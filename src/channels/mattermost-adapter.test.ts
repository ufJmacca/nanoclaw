import { describe, expect, it, vi } from 'vitest';

import { createMattermostAdapter } from './mattermost-adapter.js';
import { getRegisteredChannelNames } from './channel-registry.js';
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
  };
}

describe('Mattermost channel adapter assembly', () => {
  it('stays unregistered until strict subscription validation is available', () => {
    expect(getRegisteredChannelNames()).not.toContain('mattermost');
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
