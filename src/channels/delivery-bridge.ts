import type { ChannelDeliveryAdapter } from '../delivery.js';
import { log } from '../log.js';
import type { ChannelAdapter } from './adapter.js';
import { getChannelAdapter } from './channel-registry.js';

export type ChannelAdapterLookup = (channelType: string) => ChannelAdapter | undefined;

export function createChannelDeliveryBridge(
  lookupAdapter: ChannelAdapterLookup = getChannelAdapter,
): ChannelDeliveryAdapter {
  return {
    async deliver(channelType, platformId, threadId, kind, content, files, deliveryId) {
      const adapter = lookupAdapter(channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType });
        return;
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files, deliveryId });
    },
    async setTyping(channelType, platformId, threadId) {
      const adapter = lookupAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
}
