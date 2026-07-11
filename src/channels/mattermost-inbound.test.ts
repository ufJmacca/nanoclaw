import { describe, expect, it, vi } from 'vitest';

import { MattermostClient, type MattermostTransport } from './mattermost-client.js';
import { MattermostInboundProcessor, type MattermostInboundLogger } from './mattermost-inbound.js';

function postedEvent(postOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: 'posted',
    data: {
      sender_name: 'Ada',
      post: JSON.stringify({
        id: 'post-id',
        channel_id: 'channel-id',
        user_id: 'user-id',
        root_id: '',
        message: 'Hello from Mattermost',
        create_at: 1_700_000_000_000,
        ...postOverrides,
      }),
    },
  });
}

describe('MattermostInboundProcessor', () => {
  it('turns one posted event into one NanoClaw inbound message', async () => {
    const onInbound = vi.fn();
    const processor = new MattermostInboundProcessor({ instanceKey: 'primary', botUserId: 'bot-user-id' }, onInbound);

    await processor.handle(postedEvent());

    expect(onInbound).toHaveBeenCalledOnce();
    expect(JSON.parse(onInbound.mock.calls[0][0].message.content)).toMatchObject({
      sender: 'Ada',
      text: 'Hello from Mattermost',
    });
  });

  it('namespaces channel identity by Mattermost instance and channel id', async () => {
    const primaryInbound = vi.fn();
    const secondaryInbound = vi.fn();

    await new MattermostInboundProcessor({ instanceKey: 'primary', botUserId: 'bot-user-id' }, primaryInbound).handle(
      postedEvent(),
    );
    await new MattermostInboundProcessor(
      { instanceKey: 'secondary', botUserId: 'bot-user-id' },
      secondaryInbound,
    ).handle(postedEvent());

    expect(primaryInbound.mock.calls[0][0].platformId).toBe('mattermost:primary:channel-id');
    expect(secondaryInbound.mock.calls[0][0].platformId).toBe('mattermost:secondary:channel-id');
    expect(primaryInbound.mock.calls[0][0].platformId).not.toBe(secondaryInbound.mock.calls[0][0].platformId);
  });

  it('uses a stable Mattermost sender id independent of display name', async () => {
    const onInbound = vi.fn();
    const processor = new MattermostInboundProcessor({ instanceKey: 'primary', botUserId: 'bot-user-id' }, onInbound);

    await processor.handle(postedEvent());

    expect(JSON.parse(onInbound.mock.calls[0][0].message.content)).toMatchObject({
      sender: 'Ada',
      senderId: 'mattermost:user-id',
    });
  });

  it('retains the Mattermost post id as the external message id', async () => {
    const onInbound = vi.fn();
    const processor = new MattermostInboundProcessor({ instanceKey: 'primary', botUserId: 'bot-user-id' }, onInbound);

    await processor.handle(postedEvent());

    expect(onInbound.mock.calls[0][0].message.id).toBe('post-id');
  });

  it('retains root_id as delivery metadata for thread replies', async () => {
    const onInbound = vi.fn();
    const processor = new MattermostInboundProcessor({ instanceKey: 'primary', botUserId: 'bot-user-id' }, onInbound);

    await processor.handle(postedEvent({ root_id: 'root-post-id' }));

    expect(onInbound.mock.calls[0][0].threadId).toBe('root-post-id');
  });

  it('trusts only authenticated WebSocket mention metadata for the bot mention signal', async () => {
    const mentionStates: boolean[] = [];
    for (const mentions of ['["bot-user-id"]', '["other-user-id"]', '{malformed']) {
      const onInbound = vi.fn();
      const processor = new MattermostInboundProcessor({ instanceKey: 'primary', botUserId: 'bot-user-id' }, onInbound);
      const envelope = JSON.parse(postedEvent({ id: `post-${mentionStates.length}` })) as {
        data: Record<string, unknown>;
      };
      envelope.data.mentions = mentions;

      await processor.handle(JSON.stringify(envelope));
      mentionStates.push(onInbound.mock.calls[0][0].message.isMention as boolean);
    }

    expect(mentionStates).toEqual([true, false, false]);
  });

  it('ignores posts authored by the authenticated bot user', async () => {
    const onInbound = vi.fn();
    const processor = new MattermostInboundProcessor({ instanceKey: 'primary', botUserId: 'bot-user-id' }, onInbound);

    await processor.handle(postedEvent({ user_id: 'bot-user-id' }));

    expect(onInbound).not.toHaveBeenCalled();
  });

  it('processes concurrent duplicate post events exactly once', async () => {
    const onInbound = vi.fn().mockResolvedValue(undefined);
    const processor = new MattermostInboundProcessor({ instanceKey: 'primary', botUserId: 'bot-user-id' }, onInbound);
    const payload = postedEvent();

    await Promise.all([processor.handle(payload), processor.handle(payload)]);

    expect(onInbound).toHaveBeenCalledOnce();
  });

  it('rejects malformed envelope and nested post JSON without throwing', async () => {
    const onInbound = vi.fn();
    const processor = new MattermostInboundProcessor({ instanceKey: 'primary', botUserId: 'bot-user-id' }, onInbound);

    await expect(processor.handle('{')).resolves.toBe(false);
    await expect(
      processor.handle(JSON.stringify({ event: 'posted', data: { sender_name: 'Ada', post: '{' } })),
    ).resolves.toBe(false);
    expect(onInbound).not.toHaveBeenCalled();
  });

  it('ignores unsupported WebSocket event types', async () => {
    const onInbound = vi.fn();
    const processor = new MattermostInboundProcessor({ instanceKey: 'primary', botUserId: 'bot-user-id' }, onInbound);
    const unsupported = { ...JSON.parse(postedEvent()), event: 'typing' };

    await expect(processor.handle(JSON.stringify(unsupported))).resolves.toBe(false);
    expect(onInbound).not.toHaveBeenCalled();
  });

  it('rejects posted events with missing or invalid required fields', async () => {
    const invalidPosts: Array<(post: Record<string, unknown>) => void> = [
      (post) => delete post.id,
      (post) => {
        post.channel_id = '';
      },
      (post) => {
        post.user_id = 42;
      },
      (post) => {
        post.root_id = 42;
      },
      (post) => {
        post.message = null;
      },
      (post) => {
        post.create_at = 'not-a-timestamp';
      },
    ];

    for (const invalidate of invalidPosts) {
      const onInbound = vi.fn();
      const processor = new MattermostInboundProcessor({ instanceKey: 'primary', botUserId: 'bot-user-id' }, onInbound);
      const envelope = JSON.parse(postedEvent()) as { data: { post: string } };
      const post = JSON.parse(envelope.data.post) as Record<string, unknown>;
      invalidate(post);
      envelope.data.post = JSON.stringify(post);

      await expect(processor.handle(JSON.stringify(envelope))).resolves.toBe(false);
      expect(onInbound).not.toHaveBeenCalled();
    }
  });

  it('rejects oversized events before invoking the sink', async () => {
    const onInbound = vi.fn();
    const processor = new MattermostInboundProcessor(
      { instanceKey: 'primary', botUserId: 'bot-user-id', maxPayloadBytes: 64 },
      onInbound,
    );

    await expect(processor.handle(postedEvent({ message: 'x'.repeat(128) }))).resolves.toBe(false);
    expect(onInbound).not.toHaveBeenCalled();
  });

  it('fails closed when broadcast and post channel identities disagree', async () => {
    const onInbound = vi.fn();
    const processor = new MattermostInboundProcessor({ instanceKey: 'primary', botUserId: 'bot-user-id' }, onInbound);
    const envelope = JSON.parse(postedEvent()) as Record<string, unknown>;
    envelope.broadcast = { channel_id: 'different-channel-id' };

    await expect(processor.handle(JSON.stringify(envelope))).resolves.toBe(false);
    expect(onInbound).not.toHaveBeenCalled();
  });

  it('rejects ambiguous Mattermost instance keys before processing', () => {
    expect(
      () => new MattermostInboundProcessor({ instanceKey: 'primary:shadow', botUserId: 'bot-user-id' }, vi.fn()),
    ).toThrow('Invalid Mattermost instance key');
  });

  it('logs diagnostic metadata without full message content', async () => {
    const logger: MattermostInboundLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const processor = new MattermostInboundProcessor(
      { instanceKey: 'primary', botUserId: 'bot-user-id' },
      vi.fn(),
      logger,
    );
    const privateContent = 'private-message-content-fixture';

    await processor.handle(postedEvent({ message: privateContent }));

    expect(logger.info).toHaveBeenCalledOnce();
    const renderedLog = JSON.stringify((logger.info as ReturnType<typeof vi.fn>).mock.calls);
    expect(renderedLog).toContain('post-id');
    expect(renderedLog).toContain('channel-id');
    expect(renderedLog).toContain('mattermost:user-id');
    expect(renderedLog).not.toContain(privateContent);
  });

  it('routes an authenticated fake WebSocket post through the inbound processor', async () => {
    const listeners = new Set<(payload: string) => void>();
    const socket = {
      send: vi.fn(),
      close: vi.fn(),
      onMessage: vi.fn((listener: (payload: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    };
    const emit = (payload: string) => {
      for (const listener of [...listeners]) listener(payload);
    };
    const transport: MattermostTransport = {
      request: vi.fn().mockResolvedValue({ status: 200, body: { id: 'bot-user-id' } }),
      openWebSocket: vi.fn().mockResolvedValue(socket),
    };
    const onInbound = vi.fn();
    const client = new MattermostClient(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'integration-fixture-credential',
        instanceKey: 'primary',
      },
      transport,
    );
    let processor: MattermostInboundProcessor | undefined;

    const setup = client.setup((payload, context) => {
      processor ??= new MattermostInboundProcessor({ instanceKey: 'primary', botUserId: context.botUserId }, onInbound);
      void processor.handle(payload);
    });
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    emit(JSON.stringify({ status: 'OK', seq_reply: 1 }));
    await setup;
    emit(postedEvent());

    await vi.waitFor(() => expect(onInbound).toHaveBeenCalledOnce());
    expect(onInbound.mock.calls[0][0]).toMatchObject({
      platformId: 'mattermost:primary:channel-id',
      threadId: null,
      message: { id: 'post-id' },
    });
    expect(JSON.stringify(onInbound.mock.calls)).not.toContain('integration-fixture-credential');
    client.teardown();
  });
});
