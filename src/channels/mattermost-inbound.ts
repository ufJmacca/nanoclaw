import { createHash } from 'node:crypto';

import { log } from '../log.js';
import type { ChannelLifecycleEvent, InboundEvent } from './adapter.js';
import type { MattermostPostReceiptIdentity } from './mattermost-recovery.js';

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
  createAt: number;
  payloadDigest: string;
}

export interface MattermostReceiptStore {
  claim(input: MattermostPostReceiptIdentity): 'claimed' | 'processing' | 'completed';
  complete(input: MattermostPostReceiptIdentity, completedAt: string): boolean;
  release(input: MattermostPostReceiptIdentity): boolean;
}

export type MattermostNormalizationResult =
  | { kind: 'accepted'; event: InboundEvent; diagnostics: MattermostInboundDiagnostics }
  | { kind: 'ignored'; reason: 'unsupported_event' | 'bot_authored' }
  | { kind: 'rejected'; reason: 'oversized' | 'malformed_event' | 'malformed_post' | 'ambiguous_channel' };

export function normalizeMattermostLifecyclePayload(
  payload: string,
  config: MattermostInboundConfig,
): ChannelLifecycleEvent | null {
  if (Buffer.byteLength(payload, 'utf8') > (config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES)) return null;
  const event = safeParseJson(payload);
  if (!isRecord(event) || event.event !== 'user_removed' || !isRecord(event.data) || !isRecord(event.broadcast)) {
    return null;
  }
  if (event.broadcast.user_id !== config.botUserId) return null;
  const channelId = event.data.channel_id;
  if (typeof channelId !== 'string' || !isValidIdentityComponent(channelId)) return null;
  if (event.data.user_id !== undefined && event.data.user_id !== config.botUserId) return null;
  const broadcastChannelId = event.broadcast.channel_id;
  if (
    broadcastChannelId !== undefined &&
    (typeof broadcastChannelId !== 'string' || (broadcastChannelId.length > 0 && broadcastChannelId !== channelId))
  ) {
    return null;
  }
  return { kind: 'bot_removed', platformId: `mattermost:${config.instanceKey}:${channelId}` };
}

export interface MattermostChannelMetadata {
  platformId: string;
  name: string;
  isGroup: true;
}

export function normalizeMattermostChannelUpdatedPayload(
  payload: string,
  config: MattermostInboundConfig,
): MattermostChannelMetadata | null {
  if (Buffer.byteLength(payload, 'utf8') > (config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES)) return null;
  if (!isValidInstanceKey(config.instanceKey)) return null;
  const event = safeParseJson(payload);
  if (
    !isRecord(event) ||
    event.event !== 'channel_updated' ||
    !isRecord(event.data) ||
    typeof event.data.channel !== 'string' ||
    !isRecord(event.broadcast)
  ) {
    return null;
  }
  const channel = safeParseJson(event.data.channel);
  if (!isRecord(channel) || typeof channel.id !== 'string' || !isValidIdentityComponent(channel.id)) return null;
  if (event.broadcast.channel_id !== channel.id) return null;
  const displayName =
    typeof channel.display_name === 'string' && channel.display_name.trim().length > 0
      ? channel.display_name.trim()
      : typeof channel.name === 'string' && channel.name.trim().length > 0
        ? channel.name.trim()
        : null;
  if (!displayName) return null;
  return {
    platformId: `mattermost:${config.instanceKey}:${channel.id}`,
    name: displayName,
    isGroup: true,
  };
}

export class MattermostChannelSequencer {
  private readonly channelQueues = new Map<string, Promise<void>>();
  private readonly failedChannelHeads = new Map<string, string>();

  async enqueue<T>(
    channelId: string,
    task: () => T | Promise<T>,
    options: { headId?: string; terminal?: boolean } = {},
  ): Promise<T> {
    const previous = this.channelQueues.get(channelId) ?? Promise.resolve();
    const execution = previous.then(async () => {
      const failedHead = this.failedChannelHeads.get(channelId);
      if (failedHead !== undefined && failedHead !== options.headId && !options.terminal) {
        throw new Error('Mattermost channel ingress is blocked by an earlier failed post');
      }
      try {
        const result = await task();
        if ((options.headId !== undefined && failedHead === options.headId) || options.terminal) {
          if (failedHead !== this.failedChannelHeads.get(channelId)) return result;
          this.failedChannelHeads.delete(channelId);
        }
        return result;
      } catch (err) {
        if (options.headId !== undefined) this.failedChannelHeads.set(channelId, options.headId);
        throw err;
      }
    });
    const tail = execution.then(
      () => undefined,
      () => undefined,
    );
    this.channelQueues.set(channelId, tail);
    try {
      return await execution;
    } finally {
      if (this.channelQueues.get(channelId) === tail) this.channelQueues.delete(channelId);
    }
  }

  async drain(): Promise<void> {
    while (this.channelQueues.size > 0) {
      await Promise.all([...this.channelQueues.values()]);
    }
  }

  failedHeadId(channelId: string): string | undefined {
    return this.failedChannelHeads.get(channelId);
  }
}

export const mattermostChannelSequencer = new MattermostChannelSequencer();

export class MattermostInboundProcessor {
  private readonly seenPostIds = new Set<string>();

  constructor(
    private readonly config: MattermostInboundConfig,
    private readonly onInbound: MattermostInboundSink,
    private readonly logger: MattermostInboundLogger = log,
    private readonly receiptStore?: MattermostReceiptStore,
    private readonly sequencer: MattermostChannelSequencer = mattermostChannelSequencer,
  ) {
    if (!isValidInstanceKey(config.instanceKey)) {
      throw new Error('Invalid Mattermost instance key');
    }
  }

  async handle(payload: string): Promise<boolean> {
    const normalized = normalizeMattermostPayload(payload, this.config);
    if (normalized.kind !== 'accepted') return false;
    const receipt: MattermostPostReceiptIdentity = {
      instanceKey: normalized.diagnostics.instanceKey,
      postId: normalized.diagnostics.postId,
      channelId: normalized.diagnostics.channelId,
      createAt: normalized.diagnostics.createAt,
      payloadDigest: normalized.diagnostics.payloadDigest,
    };
    if (this.receiptStore) {
      if (this.receiptStore.claim(receipt) !== 'claimed') return false;
    } else {
      if (this.seenPostIds.has(normalized.diagnostics.postId)) return false;
      this.seenPostIds.add(normalized.diagnostics.postId);
    }

    const channelId = normalized.event.platformId;
    try {
      await this.sequencer.enqueue(
        channelId,
        async () => {
          await this.onInbound(normalized.event);
          if (this.receiptStore && !this.receiptStore.complete(receipt, new Date().toISOString())) {
            throw new Error('Mattermost post receipt completion failed');
          }
        },
        { headId: normalized.diagnostics.postId },
      );
      this.logger.info('Mattermost inbound post normalized', {
        instanceKey: normalized.diagnostics.instanceKey,
        eventType: normalized.diagnostics.eventType,
        postId: normalized.diagnostics.postId,
        channelId: normalized.diagnostics.channelId,
        senderId: normalized.diagnostics.senderId,
        rootId: normalized.diagnostics.rootId,
        payloadBytes: normalized.diagnostics.payloadBytes,
      });
      return true;
    } catch (err) {
      this.releaseReceipt(receipt);
      throw err;
    }
  }

  private releaseReceipt(receipt: MattermostPostReceiptIdentity): void {
    if (this.receiptStore) this.receiptStore.release(receipt);
    else this.seenPostIds.delete(receipt.postId);
  }

  async drain(): Promise<void> {
    await this.sequencer.drain();
  }

  failedHeadId(platformId: string): string | undefined {
    return this.sequencer.failedHeadId(platformId);
  }

  async handleLifecycle(
    event: ChannelLifecycleEvent,
    sink: (event: ChannelLifecycleEvent) => void | Promise<void>,
  ): Promise<void> {
    await this.enqueueChannelTask(event.platformId, () => sink(event), { terminal: true });
  }

  async handleMetadata(
    metadata: MattermostChannelMetadata,
    sink: (metadata: MattermostChannelMetadata) => void | Promise<void>,
  ): Promise<void> {
    await this.enqueueChannelTask(metadata.platformId, () => sink(metadata));
  }

  private async enqueueChannelTask(
    channelId: string,
    task: () => void | Promise<void>,
    options: { terminal?: boolean } = {},
  ): Promise<void> {
    await this.sequencer.enqueue(channelId, task, options);
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
      isMention: mentionsAuthenticatedBot(parsedEvent.data.mentions, config.botUserId),
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
      createAt: post.create_at,
      payloadDigest: createHash('sha256')
        .update(JSON.stringify([post.id, post.channel_id, post.user_id, post.root_id, post.message, post.create_at]))
        .digest('hex'),
    },
  };
}

function mentionsAuthenticatedBot(rawMentions: unknown, botUserId: string): boolean {
  if (typeof rawMentions !== 'string') return false;
  const mentions = safeParseJson(rawMentions);
  return (
    Array.isArray(mentions) && mentions.every((mention) => typeof mention === 'string') && mentions.includes(botUserId)
  );
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
  return isValidIdentityComponent(instanceKey);
}

function isValidIdentityComponent(value: string): boolean {
  return value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
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
