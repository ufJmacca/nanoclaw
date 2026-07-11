import { describe, expect, it, vi } from 'vitest';

import { MattermostClient, type MattermostTransport } from './mattermost-client.js';
import { MattermostInboundProcessor, type MattermostInboundLogger } from './mattermost-inbound.js';
import * as inboundModule from './mattermost-inbound.js';

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

  it('releases a post receipt when its sink fails so catch-up can retry it', async () => {
    const onInbound = vi
      .fn()
      .mockRejectedValueOnce(new Error('injected routing failure'))
      .mockResolvedValueOnce(undefined);
    const processor = new MattermostInboundProcessor({ instanceKey: 'primary', botUserId: 'bot-user-id' }, onInbound);
    const payload = postedEvent({ id: 'post-retry-after-failure' });

    await expect(processor.handle(payload)).rejects.toThrow('injected routing failure');
    await expect(processor.handle(payload)).resolves.toBe(true);

    expect(onInbound).toHaveBeenCalledTimes(2);
  });

  it('preserves per-channel order without blocking a different channel', async () => {
    let releaseFirstA: (() => void) | undefined;
    const firstA = new Promise<void>((resolve) => {
      releaseFirstA = resolve;
    });
    const started: string[] = [];
    const onInbound = vi.fn(async (event: { message: { id?: string } }) => {
      started.push(event.message.id ?? 'missing');
      if (event.message.id === 'post-a-1') await firstA;
    });
    const processor = new MattermostInboundProcessor({ instanceKey: 'primary', botUserId: 'bot-user-id' }, onInbound);

    const processingA1 = processor.handle(postedEvent({ id: 'post-a-1', channel_id: 'channel-a' }));
    const processingA2 = processor.handle(postedEvent({ id: 'post-a-2', channel_id: 'channel-a' }));
    const processingB1 = processor.handle(postedEvent({ id: 'post-b-1', channel_id: 'channel-b' }));
    await Promise.resolve();

    expect(started).toEqual(['post-a-1', 'post-b-1']);
    releaseFirstA?.();
    await Promise.all([processingA1, processingA2, processingB1]);
    expect(started).toEqual(['post-a-1', 'post-b-1', 'post-a-2']);
  });

  it('keeps a failed channel blocked until its head post is recovered in order', async () => {
    let failFirstA = true;
    const started: string[] = [];
    const onInbound = vi.fn(async (event: { message: { id?: string } }) => {
      const id = event.message.id ?? 'missing';
      started.push(id);
      if (id === 'post-a-1' && failFirstA) throw new Error('injected A1 failure');
    });
    const processor = new MattermostInboundProcessor({ instanceKey: 'primary', botUserId: 'bot-user-id' }, onInbound);
    const a1 = postedEvent({ id: 'post-a-1', channel_id: 'channel-a' });
    const a2 = postedEvent({ id: 'post-a-2', channel_id: 'channel-a' });
    const b1 = postedEvent({ id: 'post-b-1', channel_id: 'channel-b' });

    const firstResults = await Promise.allSettled([processor.handle(a1), processor.handle(a2), processor.handle(b1)]);
    expect(firstResults.map((result) => result.status)).toEqual(['rejected', 'rejected', 'fulfilled']);
    expect(started).toEqual(['post-a-1', 'post-b-1']);

    failFirstA = false;
    await expect(processor.handle(a1)).resolves.toBe(true);
    await expect(processor.handle(a2)).resolves.toBe(true);
    expect(started).toEqual(['post-a-1', 'post-b-1', 'post-a-1', 'post-a-2']);
  });

  it('lets terminal bot removal clear a failed head while metadata remains blocked', async () => {
    let rejectFirstA: ((error: Error) => void) | undefined;
    const pendingFirstA = new Promise<void>((_resolve, reject) => {
      rejectFirstA = reject;
    });
    let firstA = true;
    const onInbound = vi.fn((event: { message: { id?: string } }) => {
      if (event.message.id === 'post-a-head' && firstA) {
        firstA = false;
        return pendingFirstA;
      }
      return Promise.resolve();
    });
    const processor = new MattermostInboundProcessor({ instanceKey: 'primary', botUserId: 'bot-user-id' }, onInbound);
    const lifecycleSink = vi.fn().mockResolvedValue(undefined);
    const metadataSink = vi.fn().mockResolvedValue(undefined);
    const aHead = postedEvent({ id: 'post-a-head', channel_id: 'channel-a' });

    const failedHead = processor.handle(aHead);
    await vi.waitFor(() => expect(onInbound).toHaveBeenCalledOnce());
    const queuedMetadataA = processor.handleMetadata(
      { platformId: 'mattermost:primary:channel-a', name: 'Blocked rename', isGroup: true },
      metadataSink,
    );
    const queuedLifecycleA = processor.handleLifecycle(
      { kind: 'bot_removed', platformId: 'mattermost:primary:channel-a' },
      lifecycleSink,
    );
    const independentLifecycleB = processor.handleLifecycle(
      { kind: 'bot_removed', platformId: 'mattermost:primary:channel-b' },
      lifecycleSink,
    );
    rejectFirstA?.(new Error('injected failed head'));

    await expect(failedHead).rejects.toThrow('injected failed head');
    await expect(queuedMetadataA).rejects.toThrow('Mattermost channel ingress is blocked');
    await expect(queuedLifecycleA).resolves.toBeUndefined();
    await expect(independentLifecycleB).resolves.toBeUndefined();
    expect(lifecycleSink).toHaveBeenCalledTimes(2);
    expect(metadataSink).not.toHaveBeenCalled();
    expect(processor.failedHeadId('mattermost:primary:channel-a')).toBeUndefined();
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

  it('normalizes a channel rename by stable channel id and rejects ambiguous identity', () => {
    const normalize = (
      inboundModule as typeof inboundModule & {
        normalizeMattermostChannelUpdatedPayload?: (
          payload: string,
          config: { instanceKey: string; botUserId: string },
        ) => { platformId: string; name: string; isGroup: true } | null;
      }
    ).normalizeMattermostChannelUpdatedPayload;
    expect(normalize).toBeTypeOf('function');
    if (!normalize) return;
    const config = { instanceKey: 'primary', botUserId: 'bot-user-id' };
    const channel = { id: 'channel-a', name: 'renamed-channel', display_name: 'Renamed Channel' };
    const payload = JSON.stringify({
      event: 'channel_updated',
      data: { channel: JSON.stringify(channel) },
      broadcast: { channel_id: 'channel-a' },
    });

    expect(normalize(payload, config)).toEqual({
      platformId: 'mattermost:primary:channel-a',
      name: 'Renamed Channel',
      isGroup: true,
    });
    expect(
      normalize(
        JSON.stringify({
          event: 'channel_updated',
          data: { channel: JSON.stringify(channel) },
          broadcast: { channel_id: 'channel-b' },
        }),
        config,
      ),
    ).toBeNull();
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
