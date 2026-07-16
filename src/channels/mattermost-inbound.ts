import { createHash } from 'node:crypto';

import { log } from '../log.js';
import type {
  ChannelLifecycleEvent,
  InboundAttachmentLoader,
  InboundAttachmentLoadResult,
  InboundEvent,
} from './adapter.js';
import type { MattermostTransport } from './mattermost-client.js';
import type { MattermostPostReceiptIdentity } from './mattermost-recovery.js';
import { MATTERMOST_POST_MAX_FILES, mattermostRetryDelayMs } from './mattermost-outbound.js';

export interface MattermostInboundConfig {
  instanceKey: string;
  botUserId: string;
  maxPayloadBytes?: number;
  createAttachmentLoader?: (references: readonly MattermostInboundAttachmentReference[]) => InboundAttachmentLoader;
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
  file_ids?: string[];
}

/**
 * Authenticated file identity captured from a Mattermost post. The opaque
 * file ID may survive host-side approval persistence; post/channel bindings
 * are always reconstructed from the authenticated inbound event and
 * revalidated against Mattermost metadata before bytes are accepted.
 */
export interface MattermostInboundAttachmentReference {
  fileId: string;
  postId: string;
  channelId: string;
}

export interface MattermostInboundAttachmentLoaderConfig {
  baseUrl: string;
  botToken: string;
}

export interface MattermostInboundAttachmentLoaderDependencies {
  sleep?(delayMs: number): Promise<void>;
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  requestTimeoutMs?: number;
  logger?: Pick<MattermostInboundLogger, 'info' | 'warn'>;
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
  attachmentCount: number;
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

const defaultAttachmentSleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));
const DEFAULT_ATTACHMENT_REQUEST_TIMEOUT_MS = 30_000;

interface ValidatedMattermostFileInfo {
  name: string;
  mimeType: string;
  size: number;
}

/**
 * Build the lazy authenticated download operation for one Mattermost post.
 * The returned closure memoizes its promise so router fan-out downloads each
 * source file once while still allowing each destination to stage its own
 * independent copy.
 */
export function createMattermostInboundAttachmentLoader(
  config: MattermostInboundAttachmentLoaderConfig,
  transport: Pick<MattermostTransport, 'request'>,
  references: readonly MattermostInboundAttachmentReference[],
  dependencies: MattermostInboundAttachmentLoaderDependencies = {},
): InboundAttachmentLoader {
  const stableReferences = references.map((reference) => ({ ...reference }));
  let pending: Promise<InboundAttachmentLoadResult[]> | undefined;
  return () => {
    pending ??= loadMattermostInboundAttachments(config, transport, stableReferences, dependencies);
    return pending;
  };
}

async function loadMattermostInboundAttachments(
  config: MattermostInboundAttachmentLoaderConfig,
  transport: Pick<MattermostTransport, 'request'>,
  references: readonly MattermostInboundAttachmentReference[],
  dependencies: MattermostInboundAttachmentLoaderDependencies,
): Promise<InboundAttachmentLoadResult[]> {
  const results: InboundAttachmentLoadResult[] = [];
  for (const [index, reference] of references.entries()) {
    // Sequential metadata/download pairs bound peak host memory to one new
    // download at a time. Completed buffers remain for memoized router fan-out.
    results.push(await loadMattermostInboundAttachment(config, transport, reference, index, dependencies));
  }
  const available = results.filter((result) => result.data !== undefined);
  dependencies.logger?.info('Mattermost inbound attachments loaded', {
    postId: references[0]?.postId,
    channelId: references[0]?.channelId,
    attachmentCount: results.length,
    availableCount: available.length,
    unavailableCount: results.length - available.length,
    byteTotal: available.reduce((total, result) => total + (result.data?.byteLength ?? 0), 0),
  });
  return results;
}

async function loadMattermostInboundAttachment(
  config: MattermostInboundAttachmentLoaderConfig,
  transport: Pick<MattermostTransport, 'request'>,
  reference: MattermostInboundAttachmentReference,
  index: number,
  dependencies: MattermostInboundAttachmentLoaderDependencies,
): Promise<InboundAttachmentLoadResult> {
  const fallbackName = `attachment-${index + 1}`;
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${config.botToken}`,
  };
  const infoResponse = await requestMattermostAttachmentWithRetry(
    transport,
    {
      method: 'GET',
      url: `${baseUrl}/api/v4/files/${encodeURIComponent(reference.fileId)}/info`,
      headers,
      timeoutMs: dependencies.requestTimeoutMs ?? DEFAULT_ATTACHMENT_REQUEST_TIMEOUT_MS,
    },
    dependencies,
  );
  if (!infoResponse || infoResponse.status < 200 || infoResponse.status >= 300) {
    logMattermostAttachmentFailure(dependencies, reference, index, 'metadata', 'metadata_failed');
    return { name: fallbackName, unavailable: 'metadata_failed' };
  }

  const info = validateMattermostFileInfo(infoResponse.body, reference);
  if (!info) {
    logMattermostAttachmentFailure(dependencies, reference, index, 'metadata', 'metadata_mismatch');
    return { name: fallbackName, unavailable: 'metadata_mismatch' };
  }

  const downloadResponse = await requestMattermostAttachmentWithRetry(
    transport,
    {
      method: 'GET',
      url: `${baseUrl}/api/v4/files/${encodeURIComponent(reference.fileId)}`,
      headers: {
        Accept: '*/*',
        Authorization: `Bearer ${config.botToken}`,
      },
      responseType: 'binary',
      timeoutMs: dependencies.requestTimeoutMs ?? DEFAULT_ATTACHMENT_REQUEST_TIMEOUT_MS,
    },
    dependencies,
  );
  if (
    !downloadResponse ||
    downloadResponse.status < 200 ||
    downloadResponse.status >= 300 ||
    !Buffer.isBuffer(downloadResponse.body)
  ) {
    logMattermostAttachmentFailure(dependencies, reference, index, 'download', 'download_failed');
    return { ...info, unavailable: 'download_failed' };
  }
  if (downloadResponse.body.byteLength !== info.size) {
    logMattermostAttachmentFailure(dependencies, reference, index, 'download', 'size_mismatch');
    return { ...info, unavailable: 'size_mismatch' };
  }
  return { ...info, data: downloadResponse.body };
}

function validateMattermostFileInfo(
  body: unknown,
  reference: MattermostInboundAttachmentReference,
): ValidatedMattermostFileInfo | null {
  if (!isRecord(body)) return null;
  if (body.id !== reference.fileId || body.post_id !== reference.postId || body.channel_id !== reference.channelId) {
    return null;
  }
  if (!isValidMattermostFilename(body.name) || !isValidMattermostMimeType(body.mime_type)) return null;
  if (typeof body.size !== 'number' || !Number.isSafeInteger(body.size) || body.size < 0) return null;
  return { name: body.name, mimeType: body.mime_type, size: body.size };
}

function isValidMattermostFilename(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 4096 &&
    !hasControlCharacters(value)
  );
}

function isValidMattermostMimeType(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || hasControlCharacters(value)) {
    return false;
  }
  const mediaType = value.split(';', 1)[0]?.trim() ?? '';
  const separator = mediaType.indexOf('/');
  return separator > 0 && separator < mediaType.length - 1 && mediaType.indexOf('/', separator + 1) < 0;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

async function requestMattermostAttachmentWithRetry(
  transport: Pick<MattermostTransport, 'request'>,
  request: Parameters<MattermostTransport['request']>[0],
  dependencies: MattermostInboundAttachmentLoaderDependencies,
): Promise<Awaited<ReturnType<MattermostTransport['request']>> | undefined> {
  const maxAttempts = dependencies.maxAttempts ?? 3;
  const sleep = dependencies.sleep ?? defaultAttachmentSleep;
  const retryPolicy = {
    maxAttempts,
    baseDelayMs: dependencies.baseRetryDelayMs ?? 250,
    maxDelayMs: dependencies.maxRetryDelayMs ?? 30_000,
  };
  let response: Awaited<ReturnType<MattermostTransport['request']>> | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      response = await transport.request(request);
      // Transport failures are retried and deliberately reduced to a safe
      // category so response bodies and authenticated URLs cannot reach logs.
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      const retryDelayMs = mattermostRetryDelayMs({ status: 503 }, attempt, retryPolicy);
      if (retryDelayMs === null) return undefined;
      await sleep(retryDelayMs);
      continue;
    }
    const retryDelayMs = mattermostRetryDelayMs(response, attempt, retryPolicy);
    if (retryDelayMs === null) return response;
    await sleep(retryDelayMs);
  }
  return response;
}

function logMattermostAttachmentFailure(
  dependencies: MattermostInboundAttachmentLoaderDependencies,
  reference: MattermostInboundAttachmentReference,
  index: number,
  stage: 'metadata' | 'download',
  category: 'metadata_failed' | 'download_failed' | 'metadata_mismatch' | 'size_mismatch',
): void {
  dependencies.logger?.warn('Mattermost inbound attachment unavailable', {
    postId: reference.postId,
    channelId: reference.channelId,
    attachmentIndex: index,
    stage,
    category,
  });
}

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
        attachmentCount: normalized.diagnostics.attachmentCount,
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
  const attachmentReferences = (post.file_ids ?? []).map((fileId) => ({
    fileId,
    postId: post.id,
    channelId: post.channel_id,
  }));
  const loadAttachments =
    attachmentReferences.length > 0 ? config.createAttachmentLoader?.(attachmentReferences) : undefined;
  const attachmentRefs = attachmentReferences.map(({ fileId }) => ({ id: fileId }));
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
      ...(attachmentRefs.length > 0 ? { attachmentRefs } : {}),
      ...(loadAttachments ? { loadAttachments } : {}),
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
      attachmentCount: attachmentReferences.length,
      payloadDigest: createHash('sha256')
        .update(
          JSON.stringify([
            post.id,
            post.channel_id,
            post.user_id,
            post.root_id,
            post.message,
            post.create_at,
            post.file_ids ?? [],
          ]),
        )
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
  const fileIds = value.file_ids;
  if (
    fileIds !== undefined &&
    (!Array.isArray(fileIds) ||
      fileIds.length > MATTERMOST_POST_MAX_FILES ||
      fileIds.some((fileId) => typeof fileId !== 'string' || !isValidIdentityComponent(fileId)) ||
      new Set(fileIds).size !== fileIds.length)
  ) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    isValidIdentityComponent(value.id) &&
    typeof value.channel_id === 'string' &&
    isValidIdentityComponent(value.channel_id) &&
    typeof value.user_id === 'string' &&
    isValidIdentityComponent(value.user_id) &&
    typeof value.root_id === 'string' &&
    (value.root_id.length === 0 || isValidIdentityComponent(value.root_id)) &&
    typeof value.message === 'string' &&
    typeof value.create_at === 'number' &&
    Number.isSafeInteger(value.create_at) &&
    value.create_at >= 0 &&
    !Number.isNaN(new Date(value.create_at).getTime())
  );
}
