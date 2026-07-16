import { getDb } from '../db/connection.js';
import {
  classifyMattermostReceiptRetention,
  pruneMattermostCompletedPostReceipts,
} from '../db/mattermost-receipt-retention.js';
import { MATTERMOST_POST_MAX_FILES, mattermostRetryDelayMs } from './mattermost-outbound.js';

const SAFE_MATTERMOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CATCH_UP_PAGE_SIZE = 200;

type MattermostCatchUpPost = Record<string, unknown> & {
  id: string;
  channel_id: string;
  user_id: string;
  root_id: string;
  message: string;
  create_at: number;
  file_ids?: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeMattermostId(value: string): boolean {
  return value.length <= 128 && SAFE_MATTERMOST_ID.test(value);
}

function parseMattermostCatchUpPage(
  body: unknown,
  channelId: string,
  allowValidatedUnreferencedPosts = false,
): MattermostCatchUpPost[] {
  if (!isRecord(body) || !Array.isArray(body.order) || !isRecord(body.posts)) {
    throw new Error('Mattermost catch-up response was invalid');
  }
  const order = body.order;
  const postsById = body.posts;
  const seenPostIds = new Set<string>();

  const parsePost = (postId: string): MattermostCatchUpPost => {
    if (!isSafeMattermostId(postId)) {
      throw new Error('Mattermost catch-up response was invalid');
    }
    const post = postsById[postId];
    if (
      !isRecord(post) ||
      post.id !== postId ||
      typeof post.user_id !== 'string' ||
      !isSafeMattermostId(post.user_id) ||
      typeof post.root_id !== 'string' ||
      (post.root_id.length > 0 && !isSafeMattermostId(post.root_id)) ||
      typeof post.message !== 'string' ||
      typeof post.create_at !== 'number' ||
      !Number.isSafeInteger(post.create_at) ||
      post.create_at < 0 ||
      (post.file_ids !== undefined &&
        (!Array.isArray(post.file_ids) ||
          post.file_ids.length > MATTERMOST_POST_MAX_FILES ||
          post.file_ids.some((fileId) => typeof fileId !== 'string' || !isSafeMattermostId(fileId)) ||
          new Set(post.file_ids).size !== post.file_ids.length))
    ) {
      throw new Error('Mattermost catch-up response was invalid');
    }
    if (post.channel_id !== channelId) {
      throw new Error('Mattermost catch-up post channel mismatch');
    }
    return post as MattermostCatchUpPost;
  };
  const posts = order.map((postId) => {
    if (typeof postId !== 'string' || seenPostIds.has(postId)) {
      throw new Error('Mattermost catch-up response was invalid');
    }
    seenPostIds.add(postId);
    return parsePost(postId);
  });
  const responsePostIds = Object.keys(postsById);
  for (const postId of responsePostIds) {
    if (seenPostIds.has(postId)) continue;
    if (!allowValidatedUnreferencedPosts) throw new Error('Mattermost catch-up response was invalid');
    parsePost(postId);
  }

  return posts;
}

function mattermostPostedFrame(post: MattermostCatchUpPost): string {
  return JSON.stringify({ event: 'posted', data: { post: JSON.stringify(post) } });
}

export function parseMattermostCatchUpPosts(body: unknown, channelId: string): string[] {
  return parseMattermostCatchUpPage(body, channelId)
    .slice()
    .sort((left, right) => {
      const created = left.create_at - right.create_at;
      return created || left.id.localeCompare(right.id);
    })
    .map(mattermostPostedFrame);
}

export interface MattermostRecoveryConfig {
  baseUrl: string;
  botToken: string;
  instanceKey: string;
}

export interface MattermostRecoveryTransport {
  request(request: {
    method: 'GET';
    url: string;
    headers: Record<string, string>;
  }): Promise<{ status: number; body: unknown; headers?: Readonly<Record<string, string>> }>;
}

export type MattermostRecoverySink = (payload: string) => boolean | Promise<boolean>;

export interface MattermostRecoveryDependencies {
  sleep?(delayMs: number): Promise<void>;
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  stateSink?: MattermostRecoveryStateSink;
  failedHeadId?(platformId: string): string | undefined;
  approvalRecovery?: {
    hasWork(): boolean;
    reconcile(currentChannelIds: ReadonlySet<string>): Promise<void>;
    bootstrapLegacy(): { seeded: number; rejected: number };
  };
}

export interface MattermostRecoveredChannelMetadata {
  platformId: string;
  name: string;
  isGroup: true;
}

export interface MattermostRecoveryStateSink {
  onMetadata(metadata: MattermostRecoveredChannelMetadata): void | Promise<void>;
  onBotRemoved(platformId: string): void | Promise<void>;
}

const defaultSleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));

export class MattermostRecoveryCoordinator {
  private activeRecovery: Promise<void> | null = null;

  constructor(
    private readonly config: MattermostRecoveryConfig,
    private readonly transport: MattermostRecoveryTransport,
    private readonly sink: MattermostRecoverySink,
    private readonly dependencies: MattermostRecoveryDependencies = {},
  ) {}

  async recoverActiveChannels(): Promise<void> {
    if (this.activeRecovery) return this.activeRecovery;
    const execution = this.recoverAllActiveChannels();
    this.activeRecovery = execution;
    try {
      await execution;
    } finally {
      if (this.activeRecovery === execution) this.activeRecovery = null;
    }
  }

  async drain(): Promise<void> {
    await this.activeRecovery;
  }

  private async recoverAllActiveChannels(): Promise<void> {
    let channels = listActiveMattermostRecoveryChannels(this.config.instanceKey);
    const stateSink = this.dependencies.stateSink;
    const approvalRecovery = this.dependencies.approvalRecovery;
    const approvalWork = approvalRecovery?.hasWork() ?? false;
    if (approvalWork && !stateSink) {
      throw new Error('Mattermost approval recovery requires authenticated channel state');
    }
    const currentChannels =
      stateSink && (channels.length > 0 || approvalWork) ? await this.loadCurrentChannelState() : null;
    if (currentChannels && approvalRecovery) {
      const currentApprovalChannelIds = new Set(
        [...currentChannels]
          .filter(([, current]) => (current.type === 'O' || current.type === 'P') && current.deleteAt === 0)
          .map(([channelId]) => channelId),
      );
      await approvalRecovery.reconcile(currentApprovalChannelIds);
      approvalRecovery.bootstrapLegacy();
      channels = listActiveMattermostRecoveryChannels(this.config.instanceKey);
    }
    if (currentChannels) {
      for (const channel of channels) {
        const current = currentChannels.get(channel.channelId);
        if (current && ((current.type !== 'O' && current.type !== 'P') || current.deleteAt !== 0)) {
          throw new Error('Mattermost channel-state active subscription identity was invalid');
        }
      }
    }
    for (const channel of channels) {
      const current = currentChannels?.get(channel.channelId);
      const platformId = `mattermost:${this.config.instanceKey}:${channel.channelId}`;
      if (currentChannels && !current) {
        await stateSink!.onBotRemoved(platformId);
        continue;
      }
      await this.recoverChannel(channel);
      if (current) {
        await stateSink!.onMetadata({
          platformId,
          name: current.displayName,
          isGroup: true,
        });
      }
    }
  }

  private async loadCurrentChannelState(): Promise<Map<string, MattermostCurrentChannel>> {
    const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
    const response = await this.requestWithRetry(
      {
        method: 'GET',
        url: `${baseUrl}/api/v4/users/me/channels?include_deleted=false`,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.botToken}`,
        },
      },
      'Mattermost channel-state request failed',
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Mattermost channel-state recovery failed (HTTP ${response.status})`);
    }
    return parseMattermostCurrentChannels(response.body);
  }

  private async recoverChannel(channel: MattermostRecoveryChannel): Promise<void> {
    if (channel.lastPostId === null) {
      if (channel.lastPostCreatedAt !== 0) throw new Error('Mattermost catch-up cursor was incomplete');
      throw new Error('Mattermost recovery bootstrap is required');
    }
    const response = await this.requestCatchUpWindow(channel.channelId);
    if (isRecord(response.body) && response.body.first_inaccessible_post_time !== undefined) {
      const firstInaccessiblePostTime = response.body.first_inaccessible_post_time;
      if (
        typeof firstInaccessiblePostTime !== 'number' ||
        !Number.isSafeInteger(firstInaccessiblePostTime) ||
        firstInaccessiblePostTime < 0
      ) {
        throw new Error('Mattermost catch-up response was invalid');
      }
      if (firstInaccessiblePostTime > 0) throw new Error('Mattermost catch-up response was filtered');
    }
    const windowPosts = parseMattermostCatchUpPage(response.body, channel.channelId, true);
    if (windowPosts.length > CATCH_UP_PAGE_SIZE) {
      throw new Error('Mattermost catch-up could not prove a complete window');
    }
    for (let index = 1; index < windowPosts.length; index += 1) {
      if (windowPosts[index]!.create_at > windowPosts[index - 1]!.create_at) {
        throw new Error('Mattermost catch-up response order was invalid');
      }
    }
    const watermarkIndex = windowPosts.findIndex((post) => post.id === channel.lastPostId);
    if (watermarkIndex < 0) {
      throw new Error('Mattermost catch-up durable watermark was not found');
    }
    const watermark = windowPosts[watermarkIndex]!;
    if (watermark.create_at !== channel.lastPostCreatedAt) {
      throw new Error('Mattermost catch-up durable watermark identity changed');
    }
    const boundary = windowPosts.at(-1);
    if (
      windowPosts.length === CATCH_UP_PAGE_SIZE &&
      boundary !== undefined &&
      boundary.create_at === watermark.create_at
    ) {
      throw new Error('Mattermost catch-up could not prove a complete timestamp cohort');
    }
    let posts = windowPosts
      .filter((post) => post.id !== watermark.id && post.create_at >= watermark.create_at)
      .reverse();
    const failedHeadId = this.dependencies.failedHeadId?.(`mattermost:${this.config.instanceKey}:${channel.channelId}`);
    if (failedHeadId) {
      const failedHeadIndex = posts.findIndex((post) => post.id === failedHeadId);
      if (failedHeadIndex > 0) {
        const [failedHead] = posts.splice(failedHeadIndex, 1);
        if (failedHead) posts = [failedHead, ...posts];
      }
    }
    for (const post of posts) await this.sink(mattermostPostedFrame(post));
    const lastPost = posts.at(-1);
    if (!lastPost) return;
    advanceMattermostRecoveryCursor({
      instanceKey: this.config.instanceKey,
      channelId: channel.channelId,
      lastPostCreatedAt: lastPost.create_at,
      lastPostId: lastPost.id,
    });
  }

  private async requestCatchUpWindow(
    channelId: string,
  ): Promise<Awaited<ReturnType<MattermostRecoveryTransport['request']>>> {
    const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
    const request = {
      method: 'GET',
      url: `${baseUrl}/api/v4/channels/${encodeURIComponent(channelId)}/posts?per_page=${CATCH_UP_PAGE_SIZE}&skipFetchThreads=true`,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.config.botToken}`,
      },
    } as const;
    const response = await this.requestWithRetry(request, 'Mattermost catch-up request failed');
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Mattermost catch-up failed (HTTP ${response.status})`);
    }
    return response;
  }

  private async requestWithRetry(
    request: Parameters<MattermostRecoveryTransport['request']>[0],
    transportFailureMessage: string,
  ): Promise<Awaited<ReturnType<MattermostRecoveryTransport['request']>>> {
    const maxAttempts = this.dependencies.maxAttempts ?? 3;
    const sleep = this.dependencies.sleep ?? defaultSleep;
    const retryPolicy = {
      maxAttempts,
      baseDelayMs: this.dependencies.baseRetryDelayMs ?? 250,
      maxDelayMs: this.dependencies.maxRetryDelayMs ?? 30_000,
    };
    let response: Awaited<ReturnType<MattermostRecoveryTransport['request']>> | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        response = await this.transport.request(request);
      } catch {
        const retryDelayMs = mattermostRetryDelayMs({ status: 503 }, attempt, retryPolicy);
        if (retryDelayMs === null) {
          // Raw transport errors may embed Authorization headers. This boundary
          // deliberately replaces, rather than chains, that credential-bearing cause.
          // eslint-disable-next-line preserve-caught-error
          throw new Error(transportFailureMessage);
        }
        await sleep(retryDelayMs);
        continue;
      }
      const retryDelayMs = mattermostRetryDelayMs(response, attempt, retryPolicy);
      if (retryDelayMs === null) break;
      await sleep(retryDelayMs);
    }
    if (!response) throw new Error(transportFailureMessage);
    return response;
  }
}

interface MattermostCurrentChannel {
  displayName: string;
  type: string;
  deleteAt: number;
}

function parseMattermostCurrentChannels(body: unknown): Map<string, MattermostCurrentChannel> {
  if (!Array.isArray(body)) throw new Error('Mattermost channel-state response was invalid');
  const channels = new Map<string, MattermostCurrentChannel>();
  for (const value of body) {
    if (!isRecord(value)) throw new Error('Mattermost channel-state response was invalid');
    const id = value.id;
    const name = value.name;
    const displayName = value.display_name;
    const type = value.type;
    const deleteAt = value.delete_at;
    if (
      typeof id !== 'string' ||
      id.length > 128 ||
      !SAFE_MATTERMOST_ID.test(id) ||
      channels.has(id) ||
      typeof name !== 'string' ||
      typeof displayName !== 'string' ||
      typeof type !== 'string' ||
      !Number.isSafeInteger(deleteAt) ||
      (deleteAt as number) < 0
    ) {
      throw new Error('Mattermost channel-state response was invalid');
    }
    const label = displayName.trim() || name.trim();
    if (!label) throw new Error('Mattermost channel-state response was invalid');
    channels.set(id, { displayName: label, type, deleteAt: deleteAt as number });
  }
  return channels;
}

export interface MattermostPostReceiptIdentity {
  instanceKey: string;
  postId: string;
  channelId: string;
  createAt: number;
  payloadDigest: string;
}

type MattermostPostReceiptRow = {
  instance_key: string;
  post_id: string;
  channel_id: string;
  create_at: number;
  payload_digest: string;
  status: 'processing' | 'completed';
};

export function claimMattermostPostReceipt(
  input: MattermostPostReceiptIdentity,
): 'claimed' | 'processing' | 'completed' {
  return getDb()
    .transaction(() => {
      const existing = getDb()
        .prepare('SELECT * FROM mattermost_post_receipts WHERE instance_key = ? AND post_id = ?')
        .get(input.instanceKey, input.postId) as MattermostPostReceiptRow | undefined;
      if (existing) {
        if (
          existing.channel_id !== input.channelId ||
          existing.create_at !== input.createAt ||
          existing.payload_digest !== input.payloadDigest
        ) {
          throw new Error('Mattermost post receipt identity collision');
        }
        return existing.status;
      }
      if (classifyMattermostReceiptRetention(getDb(), input) === 'retired') return 'completed' as const;
      getDb()
        .prepare(
          `INSERT INTO mattermost_post_receipts (
             instance_key, post_id, channel_id, create_at, payload_digest,
             status, claimed_at, completed_at
           ) VALUES (?, ?, ?, ?, ?, 'processing', ?, NULL)`,
        )
        .run(
          input.instanceKey,
          input.postId,
          input.channelId,
          input.createAt,
          input.payloadDigest,
          new Date().toISOString(),
        );
      return 'claimed' as const;
    })
    .immediate();
}

export function completeMattermostPostReceipt(input: MattermostPostReceiptIdentity, completedAt: string): boolean {
  return getDb()
    .transaction(() => {
      const updated = getDb()
        .prepare(
          `UPDATE mattermost_post_receipts
              SET status = 'completed', completed_at = ?
            WHERE instance_key = ? AND post_id = ?
              AND channel_id = ? AND create_at = ? AND payload_digest = ?
              AND status = 'processing'`,
        )
        .run(completedAt, input.instanceKey, input.postId, input.channelId, input.createAt, input.payloadDigest);
      const completed =
        updated.changes === 1 ||
        getDb()
          .prepare(
            `SELECT 1 FROM mattermost_post_receipts
              WHERE instance_key = ? AND post_id = ?
                AND channel_id = ? AND create_at = ? AND payload_digest = ?
                AND status = 'completed'`,
          )
          .get(input.instanceKey, input.postId, input.channelId, input.createAt, input.payloadDigest) !== undefined;
      if (!completed) return false;
      advanceMattermostRecoveryCursor({
        instanceKey: input.instanceKey,
        channelId: input.channelId,
        lastPostCreatedAt: input.createAt,
        lastPostId: input.postId,
      });
      pruneMattermostCompletedPostReceipts(
        getDb(),
        { instanceKey: input.instanceKey, channelId: input.channelId },
        completedAt,
      );
      return true;
    })
    .immediate();
}

export function releaseMattermostPostReceipt(input: MattermostPostReceiptIdentity): boolean {
  return (
    getDb()
      .prepare(
        `DELETE FROM mattermost_post_receipts
          WHERE instance_key = ? AND post_id = ?
            AND channel_id = ? AND create_at = ? AND payload_digest = ?
            AND status = 'processing'`,
      )
      .run(input.instanceKey, input.postId, input.channelId, input.createAt, input.payloadDigest).changes === 1
  );
}

export function resetMattermostProcessingReceipts(instanceKey: string): number {
  return getDb()
    .prepare("DELETE FROM mattermost_post_receipts WHERE instance_key = ? AND status = 'processing'")
    .run(instanceKey).changes;
}

export interface MattermostRecoveryChannel {
  channelId: string;
  lastPostCreatedAt: number;
  lastPostId: string | null;
}

export function listActiveMattermostRecoveryChannels(instanceKey: string): MattermostRecoveryChannel[] {
  const rows = getDb()
    .prepare(
      `SELECT ms.channel_id,
              COALESCE(cursor.last_post_created_at, 0) AS last_post_created_at,
              cursor.last_post_id
         FROM mattermost_subscriptions ms
         LEFT JOIN mattermost_recovery_cursors cursor
           ON cursor.instance_key = ms.instance_key AND cursor.channel_id = ms.channel_id
        WHERE ms.instance_key = ? AND ms.status = 'active'
        ORDER BY ms.channel_id`,
    )
    .all(instanceKey) as Array<{
    channel_id: string;
    last_post_created_at: number;
    last_post_id: string | null;
  }>;
  return rows.map((row) => ({
    channelId: row.channel_id,
    lastPostCreatedAt: row.last_post_created_at,
    lastPostId: row.last_post_id,
  }));
}

export function advanceMattermostRecoveryCursor(input: {
  instanceKey: string;
  channelId: string;
  lastPostCreatedAt: number;
  lastPostId: string;
}): boolean {
  if (!Number.isSafeInteger(input.lastPostCreatedAt) || input.lastPostCreatedAt < 0 || input.lastPostId.length === 0) {
    return false;
  }
  return getDb()
    .transaction(() => {
      const active = getDb()
        .prepare(
          `SELECT 1 FROM mattermost_subscriptions
            WHERE instance_key = ? AND channel_id = ? AND status = 'active'`,
        )
        .get(input.instanceKey, input.channelId);
      if (!active) return false;
      const existing = getDb()
        .prepare(
          `SELECT last_post_created_at, last_post_id
             FROM mattermost_recovery_cursors
            WHERE instance_key = ? AND channel_id = ?`,
        )
        .get(input.instanceKey, input.channelId) as
        | { last_post_created_at: number; last_post_id: string | null }
        | undefined;
      if (
        existing &&
        (input.lastPostCreatedAt < existing.last_post_created_at ||
          (input.lastPostCreatedAt === existing.last_post_created_at &&
            input.lastPostId <= (existing.last_post_id ?? '')))
      ) {
        return false;
      }
      getDb()
        .prepare(
          `INSERT INTO mattermost_recovery_cursors (
             instance_key, channel_id, last_post_created_at, last_post_id, updated_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(instance_key, channel_id) DO UPDATE SET
             last_post_created_at = excluded.last_post_created_at,
             last_post_id = excluded.last_post_id,
             updated_at = excluded.updated_at`,
        )
        .run(input.instanceKey, input.channelId, input.lastPostCreatedAt, input.lastPostId, new Date().toISOString());
      return true;
    })
    .immediate();
}
