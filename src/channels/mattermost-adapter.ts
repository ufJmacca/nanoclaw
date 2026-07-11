import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup } from './adapter.js';
import { MattermostClient, type MattermostClientConfig, type MattermostTransport } from './mattermost-client.js';
import { MattermostInboundProcessor, normalizeMattermostLifecyclePayload } from './mattermost-inbound.js';
import { MattermostOutboundDelivery } from './mattermost-outbound.js';

export interface MattermostAdapterConfig extends MattermostClientConfig {
  allowMassMentions?: boolean;
}

/**
 * Assemble the native Mattermost adapter without registering it globally.
 * Registration remains gated on the strict subscription boundary in Phase 5.
 */
export function createMattermostAdapter(
  config: MattermostAdapterConfig,
  transport: MattermostTransport,
): ChannelAdapter {
  const client = new MattermostClient(config, transport);
  const outbound = new MattermostOutboundDelivery(config, transport);
  let connected = false;

  return {
    name: 'mattermost',
    channelType: 'mattermost',
    supportsThreads: true,
    threadSessionPolicy: 'honor-wiring',
    async setup(host: ChannelSetup) {
      let inbound: MattermostInboundProcessor | null = null;
      await client.setup((payload, context) => {
        const inboundConfig = { instanceKey: config.instanceKey, botUserId: context.botUserId };
        const lifecycle = normalizeMattermostLifecyclePayload(payload, inboundConfig);
        if (lifecycle) {
          void Promise.resolve(host.onLifecycle?.(lifecycle)).catch((err) =>
            log.warn('Mattermost lifecycle handling failed', { err }),
          );
          return;
        }
        inbound ??= new MattermostInboundProcessor(inboundConfig, (event) =>
          host.onInbound(event.platformId, event.threadId, {
            id: event.message.id,
            kind: event.message.kind,
            content: JSON.parse(event.message.content),
            timestamp: event.message.timestamp,
            isMention: event.message.isMention,
            isGroup: event.message.isGroup,
          }),
        );
        void inbound.handle(payload).catch((err) => log.warn('Mattermost inbound handling failed', { err }));
      });
      connected = true;
    },
    async teardown() {
      client.teardown();
      connected = false;
    },
    isConnected: () => connected,
    async deliver(platformId, threadId, message) {
      return outbound.deliver(platformId, threadId, message);
    },
  };
}
