import { createHash } from 'node:crypto';

import { log } from '../log.js';
import { UnconfirmedAttachmentDeliveryError, type OutboundFile, type OutboundMessage } from './adapter.js';
import type { MattermostHttpRequest, MattermostHttpResponse, MattermostTransport } from './mattermost-client.js';

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
export const MATTERMOST_POST_MAX_FILES = 5;
const SAFE_MATTERMOST_ID_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface MattermostPostPayloadInput {
  instanceKey: string;
  channelId: string;
  threadId: string | null;
  deliveryId?: string;
  content: unknown;
  allowMassMentions: boolean;
  fileIds?: readonly string[];
}

export interface MattermostPostPayload {
  channel_id: string;
  message: string;
  pending_post_id: string;
  root_id?: string;
  file_ids?: string[];
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
    const deliveryId = outbound.deliveryId;
    const attachmentCount = Array.isArray(outbound.files) ? outbound.files.length : 0;
    const byteTotal = Array.isArray(outbound.files)
      ? outbound.files.reduce((total, file) => total + (Buffer.isBuffer(file?.data) ? file.data.length : 0), 0)
      : 0;
    let stage: MattermostOutboundStage = 'validation';
    let postId: string | undefined;
    let hasValidatedAttachments = false;
    try {
      const channelId = parseChannelId(platformId, this.config.instanceKey);
      const files = validateOutboundFiles(outbound.files);
      hasValidatedAttachments = files.length > 0;
      const payloadInput: MattermostPostPayloadInput = {
        instanceKey: this.config.instanceKey,
        channelId,
        threadId,
        deliveryId,
        content: outbound.content,
        allowMassMentions: this.config.allowMassMentions === true,
      };
      const payloadBase = buildMattermostPostPayloadBase(payloadInput, files.length > 0);
      const retryPolicy = this.retryPolicy();
      stage = files.length > 0 ? 'upload' : 'post';
      const fileIds = files.length > 0 ? await this.uploadFiles(channelId, files, retryPolicy) : [];
      if (files.length > 0) {
        log.info('Mattermost outbound stage completed', {
          deliveryId,
          stage: 'upload',
          attachmentCount,
          byteTotal,
        });
      }
      const payload: MattermostPostPayload = {
        ...payloadBase,
        ...(fileIds.length > 0 ? { file_ids: fileIds } : {}),
      };
      const request: MattermostHttpRequest = {
        method: 'POST',
        url: `${this.config.baseUrl.replace(/\/+$/, '')}/api/v4/posts`,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      };

      stage = 'post';
      const response = await this.requestWithRetries(request, retryPolicy, 'Mattermost delivery request failed');
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Mattermost delivery failed (HTTP ${response.status})`);
      }
      postId = responsePostId(response.body) ?? undefined;
      if (!postId) throw new Error('Mattermost delivery response was invalid');
      if (fileIds.length > 0 && !responseConfirmsFileAssociations(response.body, fileIds)) {
        throw new Error('Mattermost delivery response did not confirm file associations');
      }
      log.info('Mattermost outbound stage completed', {
        deliveryId,
        postId,
        stage,
        attachmentCount,
        byteTotal,
      });
      return postId;
    } catch (err) {
      log.warn('Mattermost outbound delivery failed', {
        deliveryId,
        ...(postId ? { postId } : {}),
        stage,
        attachmentCount,
        byteTotal,
        failureCategory: mattermostOutboundFailureCategory(err),
      });
      if (hasValidatedAttachments && stage !== 'validation') {
        const message = err instanceof Error ? err.message : 'Mattermost attachment delivery was not confirmed';
        throw new UnconfirmedAttachmentDeliveryError(message, mattermostOutboundFailureCategory(err));
      }
      throw err;
    }
  }

  private retryPolicy(): MattermostRetryPolicy {
    return {
      maxAttempts: this.dependencies.maxAttempts ?? 3,
      baseDelayMs: this.dependencies.baseRetryDelayMs ?? 250,
      maxDelayMs: this.dependencies.maxRetryDelayMs ?? 30_000,
    };
  }

  private async uploadFiles(
    channelId: string,
    files: readonly OutboundFile[],
    retryPolicy: MattermostRetryPolicy,
  ): Promise<string[]> {
    const form = new FormData();
    for (const file of files) {
      form.append('files', new Blob([file.data]), file.filename);
    }
    const request: MattermostHttpRequest = {
      method: 'POST',
      url: `${this.config.baseUrl.replace(/\/+$/, '')}/api/v4/files?channel_id=${encodeURIComponent(channelId)}`,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.config.botToken}`,
      },
      body: form,
    };
    const response = await this.requestWithRetries(request, retryPolicy, 'Mattermost file upload request failed');
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Mattermost file upload failed (HTTP ${response.status})`);
    }
    const fileIds = responseUploadFileIds(response.body, files.length);
    if (!fileIds) throw new Error('Mattermost file upload response was invalid');
    return fileIds;
  }

  private async requestWithRetries(
    request: MattermostHttpRequest,
    retryPolicy: MattermostRetryPolicy,
    transportFailureMessage: string,
  ): Promise<MattermostHttpResponse> {
    const sleep = this.dependencies.sleep ?? defaultSleep;
    for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
      const response = await this.transport.request(request).catch(() => {
        throw new Error(transportFailureMessage);
      });
      const retryDelayMs = mattermostRetryDelayMs(response, attempt, retryPolicy);
      if (retryDelayMs !== null) {
        await sleep(retryDelayMs);
        continue;
      }
      return response;
    }
    throw new Error('Mattermost delivery attempts exhausted');
  }
}

type MattermostOutboundStage = 'validation' | 'upload' | 'post';

function mattermostOutboundFailureCategory(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown';
  if (err.message.endsWith('request failed')) return 'transport';
  if (/\(HTTP \d+\)$/.test(err.message)) return 'http';
  if (err.message.includes('did not confirm file associations')) return 'association_mismatch';
  if (err.message.endsWith('response was invalid')) return 'invalid_response';
  if (
    err.message.startsWith('Invalid Mattermost') ||
    err.message.startsWith('Mattermost outbound content exceeds') ||
    err.message === 'Mattermost delivery requires a stable delivery id'
  ) {
    return 'validation';
  }
  return 'unknown';
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
  const fileIds = validateMattermostFileIds(input.fileIds ?? []);
  return {
    ...buildMattermostPostPayloadBase(input, fileIds.length > 0),
    ...(fileIds.length > 0 ? { file_ids: fileIds } : {}),
  };
}

function buildMattermostPostPayloadBase(
  input: MattermostPostPayloadInput,
  allowEmptyMessage: boolean,
): Omit<MattermostPostPayload, 'file_ids'> {
  const rawMessage = outboundText(input.content, allowEmptyMessage);
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

function outboundText(content: unknown, allowEmpty: boolean): string {
  if (!content || typeof content !== 'object') throw new Error('Invalid Mattermost outbound content');
  const markdown = (content as Record<string, unknown>).markdown;
  if (typeof markdown === 'string' && markdown.trim().length > 0) return markdown;
  const text = (content as Record<string, unknown>).text;
  if (typeof text === 'string' && text.trim().length > 0) return text;
  if (allowEmpty) return '';
  throw new Error('Invalid Mattermost outbound content');
}

function validateOutboundFiles(files: OutboundFile[] | undefined): OutboundFile[] {
  if (files === undefined) return [];
  if (!Array.isArray(files) || files.length > MATTERMOST_POST_MAX_FILES) {
    throw new Error('Invalid Mattermost outbound files');
  }
  for (const file of files) {
    if (
      !file ||
      typeof file !== 'object' ||
      typeof file.filename !== 'string' ||
      file.filename.trim().length === 0 ||
      file.filename.includes('\0') ||
      !Buffer.isBuffer(file.data)
    ) {
      throw new Error('Invalid Mattermost outbound files');
    }
  }
  return files;
}

function validateMattermostFileIds(fileIds: readonly string[]): string[] {
  if (!Array.isArray(fileIds) || fileIds.length > MATTERMOST_POST_MAX_FILES) {
    throw new Error('Invalid Mattermost file ids');
  }
  const validated = [...fileIds];
  if (validated.some((id) => !SAFE_MATTERMOST_ID_COMPONENT.test(id)) || new Set(validated).size !== validated.length) {
    throw new Error('Invalid Mattermost file ids');
  }
  return validated;
}

function responseUploadFileIds(body: unknown, expectedCount: number): string[] | null {
  if (!body || typeof body !== 'object') return null;
  const fileInfos = (body as Record<string, unknown>).file_infos;
  if (!Array.isArray(fileInfos) || fileInfos.length !== expectedCount) return null;
  const fileIds: string[] = [];
  for (const fileInfo of fileInfos) {
    if (!fileInfo || typeof fileInfo !== 'object') return null;
    const id = (fileInfo as Record<string, unknown>).id;
    if (typeof id !== 'string' || !SAFE_MATTERMOST_ID_COMPONENT.test(id)) return null;
    fileIds.push(id);
  }
  return new Set(fileIds).size === fileIds.length ? fileIds : null;
}

function responseConfirmsFileAssociations(body: unknown, expectedFileIds: readonly string[]): boolean {
  if (!body || typeof body !== 'object') return false;
  const associatedFileIds = (body as Record<string, unknown>).file_ids;
  return (
    Array.isArray(associatedFileIds) &&
    associatedFileIds.length === expectedFileIds.length &&
    associatedFileIds.every((id, index) => id === expectedFileIds[index])
  );
}

function responsePostId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const id = (body as Record<string, unknown>).id;
  return typeof id === 'string' && SAFE_MATTERMOST_ID_COMPONENT.test(id) ? id : null;
}
