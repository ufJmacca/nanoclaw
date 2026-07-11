import { createHash } from 'node:crypto';

import type { OutboundMessage } from './adapter.js';
import type { MattermostTransport } from './mattermost-client.js';

export interface MattermostOutboundConfig {
  baseUrl: string;
  botToken: string;
  instanceKey: string;
  allowMassMentions?: boolean;
}

export interface MattermostOutboundDependencies {
  sleep?(delayMs: number): Promise<void>;
  maxAttempts?: number;
  maxRetryDelayMs?: number;
  baseRetryDelayMs?: number;
}

const defaultSleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));
export const MATTERMOST_MESSAGE_MAX_CODE_POINTS = 16_383;
const SAFE_MATTERMOST_ID_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface MattermostPostPayloadInput {
  instanceKey: string;
  channelId: string;
  threadId: string | null;
  deliveryId?: string;
  content: unknown;
  allowMassMentions: boolean;
}

export interface MattermostPostPayload {
  channel_id: string;
  message: string;
  pending_post_id: string;
  root_id?: string;
}

export interface MattermostRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface MattermostRetryResponse {
  status: number;
  headers?: Readonly<Record<string, string>>;
}

export class MattermostOutboundDelivery {
  constructor(
    private readonly config: MattermostOutboundConfig,
    private readonly transport: MattermostTransport,
    private readonly dependencies: MattermostOutboundDependencies = {},
  ) {}

  async deliver(platformId: string, threadId: string | null, outbound: OutboundMessage): Promise<string> {
    const channelId = parseChannelId(platformId, this.config.instanceKey);
    const payload = buildMattermostPostPayload({
      instanceKey: this.config.instanceKey,
      channelId,
      threadId,
      deliveryId: outbound.deliveryId,
      content: outbound.content,
      allowMassMentions: this.config.allowMassMentions === true,
    });
    const request = {
      method: 'POST',
      url: `${this.config.baseUrl.replace(/\/+$/, '')}/api/v4/posts`,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.config.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    } as const;

    const maxAttempts = this.dependencies.maxAttempts ?? 3;
    const sleep = this.dependencies.sleep ?? defaultSleep;
    const retryPolicy: MattermostRetryPolicy = {
      maxAttempts,
      baseDelayMs: this.dependencies.baseRetryDelayMs ?? 250,
      maxDelayMs: this.dependencies.maxRetryDelayMs ?? 30_000,
    };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await this.transport.request(request).catch(() => {
        throw new Error('Mattermost delivery request failed');
      });
      const retryDelayMs = mattermostRetryDelayMs(response, attempt, retryPolicy);
      if (retryDelayMs !== null) {
        await sleep(retryDelayMs);
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Mattermost delivery failed (HTTP ${response.status})`);
      }
      const postId = responsePostId(response.body);
      if (!postId) throw new Error('Mattermost delivery response was invalid');
      return postId;
    }
    throw new Error('Mattermost delivery attempts exhausted');
  }
}

export function buildMattermostPendingPostId(
  instanceKey: string,
  channelId: string,
  threadId: string | null,
  deliveryId: string,
): string {
  const digest = createHash('sha256')
    .update([instanceKey, channelId, threadId ?? '', deliveryId].join('\0'))
    .digest('hex')
    .slice(0, 32);
  return `nanoclaw-${digest}`;
}

export function buildMattermostPostPayload(input: MattermostPostPayloadInput): MattermostPostPayload {
  const rawMessage = outboundText(input.content);
  const message = input.allowMassMentions ? rawMessage : sanitizeMattermostMassMentions(rawMessage);
  if ([...message].length > MATTERMOST_MESSAGE_MAX_CODE_POINTS) {
    throw new Error(`Mattermost outbound content exceeds ${MATTERMOST_MESSAGE_MAX_CODE_POINTS} code points`);
  }
  if (!input.deliveryId) throw new Error('Mattermost delivery requires a stable delivery id');
  return {
    channel_id: input.channelId,
    message,
    pending_post_id: buildMattermostPendingPostId(input.instanceKey, input.channelId, input.threadId, input.deliveryId),
    ...(input.threadId ? { root_id: input.threadId } : {}),
  };
}

export function sanitizeMattermostMassMentions(message: string): string {
  return message.replace(/([@＠])(channel|all|here)\b/gi, '$1\u200b$2');
}

export function mattermostRetryDelayMs(
  response: MattermostRetryResponse,
  attempt: number,
  policy: MattermostRetryPolicy,
): number | null {
  if (attempt >= policy.maxAttempts) return null;
  if (response.status === 429) {
    return (
      rateLimitDelayMs(response.headers, policy.maxDelayMs) ??
      exponentialBackoffMs(attempt, policy.baseDelayMs, policy.maxDelayMs)
    );
  }
  if (response.status >= 500 && response.status <= 599) {
    return exponentialBackoffMs(attempt, policy.baseDelayMs, policy.maxDelayMs);
  }
  return null;
}

function rateLimitDelayMs(headers: Readonly<Record<string, string>> | undefined, maxDelayMs: number): number | null {
  const delay = secondsHeaderDelayMs(headers?.['retry-after']) ?? secondsHeaderDelayMs(headers?.['x-ratelimit-reset']);
  return delay === null ? null : Math.min(delay, maxDelayMs);
}

function secondsHeaderDelayMs(header: string | undefined): number | null {
  if (!header || !/^\d+(?:\.\d+)?$/.test(header.trim())) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
}

function exponentialBackoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
}

function parseChannelId(platformId: string, instanceKey: string): string {
  if (!SAFE_MATTERMOST_ID_COMPONENT.test(instanceKey)) {
    throw new Error('Invalid Mattermost instance key');
  }
  const prefix = `mattermost:${instanceKey}:`;
  if (!platformId.startsWith(prefix)) throw new Error('Invalid Mattermost delivery destination');
  const channelId = platformId.slice(prefix.length);
  if (!SAFE_MATTERMOST_ID_COMPONENT.test(channelId)) {
    throw new Error('Invalid Mattermost delivery destination');
  }
  return channelId;
}

function outboundText(content: unknown): string {
  if (!content || typeof content !== 'object') throw new Error('Invalid Mattermost outbound content');
  const markdown = (content as Record<string, unknown>).markdown;
  if (typeof markdown === 'string' && markdown.trim().length > 0) return markdown;
  const text = (content as Record<string, unknown>).text;
  if (typeof text === 'string' && text.trim().length > 0) return text;
  throw new Error('Invalid Mattermost outbound content');
}

function responsePostId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const id = (body as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
