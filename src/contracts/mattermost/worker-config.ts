import os from 'node:os';
import path from 'node:path';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface MattermostContractWorkerChannel {
  channelId: string;
  name: string;
  baseline: { postId: string; createAt: number };
}

export interface MattermostContractWorkerConfig {
  baseUrl: string;
  instanceKey: string;
  botToken: string;
  bootstrapSubscriptions: boolean;
  databasePath: string;
  channels: readonly MattermostContractWorkerChannel[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).length === allowed.size && Object.keys(value).every((key) => allowed.has(key));
}

export function parseMattermostContractWorkerConfig(
  serialized: string,
  workingDirectory: string,
): MattermostContractWorkerConfig {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new Error('Mattermost contract worker configuration was invalid', { cause: err });
  }
  const resolvedRoot = path.resolve(workingDirectory);
  const relativeToTemp = path.relative(path.resolve(os.tmpdir()), resolvedRoot);
  if (
    !path.isAbsolute(workingDirectory) ||
    relativeToTemp === '' ||
    relativeToTemp === '..' ||
    relativeToTemp.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToTemp) ||
    !path.basename(resolvedRoot).startsWith('nanoclaw-mm-contract-') ||
    !isRecord(value) ||
    !hasOnlyKeys(value, ['bootstrapSubscriptions', 'botToken', 'channels']) ||
    typeof value.botToken !== 'string' ||
    value.botToken.length < 8 ||
    value.botToken.length > 512 ||
    /\s/.test(value.botToken) ||
    typeof value.bootstrapSubscriptions !== 'boolean' ||
    !Array.isArray(value.channels) ||
    value.channels.length !== 2
  ) {
    throw new Error('Mattermost contract worker configuration was invalid');
  }

  const channels: MattermostContractWorkerChannel[] = [];
  for (const candidate of value.channels) {
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, ['baseline', 'channelId', 'name']) ||
      typeof candidate.channelId !== 'string' ||
      !SAFE_ID.test(candidate.channelId) ||
      typeof candidate.name !== 'string' ||
      candidate.name.trim().length === 0 ||
      candidate.name.length > 128 ||
      !isRecord(candidate.baseline) ||
      !hasOnlyKeys(candidate.baseline, ['createAt', 'postId']) ||
      typeof candidate.baseline.postId !== 'string' ||
      !SAFE_ID.test(candidate.baseline.postId) ||
      typeof candidate.baseline.createAt !== 'number' ||
      !Number.isSafeInteger(candidate.baseline.createAt) ||
      candidate.baseline.createAt < 0
    ) {
      throw new Error('Mattermost contract worker configuration was invalid');
    }
    channels.push({
      channelId: candidate.channelId,
      name: candidate.name,
      baseline: { postId: candidate.baseline.postId, createAt: candidate.baseline.createAt },
    });
  }
  if (new Set(channels.map((channel) => channel.channelId)).size !== channels.length) {
    throw new Error('Mattermost contract worker configuration was invalid');
  }
  return {
    baseUrl: 'http://127.0.0.1:8065',
    instanceKey: 'contract',
    botToken: value.botToken,
    bootstrapSubscriptions: value.bootstrapSubscriptions,
    databasePath: path.join(resolvedRoot, 'data', 'nanoclaw.db'),
    channels,
  };
}
