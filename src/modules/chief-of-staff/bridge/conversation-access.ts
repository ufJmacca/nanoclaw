import type { CosBinding } from '../../../cos-boundary.js';
import { validPrivateChannel, type ChannelFacts } from './identity.js';
import { ChannelAccessRevoked } from './mattermost-facts.js';
/** A confirmed permission change fences history. A failed observation only closes admission. */
export function guardConversationAccess(options: {
  active(binding: CosBinding): boolean;
  facts(binding: CosBinding): Promise<ChannelFacts>;
  revoke(binding: CosBinding): void;
}) {
  return async (binding: CosBinding): Promise<ChannelFacts> => {
    try {
      if (!options.active(binding)) throw new ChannelAccessRevoked();
      const facts = await options.facts(binding);
      if (!validPrivateChannel(binding, facts) || !options.active(binding)) throw new ChannelAccessRevoked();
      return facts;
    } catch (error) {
      if (error instanceof ChannelAccessRevoked) options.revoke(binding);
      throw error;
    }
  };
}
