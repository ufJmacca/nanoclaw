import type { CosBinding } from '../../../cos-boundary.js';
import type { MattermostClientConfig, MattermostTransport } from '../../../channels/mattermost-client.js';
import type { ChannelFacts } from './identity.js';
export function createMattermostFacts(
  config: MattermostClientConfig,
  transport: Pick<MattermostTransport, 'request'>,
  active: (binding: CosBinding) => boolean,
) {
  return async (binding: CosBinding): Promise<ChannelFacts> => {
    try {
      const base = new URL(config.baseUrl);
      if (
        binding.instanceId !== config.instanceKey ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(binding.channelId) ||
        !['http:', 'https:'].includes(base.protocol) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        !config.botToken ||
        !active(binding)
      )
        throw new Error();
      const get = async (path: string): Promise<Record<string, unknown> | unknown[]> => {
        const response = await transport.request({
          method: 'GET',
          url: base.toString().replace(/\/$/, '') + '/api/v4' + path,
          headers: { Authorization: 'Bearer ' + config.botToken },
          timeoutMs: 3000,
        });
        if (response.status !== 200 || !response.body || typeof response.body !== 'object') throw new Error();
        return response.body as Record<string, unknown> | unknown[];
      };
      const [bot, channel, members] = await Promise.all([
        get('/users/me'),
        get('/channels/' + binding.channelId),
        get('/channels/' + binding.channelId + '/members?page=0&per_page=3'),
      ]);
      if (
        Array.isArray(bot) ||
        bot.id !== binding.botId ||
        bot.is_bot !== true ||
        bot.delete_at !== 0 ||
        Array.isArray(channel) ||
        channel.id !== binding.channelId ||
        typeof channel.type !== 'string' ||
        typeof channel.delete_at !== 'number' ||
        !Array.isArray(members) ||
        members.some(
          (member) =>
            !member || typeof member !== 'object' || typeof (member as { user_id?: unknown }).user_id !== 'string',
        )
      )
        throw new Error();
      return {
        id: channel.id as string,
        type: channel.type,
        delete_at: channel.delete_at,
        members: members.map((member) => (member as { user_id: string }).user_id),
        activeSubscription: active(binding),
      };
    } catch {
      // Raw transport errors may contain the host-only bot token or private response body.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('CoS private channel verification unavailable');
    }
  };
}
