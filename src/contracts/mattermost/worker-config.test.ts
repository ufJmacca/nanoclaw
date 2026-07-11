import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseMattermostContractWorkerConfig } from './worker-config.js';

const testRoot = '/tmp/nanoclaw-mm-contract-worker';
const config = {
  botToken: 'synthetic-disposable-bot-token',
  bootstrapSubscriptions: true,
  channels: [
    { channelId: 'channel-a', name: 'Contract A', baseline: { postId: 'baseline-a', createAt: 100 } },
    { channelId: 'channel-b', name: 'Contract B', baseline: { postId: 'baseline-b', createAt: 101 } },
  ],
};

describe('Mattermost contract worker configuration', () => {
  it('derives a fixed loopback instance and worker-owned database path', () => {
    expect(parseMattermostContractWorkerConfig(JSON.stringify(config), testRoot)).toEqual({
      baseUrl: 'http://127.0.0.1:8065',
      instanceKey: 'contract',
      botToken: config.botToken,
      bootstrapSubscriptions: true,
      databasePath: path.join(testRoot, 'data', 'nanoclaw.db'),
      channels: config.channels,
    });

    for (const unsafe of [
      { ...config, baseUrl: 'https://mattermost.production.example' },
      { ...config, instanceKey: 'primary' },
      { ...config, botToken: '' },
      { ...config, bootstrapSubscriptions: 'yes' },
      { ...config, channels: [config.channels[0], config.channels[0]] },
      { ...config, channels: [{ ...config.channels[0], channelId: '../escape' }, config.channels[1]] },
    ]) {
      expect(() => parseMattermostContractWorkerConfig(JSON.stringify(unsafe), testRoot)).toThrow(
        'Mattermost contract worker configuration was invalid',
      );
    }
  });
});
