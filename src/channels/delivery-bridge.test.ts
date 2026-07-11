import { describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, OutboundMessage } from './adapter.js';
import { createChannelDeliveryBridge } from './delivery-bridge.js';

function fakeAdapter(deliver: (message: OutboundMessage) => void): ChannelAdapter {
  return {
    name: 'fake',
    channelType: 'fake',
    supportsThreads: false,
    setup: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    deliver: vi.fn(async (_platformId, _threadId, message) => {
      deliver(message);
      return 'platform-message-id';
    }),
  };
}

describe('createChannelDeliveryBridge', () => {
  it('reports whether the requested channel adapter is currently available', () => {
    const adapter = fakeAdapter(() => undefined);
    const bridge = createChannelDeliveryBridge((channelType) => (channelType === 'fake' ? adapter : undefined));

    expect(bridge.isAvailable?.('fake')).toBe(true);
    expect(bridge.isAvailable?.('missing')).toBe(false);
  });

  it('reports a registered but disconnected adapter as unavailable', () => {
    const adapter = fakeAdapter(() => undefined);
    vi.mocked(adapter.isConnected).mockReturnValue(false);
    const bridge = createChannelDeliveryBridge(() => adapter);

    expect(bridge.isAvailable?.('mattermost')).toBe(false);
  });

  it('preserves existing outbound content and routing', async () => {
    const delivered: OutboundMessage[] = [];
    const adapter = fakeAdapter((message) => delivered.push(message));
    const bridge = createChannelDeliveryBridge(() => adapter);

    const result = await bridge.deliver('fake', 'channel-id', 'thread-id', 'chat', JSON.stringify({ text: 'hello' }));

    expect(result).toBe('platform-message-id');
    expect(adapter.deliver).toHaveBeenCalledWith('channel-id', 'thread-id', {
      kind: 'chat',
      content: { text: 'hello' },
      files: undefined,
    });
    expect(delivered).toHaveLength(1);
  });

  it('forwards the stable delivery id into the outbound message', async () => {
    const delivered: OutboundMessage[] = [];
    const bridge = createChannelDeliveryBridge(() => fakeAdapter((message) => delivered.push(message)));

    await bridge.deliver(
      'fake',
      'channel-id',
      null,
      'chat',
      JSON.stringify({ text: 'hello' }),
      undefined,
      'out-stable-delivery-id',
    );

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ deliveryId: 'out-stable-delivery-id' });
  });

  it('rejects when an adapter disappears between availability and delivery', async () => {
    const adapter = fakeAdapter(() => undefined);
    const lookup = vi.fn().mockReturnValueOnce(adapter).mockReturnValueOnce(undefined);
    const bridge = createChannelDeliveryBridge(lookup);

    expect(bridge.isAvailable?.('mattermost')).toBe(true);
    await expect(
      bridge.deliver('mattermost', 'channel-id', null, 'chat', JSON.stringify({ text: 'hello' })),
    ).rejects.toThrow('Delivery adapter unavailable for mattermost');
  });
});
