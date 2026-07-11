import { readEnvFile } from '../env.js';
import { createMattermostAdapter } from './mattermost-adapter.js';
import { NodeMattermostTransport, type MattermostTransport } from './mattermost-client.js';
import { registerChannelAdapter } from './channel-registry.js';

const MATTERMOST_ENV_KEYS = [
  'MATTERMOST_URL',
  'MATTERMOST_BOT_TOKEN',
  'MATTERMOST_INSTANCE',
  'MATTERMOST_ALLOW_MASS_MENTIONS',
] as const;

export function createMattermostAdapterFromHostConfig(
  env: Record<string, string | undefined>,
  transport: MattermostTransport = new NodeMattermostTransport(),
) {
  const baseUrl = env.MATTERMOST_URL;
  const botToken = env.MATTERMOST_BOT_TOKEN;
  const instanceKey = env.MATTERMOST_INSTANCE;
  if (!baseUrl && !botToken && !instanceKey) return null;
  if (!baseUrl || !botToken || !instanceKey) {
    throw new Error('Mattermost configuration requires URL, bot token, and instance key');
  }
  if (instanceKey.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(instanceKey)) {
    throw new Error('Mattermost instance key is invalid');
  }
  if (!URL.canParse(baseUrl)) throw new Error('Mattermost URL is invalid');
  const parsedUrl = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error('Mattermost URL is invalid');
  }

  return createMattermostAdapter(
    {
      baseUrl: parsedUrl.toString().replace(/\/$/, ''),
      botToken,
      instanceKey,
      allowMassMentions: env.MATTERMOST_ALLOW_MASS_MENTIONS === 'true',
    },
    transport,
  );
}

registerChannelAdapter('mattermost', {
  factory: () => createMattermostAdapterFromHostConfig(readEnvFile([...MATTERMOST_ENV_KEYS])),
});
