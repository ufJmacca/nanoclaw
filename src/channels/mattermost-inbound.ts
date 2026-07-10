import { log } from '../log.js';
import type { InboundEvent } from './adapter.js';

export interface MattermostInboundConfig {
  instanceKey: string;
  botUserId: string;
  maxPayloadBytes?: number;
}

export type MattermostInboundSink = (event: InboundEvent) => void | Promise<void>;

export interface MattermostInboundLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

interface MattermostPost {
  id: string;
  channel_id: string;
  user_id: string;
  root_id: string;
  message: string;
  create_at: number;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;

export interface MattermostInboundDiagnostics {
  instanceKey: string;
  eventType: 'posted';
  postId: string;
  channelId: string;
  senderId: string;
  rootId: string | null;
  payloadBytes: number;
}

export type MattermostNormalizationResult =
  | { kind: 'accepted'; event: InboundEvent; diagnostics: MattermostInboundDiagnostics }
  | { kind: 'ignored'; reason: 'unsupported_event' | 'bot_authored' }
  | { kind: 'rejected'; reason: 'oversized' | 'malformed_event' | 'malformed_post' | 'ambiguous_channel' };

export class MattermostInboundProcessor {
  private readonly seenPostIds = new Set<string>();

  constructor(
    private readonly config: MattermostInboundConfig,
    private readonly onInbound: MattermostInboundSink,
    private readonly logger: MattermostInboundLogger = log,
  ) {
    if (!isValidInstanceKey(config.instanceKey)) {
      throw new Error('Invalid Mattermost instance key');
    }
  }

  async handle(payload: string): Promise<boolean> {
    const normalized = normalizeMattermostPayload(payload, this.config);
    if (normalized.kind !== 'accepted') return false;
    if (this.seenPostIds.has(normalized.diagnostics.postId)) return false;
    this.seenPostIds.add(normalized.diagnostics.postId);

    await this.onInbound(normalized.event);
    this.logger.info('Mattermost inbound post normalized', { ...normalized.diagnostics });
    return true;
  }
}

export function normalizeMattermostPayload(
  payload: string,
  config: MattermostInboundConfig,
): MattermostNormalizationResult {
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (payloadBytes > (config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES)) {
    return { kind: 'rejected', reason: 'oversized' };
  }

  const parsedEvent = safeParseJson(payload);
  if (!isRecord(parsedEvent)) return { kind: 'rejected', reason: 'malformed_event' };
  if (parsedEvent.event !== 'posted') return { kind: 'ignored', reason: 'unsupported_event' };
  if (!isRecord(parsedEvent.data) || typeof parsedEvent.data.post !== 'string') {
    return { kind: 'rejected', reason: 'malformed_event' };
  }

  const parsedPost = safeParseJson(parsedEvent.data.post);
  if (!isMattermostPost(parsedPost)) return { kind: 'rejected', reason: 'malformed_post' };
  const post = parsedPost;

  if (parsedEvent.broadcast !== undefined) {
    if (!isRecord(parsedEvent.broadcast)) return { kind: 'rejected', reason: 'ambiguous_channel' };
    const broadcastChannelId = parsedEvent.broadcast.channel_id;
    if (broadcastChannelId !== undefined && typeof broadcastChannelId !== 'string') {
      return { kind: 'rejected', reason: 'ambiguous_channel' };
    }
    if (broadcastChannelId && broadcastChannelId !== post.channel_id) {
      return { kind: 'rejected', reason: 'ambiguous_channel' };
    }
  }
  if (post.user_id === config.botUserId) return { kind: 'ignored', reason: 'bot_authored' };

  const senderId = `mattermost:${post.user_id}`;
  const rootId = post.root_id || null;
  const event: InboundEvent = {
    channelType: 'mattermost',
    platformId: `mattermost:${config.instanceKey}:${post.channel_id}`,
    threadId: rootId,
    message: {
      id: post.id,
      kind: 'chat',
      content: JSON.stringify({
        sender: typeof parsedEvent.data.sender_name === 'string' ? parsedEvent.data.sender_name : undefined,
        senderId,
        text: post.message,
      }),
      timestamp: new Date(post.create_at).toISOString(),
      isGroup: true,
    },
  };

  return {
    kind: 'accepted',
    event,
    diagnostics: {
      instanceKey: config.instanceKey,
      eventType: 'posted',
      postId: post.id,
      channelId: post.channel_id,
      senderId,
      rootId,
      payloadBytes,
    },
  };
}

function safeParseJson(payload: string): unknown | undefined {
  try {
    return JSON.parse(payload);
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidInstanceKey(instanceKey: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(instanceKey);
}

function isMattermostPost(value: unknown): value is MattermostPost {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.channel_id === 'string' &&
    value.channel_id.length > 0 &&
    typeof value.user_id === 'string' &&
    value.user_id.length > 0 &&
    typeof value.root_id === 'string' &&
    typeof value.message === 'string' &&
    typeof value.create_at === 'number' &&
    Number.isFinite(value.create_at) &&
    !Number.isNaN(new Date(value.create_at).getTime())
  );
}
