import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../db/index.js';
import {
  getMattermostReceiptRetentionFloor,
  MATTERMOST_COMPLETED_RECEIPT_RETENTION_LIMIT,
} from '../db/mattermost-receipt-retention.js';
import { MattermostInboundProcessor } from './mattermost-inbound.js';
import * as recoveryModule from './mattermost-recovery.js';

function seedMattermostSubscription(instanceKey: string, channelId: string, suffix: string): void {
  const db = getDb();
  const createdAt = '2026-07-11T00:00:00.000Z';
  const agentGroupId = `ag-${suffix}`;
  const messagingGroupId = `mg-${suffix}`;
  const wiringId = `mga-${suffix}`;
  db.prepare('INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)').run(
    agentGroupId,
    `Agent ${suffix}`,
    `folder-${suffix}`,
    createdAt,
  );
  db.prepare(
    `INSERT INTO messaging_groups (
       id, channel_type, platform_id, name, is_group, unknown_sender_policy, denied_at, created_at
     ) VALUES (?, 'mattermost', ?, ?, 1, 'strict', NULL, ?)`,
  ).run(messagingGroupId, `mattermost:${instanceKey}:${channelId}`, `Channel ${suffix}`, createdAt);
  db.prepare(
    `INSERT INTO messaging_group_agents (
       id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
       sender_scope, ignored_message_policy, session_mode, priority, created_at
     ) VALUES (?, ?, ?, 'pattern', '.', 'known', 'drop', 'shared', 0, ?)`,
  ).run(wiringId, messagingGroupId, agentGroupId, createdAt);
  db.prepare(
    `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
     VALUES (?, 'channel', 'channel', ?, ?)`,
  ).run(agentGroupId, messagingGroupId, createdAt);
  db.prepare(
    `INSERT INTO mattermost_subscriptions (
       instance_key, channel_id, messaging_group_id, agent_group_id, wiring_id, status, created_at, archived_at
     ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL)`,
  ).run(instanceKey, channelId, messagingGroupId, agentGroupId, wiringId, createdAt);
}

function seedCompletedReceiptOverflow(instanceKey: string, channelId: string, prefix: string): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO mattermost_post_receipts (
       instance_key, post_id, channel_id, create_at, payload_digest,
       status, claimed_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`,
  );
  db.transaction(() => {
    for (let index = 0; index <= MATTERMOST_COMPLETED_RECEIPT_RETENTION_LIMIT; index += 1) {
      const postId = `${prefix}-${String(index).padStart(5, '0')}`;
      insert.run(
        instanceKey,
        postId,
        channelId,
        index + 1,
        `digest-${postId}`,
        '2026-07-11T00:00:00.000Z',
        '2026-07-11T00:00:01.000Z',
      );
    }
  })();
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('Mattermost durable recovery store', () => {
  it('claims one content-free receipt and rejects post identity reuse', () => {
    const claim = (
      recoveryModule as typeof recoveryModule & {
        claimMattermostPostReceipt?: (input: {
          instanceKey: string;
          postId: string;
          channelId: string;
          createAt: number;
          payloadDigest: string;
        }) => 'claimed' | 'processing' | 'completed';
      }
    ).claimMattermostPostReceipt;
    expect(claim).toBeTypeOf('function');
    if (!claim) return;
    const identity = {
      instanceKey: 'primary',
      postId: 'post-1',
      channelId: 'channel-a',
      createAt: 1_700_000_000_000,
      payloadDigest: 'digest-a',
    };

    expect(claim(identity)).toBe('claimed');
    expect(claim(identity)).toBe('processing');
    expect(() => claim({ ...identity, channelId: 'channel-b' })).toThrow('Mattermost post receipt identity collision');
    expect(() => claim({ ...identity, payloadDigest: 'digest-mutated' })).toThrow(
      'Mattermost post receipt identity collision',
    );
  });

  it('checks exact receipts before retiring absent posts below the floor', () => {
    const existing = {
      instanceKey: 'primary',
      postId: 'post-existing-below-floor',
      channelId: 'unknown-channel-a',
      createAt: 99,
      payloadDigest: 'digest-existing',
    };
    expect(recoveryModule.claimMattermostPostReceipt(existing)).toBe('claimed');
    getDb()
      .prepare(
        `INSERT INTO mattermost_receipt_retention_floors (
           instance_key, channel_id, reject_before_create_at, updated_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(existing.instanceKey, existing.channelId, 100, '2026-07-11T00:00:00.000Z');

    expect(recoveryModule.claimMattermostPostReceipt(existing)).toBe('processing');
    expect(() => recoveryModule.claimMattermostPostReceipt({ ...existing, payloadDigest: 'digest-mutated' })).toThrow(
      'Mattermost post receipt identity collision',
    );

    const retired = { ...existing, postId: 'post-absent-below-floor', payloadDigest: 'digest-retired' };
    expect(recoveryModule.claimMattermostPostReceipt(retired)).toBe('completed');
    expect(
      getDb()
        .prepare('SELECT 1 FROM mattermost_post_receipts WHERE instance_key = ? AND post_id = ?')
        .get(retired.instanceKey, retired.postId),
    ).toBeUndefined();

    const equality = { ...existing, postId: 'post-at-floor', createAt: 100, payloadDigest: 'digest-equality' };
    expect(recoveryModule.claimMattermostPostReceipt(equality)).toBe('claimed');
    expect(
      getDb()
        .prepare('SELECT status FROM mattermost_post_receipts WHERE instance_key = ? AND post_id = ?')
        .get(equality.instanceKey, equality.postId),
    ).toEqual({ status: 'processing' });
  });

  it('completes only the exact claimed receipt and deduplicates later sources', () => {
    const identity = {
      instanceKey: 'primary',
      postId: 'post-completed',
      channelId: 'channel-a',
      createAt: 1_700_000_000_001,
      payloadDigest: 'digest-completed',
    };
    recoveryModule.claimMattermostPostReceipt(identity);
    const complete = (
      recoveryModule as typeof recoveryModule & {
        completeMattermostPostReceipt?: (input: typeof identity, completedAt: string) => boolean;
      }
    ).completeMattermostPostReceipt;
    expect(complete).toBeTypeOf('function');
    if (!complete) return;

    expect(complete(identity, '2026-07-11T00:00:00.000Z')).toBe(true);
    expect(recoveryModule.claimMattermostPostReceipt(identity)).toBe('completed');
    expect(complete({ ...identity, channelId: 'channel-b' }, '2026-07-11T00:00:01.000Z')).toBe(false);
  });

  it('atomically completes, advances its cursor, and prunes through a nested transaction', () => {
    seedMattermostSubscription('primary', 'channel-a', 'nested-retention-a');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 50,
      lastPostId: 'post-before-nested-retention',
    });
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO mattermost_post_receipts (
         instance_key, post_id, channel_id, create_at, payload_digest,
         status, claimed_at, completed_at
       ) VALUES ('primary', ?, 'channel-a', ?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      for (let index = 0; index < MATTERMOST_COMPLETED_RECEIPT_RETENTION_LIMIT - 2; index += 1) {
        const postId = `nested-retention-newer-${String(index).padStart(5, '0')}`;
        insert.run(
          postId,
          1_000 + index,
          `digest-${postId}`,
          'completed',
          '2026-07-11T00:00:00.000Z',
          '2026-07-11T00:00:01.000Z',
        );
      }
      for (const postId of ['nested-boundary-z', 'nested-boundary-a', 'nested-boundary-m']) {
        insert.run(
          postId,
          100,
          `digest-${postId}`,
          'completed',
          '2026-07-11T00:00:00.000Z',
          '2026-07-11T00:00:01.000Z',
        );
      }
      insert.run(
        'nested-older',
        99,
        'digest-nested-older',
        'completed',
        '2026-07-11T00:00:00.000Z',
        '2026-07-11T00:00:01.000Z',
      );
      insert.run('nested-current', 20_000, 'digest-nested-current', 'processing', '2026-07-11T00:00:02.000Z', null);
    })();
    const identity = {
      instanceKey: 'primary',
      postId: 'nested-current',
      channelId: 'channel-a',
      createAt: 20_000,
      payloadDigest: 'digest-nested-current',
    };
    db.exec(`
      CREATE TRIGGER fail_nested_receipt_prune
      BEFORE DELETE ON mattermost_post_receipts
      WHEN OLD.instance_key = 'primary' AND OLD.channel_id = 'channel-a'
      BEGIN
        SELECT RAISE(ABORT, 'injected nested receipt prune failure');
      END;
    `);

    expect(() => recoveryModule.completeMattermostPostReceipt(identity, '2026-07-11T00:00:03.000Z')).toThrow(
      'injected nested receipt prune failure',
    );
    expect(db.prepare("SELECT status FROM mattermost_post_receipts WHERE post_id = 'nested-current'").get()).toEqual({
      status: 'processing',
    });
    expect(recoveryModule.listActiveMattermostRecoveryChannels('primary')).toEqual([
      { channelId: 'channel-a', lastPostCreatedAt: 50, lastPostId: 'post-before-nested-retention' },
    ]);
    expect(getMattermostReceiptRetentionFloor(db, { instanceKey: 'primary', channelId: 'channel-a' })).toBeNull();
    expect(db.prepare("SELECT 1 FROM mattermost_post_receipts WHERE post_id = 'nested-older'").get()).toEqual({
      '1': 1,
    });

    db.exec('DROP TRIGGER fail_nested_receipt_prune');
    expect(recoveryModule.completeMattermostPostReceipt(identity, '2026-07-11T00:00:03.000Z')).toBe(true);
    expect(recoveryModule.listActiveMattermostRecoveryChannels('primary')).toEqual([
      { channelId: 'channel-a', lastPostCreatedAt: 20_000, lastPostId: 'nested-current' },
    ]);
    expect(getMattermostReceiptRetentionFloor(db, { instanceKey: 'primary', channelId: 'channel-a' })).toBe(100);
    expect(db.prepare("SELECT 1 FROM mattermost_post_receipts WHERE post_id = 'nested-older'").get()).toBeUndefined();
    expect(
      db
        .prepare(
          `SELECT post_id
             FROM mattermost_post_receipts
            WHERE instance_key = 'primary' AND channel_id = 'channel-a' AND create_at = 100
            ORDER BY post_id`,
        )
        .all(),
    ).toEqual([{ post_id: 'nested-boundary-a' }, { post_id: 'nested-boundary-m' }, { post_id: 'nested-boundary-z' }]);
  });

  it('advances an active channel cursor when a WebSocket receipt completes', () => {
    seedMattermostSubscription('primary', 'channel-a', 'websocket-cursor-a');
    const identity = {
      instanceKey: 'primary',
      postId: 'post-websocket-completed',
      channelId: 'channel-a',
      createAt: 1_700_000_000_050,
      payloadDigest: 'digest-websocket-completed',
    };
    recoveryModule.claimMattermostPostReceipt(identity);

    expect(recoveryModule.completeMattermostPostReceipt(identity, '2026-07-11T00:00:00.000Z')).toBe(true);

    expect(recoveryModule.listActiveMattermostRecoveryChannels('primary')).toEqual([
      {
        channelId: 'channel-a',
        lastPostCreatedAt: identity.createAt,
        lastPostId: identity.postId,
      },
    ]);
  });

  it('releases only the exact failed receipt for a source retry', () => {
    const identity = {
      instanceKey: 'primary',
      postId: 'post-failed',
      channelId: 'channel-a',
      createAt: 1_700_000_000_002,
      payloadDigest: 'digest-failed',
    };
    recoveryModule.claimMattermostPostReceipt(identity);
    const release = (
      recoveryModule as typeof recoveryModule & {
        releaseMattermostPostReceipt?: (input: typeof identity) => boolean;
      }
    ).releaseMattermostPostReceipt;
    expect(release).toBeTypeOf('function');
    if (!release) return;

    expect(release({ ...identity, payloadDigest: 'different' })).toBe(false);
    expect(release(identity)).toBe(true);
    expect(recoveryModule.claimMattermostPostReceipt(identity)).toBe('claimed');
  });

  it('resets only crash-left processing receipts for the configured instance', () => {
    const processing = {
      instanceKey: 'primary',
      postId: 'post-processing',
      channelId: 'channel-a',
      createAt: 1_700_000_000_003,
      payloadDigest: 'digest-processing',
    };
    const completed = { ...processing, postId: 'post-completed-retained', payloadDigest: 'digest-retained' };
    const otherInstance = {
      ...processing,
      instanceKey: 'secondary',
      postId: 'post-secondary',
      payloadDigest: 'digest-secondary',
    };
    recoveryModule.claimMattermostPostReceipt(processing);
    recoveryModule.claimMattermostPostReceipt(completed);
    recoveryModule.completeMattermostPostReceipt(completed, '2026-07-11T00:00:00.000Z');
    recoveryModule.claimMattermostPostReceipt(otherInstance);
    getDb()
      .prepare(
        `INSERT INTO mattermost_receipt_retention_floors (
           instance_key, channel_id, reject_before_create_at, updated_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(processing.instanceKey, processing.channelId, processing.createAt, '2026-07-11T00:00:01.000Z');
    const reset = (
      recoveryModule as typeof recoveryModule & {
        resetMattermostProcessingReceipts?: (instanceKey: string) => number;
      }
    ).resetMattermostProcessingReceipts;
    expect(reset).toBeTypeOf('function');
    if (!reset) return;

    expect(reset('primary')).toBe(1);
    expect(recoveryModule.claimMattermostPostReceipt(processing)).toBe('claimed');
    expect(recoveryModule.completeMattermostPostReceipt(processing, '2026-07-11T00:00:02.000Z')).toBe(true);
    expect(recoveryModule.claimMattermostPostReceipt(processing)).toBe('completed');
    expect(recoveryModule.claimMattermostPostReceipt(completed)).toBe('completed');
    expect(recoveryModule.claimMattermostPostReceipt(otherInstance)).toBe('processing');
  });

  it('lists only active strict subscriptions for the configured instance', () => {
    seedMattermostSubscription('primary', 'channel-a', 'primary-a');
    seedMattermostSubscription('primary', 'channel-inactive', 'primary-inactive');
    seedMattermostSubscription('secondary', 'channel-b', 'secondary-b');
    getDb()
      .prepare("UPDATE mattermost_subscriptions SET status = 'unsubscribed' WHERE channel_id = 'channel-inactive'")
      .run();
    const list = (
      recoveryModule as typeof recoveryModule & {
        listActiveMattermostRecoveryChannels?: (instanceKey: string) => Array<{
          channelId: string;
          lastPostCreatedAt: number;
          lastPostId: string | null;
        }>;
      }
    ).listActiveMattermostRecoveryChannels;
    expect(list).toBeTypeOf('function');
    if (!list) return;

    expect(list('primary')).toEqual([{ channelId: 'channel-a', lastPostCreatedAt: 0, lastPostId: null }]);
  });

  it('advances an active channel watermark by time while retaining the latest exact anchor', () => {
    seedMattermostSubscription('primary', 'channel-a', 'primary-a');
    seedMattermostSubscription('primary', 'channel-inactive', 'primary-inactive');
    getDb()
      .prepare("UPDATE mattermost_subscriptions SET status = 'unsubscribed' WHERE channel_id = 'channel-inactive'")
      .run();
    const advance = (
      recoveryModule as typeof recoveryModule & {
        advanceMattermostRecoveryCursor?: (input: {
          instanceKey: string;
          channelId: string;
          lastPostCreatedAt: number;
          lastPostId: string;
        }) => boolean;
      }
    ).advanceMattermostRecoveryCursor;
    expect(advance).toBeTypeOf('function');
    if (!advance) return;

    expect(
      advance({ instanceKey: 'primary', channelId: 'channel-a', lastPostCreatedAt: 100, lastPostId: 'post-a' }),
    ).toBe(true);
    expect(
      advance({ instanceKey: 'primary', channelId: 'channel-a', lastPostCreatedAt: 99, lastPostId: 'post-z' }),
    ).toBe(false);
    expect(
      advance({ instanceKey: 'primary', channelId: 'channel-a', lastPostCreatedAt: 100, lastPostId: 'post-b' }),
    ).toBe(true);
    expect(
      advance({ instanceKey: 'primary', channelId: 'channel-a', lastPostCreatedAt: 100, lastPostId: 'post-0' }),
    ).toBe(false);
    expect(
      advance({
        instanceKey: 'primary',
        channelId: 'channel-inactive',
        lastPostCreatedAt: 200,
        lastPostId: 'post-inactive',
      }),
    ).toBe(false);
    expect(recoveryModule.listActiveMattermostRecoveryChannels('primary')).toEqual([
      { channelId: 'channel-a', lastPostCreatedAt: 100, lastPostId: 'post-b' },
    ]);
  });

  it('deduplicates the same post across processor restart and source overlap', async () => {
    const onInbound = vi.fn().mockResolvedValue(undefined);
    const receiptStore = {
      claim: recoveryModule.claimMattermostPostReceipt,
      complete: recoveryModule.completeMattermostPostReceipt,
      release: recoveryModule.releaseMattermostPostReceipt,
    };
    const payload = JSON.stringify({
      event: 'posted',
      data: {
        sender_name: 'Ada',
        post: JSON.stringify({
          id: 'post-overlap',
          channel_id: 'channel-a',
          user_id: 'user-a',
          root_id: '',
          message: 'same post from WebSocket and REST',
          create_at: 1_700_000_000_010,
        }),
      },
    });

    const firstProcess = new MattermostInboundProcessor(
      { instanceKey: 'primary', botUserId: 'bot-user-id' },
      onInbound,
      undefined,
      receiptStore,
    );
    const restartedProcess = new MattermostInboundProcessor(
      { instanceKey: 'primary', botUserId: 'bot-user-id' },
      onInbound,
      undefined,
      receiptStore,
    );

    await expect(firstProcess.handle(payload)).resolves.toBe(true);
    await expect(restartedProcess.handle(payload)).resolves.toBe(false);
    expect(onInbound).toHaveBeenCalledOnce();
  });

  it('fails closed for exact and changed pruned replays while retaining boundary collisions', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO mattermost_receipt_retention_floors (
         instance_key, channel_id, reject_before_create_at, updated_at
       ) VALUES ('primary', 'channel-retired', 100, '2026-07-11T00:00:00.000Z')`,
    ).run();
    const onInbound = vi.fn().mockResolvedValue(undefined);
    const processor = new MattermostInboundProcessor(
      { instanceKey: 'primary', botUserId: 'bot-user-id' },
      onInbound,
      undefined,
      {
        claim: recoveryModule.claimMattermostPostReceipt,
        complete: recoveryModule.completeMattermostPostReceipt,
        release: recoveryModule.releaseMattermostPostReceipt,
      },
    );
    const frame = (postId: string, createAt: number, message: string, senderName?: string) =>
      JSON.stringify({
        event: 'posted',
        data: {
          ...(senderName === undefined ? {} : { sender_name: senderName }),
          post: JSON.stringify({
            id: postId,
            channel_id: 'channel-retired',
            user_id: 'user-a',
            root_id: '',
            message,
            create_at: createAt,
          }),
        },
      });

    await expect(processor.handle(frame('post-retired', 99, 'exact old post', 'WebSocket Sender'))).resolves.toBe(
      false,
    );
    await expect(processor.handle(frame('post-retired', 99, 'changed REST payload'))).resolves.toBe(false);
    expect(onInbound).not.toHaveBeenCalled();
    expect(db.prepare("SELECT 1 FROM mattermost_post_receipts WHERE post_id = 'post-retired'").get()).toBeUndefined();

    await expect(processor.handle(frame('post-at-floor', 100, 'retained boundary post'))).resolves.toBe(true);
    await expect(processor.handle(frame('post-at-floor', 100, 'mutated boundary post'))).rejects.toThrow(
      'Mattermost post receipt identity collision',
    );
    expect(onInbound).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT status FROM mattermost_post_receipts WHERE post_id = 'post-at-floor'").get()).toEqual({
      status: 'completed',
    });
  });

  it('parses one REST catch-up page into oldest-first posted frames', () => {
    const parse = (
      recoveryModule as typeof recoveryModule & {
        parseMattermostCatchUpPosts?: (body: unknown, channelId: string) => string[];
      }
    ).parseMattermostCatchUpPosts;
    expect(parse).toBeTypeOf('function');
    if (!parse) return;
    const post = (id: string, createAt: number) => ({
      id,
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: id,
      create_at: createAt,
    });

    const frames = parse(
      {
        order: ['post-2', 'post-1'],
        posts: {
          'post-2': { ...post('post-2', 200), file_ids: ['file-a', 'file-b'] },
          'post-1': post('post-1', 100),
        },
      },
      'channel-a',
    );
    const recoveredPosts = frames.map((frame) =>
      JSON.parse((JSON.parse(frame) as { data: { post: string } }).data.post),
    );
    expect(recoveredPosts.map((post) => post.id)).toEqual(['post-1', 'post-2']);
    expect(recoveredPosts[1].file_ids).toEqual(['file-a', 'file-b']);
    expect(() =>
      parse(
        { order: ['post-x'], posts: { 'post-x': { ...post('post-x', 300), channel_id: 'channel-b' } } },
        'channel-a',
      ),
    ).toThrow('Mattermost catch-up post channel mismatch');
    expect(() =>
      parse(
        {
          order: ['post-1'],
          posts: { 'post-1': post('post-1', 100), 'unreferenced-post': post('unreferenced-post', 200) },
        },
        'channel-a',
      ),
    ).toThrow('Mattermost catch-up response was invalid');
    for (const file_ids of [
      'file-a',
      [42],
      ['../file-a'],
      ['file-a', 'file-a'],
      ['x'.repeat(129)],
      Array.from({ length: 6 }, (_, index) => `file-${index}`),
    ]) {
      expect(() =>
        parse(
          {
            order: ['post-files'],
            posts: { 'post-files': { ...post('post-files', 300), file_ids } },
          },
          'channel-a',
        ),
      ).toThrow('Mattermost catch-up response was invalid');
    }
  });

  it('requires an explicit trusted bootstrap for an active subscription without a cursor', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'bootstrap-required-a');
    seedCompletedReceiptOverflow('primary', 'channel-a', 'bootstrap-overflow');
    const request = vi.fn().mockResolvedValue({ status: 200, body: { order: [], posts: {} } });
    const sink = vi.fn().mockResolvedValue(true);
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'bootstrap-required-fixture-token',
        instanceKey: 'primary',
      },
      { request },
      sink,
    );

    await expect(coordinator.recoverActiveChannels()).rejects.toThrow('Mattermost recovery bootstrap is required');
    expect(request).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    expect(recoveryModule.listActiveMattermostRecoveryChannels('primary')).toEqual([
      { channelId: 'channel-a', lastPostCreatedAt: 0, lastPostId: null },
    ]);
    expect(getMattermostReceiptRetentionFloor(getDb(), { instanceKey: 'primary', channelId: 'channel-a' })).toBeNull();
  });

  it('recovers each active channel from its durable cursor before advancing it', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'recovery-a');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-before-window',
    });
    const RecoveryCoordinator = (
      recoveryModule as typeof recoveryModule & {
        MattermostRecoveryCoordinator?: new (
          config: { baseUrl: string; botToken: string; instanceKey: string },
          transport: { request(input: unknown): Promise<{ status: number; body: unknown }> },
          sink: (payload: string) => Promise<boolean>,
        ) => { recoverActiveChannels(): Promise<void> };
      }
    ).MattermostRecoveryCoordinator;
    expect(RecoveryCoordinator).toBeTypeOf('function');
    if (!RecoveryCoordinator) return;
    const post = (id: string, createAt: number) => ({
      id,
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: id,
      create_at: createAt,
    });
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        order: ['post-3', 'post-2', 'post-before-window'],
        posts: {
          'post-3': post('post-3', 300),
          'post-2': post('post-2', 200),
          'post-before-window': post('post-before-window', 100),
        },
      },
    });
    const sink = vi.fn().mockResolvedValue(true);
    const coordinator = new RecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test/',
        botToken: 'recovery-fixture-token',
        instanceKey: 'primary',
      },
      { request },
      sink,
    );

    await coordinator.recoverActiveChannels();

    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      url: 'https://mattermost.example.test/api/v4/channels/channel-a/posts?per_page=200&skipFetchThreads=true',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer recovery-fixture-token',
      },
    });
    expect(
      sink.mock.calls.map(([frame]) => JSON.parse((JSON.parse(frame) as { data: { post: string } }).data.post).id),
    ).toEqual(['post-2', 'post-3']);
    expect(recoveryModule.listActiveMattermostRecoveryChannels('primary')).toEqual([
      { channelId: 'channel-a', lastPostCreatedAt: 300, lastPostId: 'post-3' },
    ]);
  });

  it('validates but does not route an unreferenced parent returned with the since window', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'since-parent-a');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-parent-watermark',
    });
    const post = (id: string, createAt: number, rootId = '') => ({
      id,
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: rootId,
      message: id,
      create_at: createAt,
    });
    const reply = post('post-new-reply', 200, 'post-thread-root');
    const watermark = post('post-parent-watermark', 100);
    const parent = post('post-thread-root', 50);
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        order: [reply.id, watermark.id],
        posts: { [reply.id]: reply, [watermark.id]: watermark, [parent.id]: parent },
      },
    });
    const sink = vi.fn().mockResolvedValue(true);
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'since-parent-fixture-token',
        instanceKey: 'primary',
      },
      { request },
      sink,
    );

    await expect(coordinator.recoverActiveChannels()).resolves.toBeUndefined();
    expect(
      sink.mock.calls.map(([frame]) => JSON.parse((JSON.parse(frame) as { data: { post: string } }).data.post).id),
    ).toEqual(['post-new-reply']);
  });

  it('recovers an unprocessed post in the same millisecond even when the durable watermark is listed first', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'same-millisecond-a');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-watermark-z',
    });
    const post = (id: string) => ({
      id,
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: id,
      create_at: 100,
    });
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        order: ['post-watermark-z', 'post-missed-a'],
        posts: {
          'post-watermark-z': post('post-watermark-z'),
          'post-missed-a': post('post-missed-a'),
        },
      },
    });
    const sink = vi.fn().mockResolvedValue(true);
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'same-millisecond-fixture-token',
        instanceKey: 'primary',
      },
      { request },
      sink,
    );

    await coordinator.recoverActiveChannels();

    expect(
      sink.mock.calls.map(([frame]) => JSON.parse((JSON.parse(frame) as { data: { post: string } }).data.post).id),
    ).toEqual(['post-missed-a']);
  });

  it('fails closed rather than skipping a same-millisecond cohort split at the ordinary page boundary', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'same-millisecond-boundary-a');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-durable-watermark',
    });
    const post = (id: string, createAt: number) => ({
      id,
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: id,
      create_at: createAt,
    });
    const newestPage = Array.from({ length: 199 }, (_, index) =>
      post(`post-newer-${String(index).padStart(3, '0')}`, 400 - index),
    );
    const boundaryAnchor = post('post-boundary-anchor', 200);
    const missedBoundaryPost = post('post-boundary-missed', 200);
    const watermark = post('post-durable-watermark', 100);
    const pageOne = [...newestPage, boundaryAnchor];
    const completeSinceWindow = [...pageOne, missedBoundaryPost, watermark];
    const request = vi.fn(({ url }: { url: string }) => {
      if (url.includes('since=99')) {
        return Promise.resolve({
          status: 200,
          body: {
            order: completeSinceWindow.map(({ id }) => id),
            posts: Object.fromEntries(completeSinceWindow.map((value) => [value.id, value])),
          },
        });
      }
      if (url.includes('before=post-boundary-anchor')) {
        return Promise.resolve({
          status: 200,
          body: { order: [watermark.id], posts: { [watermark.id]: watermark } },
        });
      }
      return Promise.resolve({
        status: 200,
        body: {
          order: pageOne.map(({ id }) => id),
          posts: Object.fromEntries(pageOne.map((value) => [value.id, value])),
        },
      });
    });
    const sink = vi.fn().mockResolvedValue(true);
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'same-millisecond-boundary-fixture-token',
        instanceKey: 'primary',
      },
      { request },
      sink,
    );

    await expect(coordinator.recoverActiveChannels()).rejects.toThrow(
      'Mattermost catch-up durable watermark was not found',
    );
    expect(sink).not.toHaveBeenCalled();
  });

  it('rejects a full page whose watermark timestamp cohort reaches the response boundary', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'watermark-boundary-a');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-watermark-boundary',
    });
    const post = (id: string, createAt: number) => ({
      id,
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: id,
      create_at: createAt,
    });
    const values = [
      ...Array.from({ length: 198 }, (_, index) => post(`post-boundary-newer-${index}`, 400 - index)),
      post('post-watermark-peer', 100),
      post('post-watermark-boundary', 100),
    ];
    const sink = vi.fn().mockResolvedValue(true);
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'watermark-boundary-fixture-token',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({
          status: 200,
          body: {
            order: values.map(({ id }) => id),
            posts: Object.fromEntries(values.map((value) => [value.id, value])),
          },
        }),
      },
      sink,
    );

    await expect(coordinator.recoverActiveChannels()).rejects.toThrow(
      'Mattermost catch-up could not prove a complete timestamp cohort',
    );
    expect(sink).not.toHaveBeenCalled();
  });

  it('rejects a catch-up page that is not in nonincreasing creation order', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'invalid-order-a');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-invalid-order-watermark',
    });
    const post = (id: string, createAt: number) => ({
      id,
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: id,
      create_at: createAt,
    });
    const values = [
      post('post-invalid-order-older', 200),
      post('post-invalid-order-newer', 300),
      post('post-invalid-order-watermark', 100),
    ];
    const sink = vi.fn().mockResolvedValue(true);
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'invalid-order-fixture-token',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({
          status: 200,
          body: {
            order: values.map(({ id }) => id),
            posts: Object.fromEntries(values.map((value) => [value.id, value])),
          },
        }),
      },
      sink,
    );

    await expect(coordinator.recoverActiveChannels()).rejects.toThrow('Mattermost catch-up response order was invalid');
    expect(sink).not.toHaveBeenCalled();
  });

  it('rejects a server-filtered page that cannot prove every visible recovery post', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'filtered-page-a');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-filtered-watermark',
    });
    const post = (id: string, createAt: number) => ({
      id,
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: id,
      create_at: createAt,
    });
    const newest = post('post-filtered-newest', 200);
    const watermark = post('post-filtered-watermark', 100);
    const sink = vi.fn().mockResolvedValue(true);
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'filtered-page-fixture-token',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({
          status: 200,
          body: {
            order: [newest.id, watermark.id],
            posts: { [newest.id]: newest, [watermark.id]: watermark },
            first_inaccessible_post_time: 50,
          },
        }),
      },
      sink,
    );

    await expect(coordinator.recoverActiveChannels()).rejects.toThrow('Mattermost catch-up response was filtered');
    expect(sink).not.toHaveBeenCalled();
  });

  it('fills a nonconsecutive since hole from the complete ordinary channel page', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'nonconsecutive-since-a');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-since-watermark',
    });
    const post = (id: string, createAt: number) => ({
      id,
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: id,
      create_at: createAt,
    });
    const newest = post('post-newest', 300);
    const omittedBySince = post('post-since-hole', 200);
    const watermark = post('post-since-watermark', 100);
    const request = vi.fn(({ url }: { url: string }) => {
      const values = url.includes('since=') ? [newest, watermark] : [newest, omittedBySince, watermark];
      return Promise.resolve({
        status: 200,
        body: {
          order: values.map(({ id }) => id),
          posts: Object.fromEntries(values.map((value) => [value.id, value])),
        },
      });
    });
    const sink = vi.fn().mockResolvedValue(true);
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'nonconsecutive-since-fixture-token',
        instanceKey: 'primary',
      },
      { request },
      sink,
    );

    await coordinator.recoverActiveChannels();

    expect(
      sink.mock.calls.map(([frame]) => JSON.parse((JSON.parse(frame) as { data: { post: string } }).data.post).id),
    ).toEqual(['post-since-hole', 'post-newest']);
  });

  it('fails closed without advancing when the REST catch-up window is saturated', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'saturated-a');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-before-saturated-window',
    });
    const posts = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, index) => {
        const id = `post-${String(index).padStart(4, '0')}`;
        return [
          id,
          {
            id,
            channel_id: 'channel-a',
            user_id: 'user-a',
            root_id: '',
            message: id,
            create_at: 200 + index,
          },
        ];
      }),
    );
    const sink = vi.fn().mockResolvedValue(true);
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'saturated-fixture-token',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({ status: 200, body: { order: Object.keys(posts), posts } }),
      },
      sink,
    );

    await expect(coordinator.recoverActiveChannels()).rejects.toThrow(
      'Mattermost catch-up could not prove a complete window',
    );
    expect(sink).not.toHaveBeenCalled();
    expect(recoveryModule.listActiveMattermostRecoveryChannels('primary')).toEqual([
      {
        channelId: 'channel-a',
        lastPostCreatedAt: 100,
        lastPostId: 'post-before-saturated-window',
      },
    ]);
    expect(getMattermostReceiptRetentionFloor(getDb(), { instanceKey: 'primary', channelId: 'channel-a' })).toBeNull();
  });

  it('does not trust a sparse catch-up response that cannot prove the durable watermark', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'unproven-a');
    seedCompletedReceiptOverflow('primary', 'channel-a', 'unproven-overflow');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-durable-watermark',
    });
    const newPost = {
      id: 'post-newer-than-watermark',
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: 'new but unproven',
      create_at: 200,
    };
    const request = vi.fn((input: { url: string }) =>
      Promise.resolve(
        input.url.includes('page=1')
          ? { status: 200, body: { order: [], posts: {} } }
          : { status: 200, body: { order: [newPost.id], posts: { [newPost.id]: newPost } } },
      ),
    );
    const sink = vi.fn().mockResolvedValue(true);
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'unproven-fixture-token',
        instanceKey: 'primary',
      },
      { request },
      sink,
    );

    await expect(coordinator.recoverActiveChannels()).rejects.toThrow(
      'Mattermost catch-up durable watermark was not found',
    );
    expect(sink).not.toHaveBeenCalled();
    expect(recoveryModule.listActiveMattermostRecoveryChannels('primary')).toEqual([
      {
        channelId: 'channel-a',
        lastPostCreatedAt: 100,
        lastPostId: 'post-durable-watermark',
      },
    ]);
    expect(getMattermostReceiptRetentionFloor(getDb(), { instanceKey: 'primary', channelId: 'channel-a' })).toBeNull();
  });

  it('uses one bounded ordinary page and preserves server order for equal timestamps', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'keyset-a');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-keyset-watermark',
    });
    const makePost = (id: string, createAt: number) => ({
      id,
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: id,
      create_at: createAt,
    });
    const serverOrder = ['post-newest', 'post-same-z', 'post-same-a', 'post-keyset-watermark'];
    const posts = {
      'post-newest': makePost('post-newest', 300),
      'post-same-z': makePost('post-same-z', 200),
      'post-same-a': makePost('post-same-a', 200),
      'post-keyset-watermark': makePost('post-keyset-watermark', 100),
    };
    const request = vi.fn().mockResolvedValue({ status: 200, body: { order: serverOrder, posts } });
    const routed: string[] = [];
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'keyset-fixture-token',
        instanceKey: 'primary',
      },
      { request },
      (frame) => {
        routed.push(JSON.parse((JSON.parse(frame) as { data: { post: string } }).data.post).id as string);
        return true;
      },
    );

    await coordinator.recoverActiveChannels();

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toMatchObject({
      url: 'https://mattermost.example.test/api/v4/channels/channel-a/posts?per_page=200&skipFetchThreads=true',
    });
    expect(routed).toEqual(['post-same-a', 'post-same-z', 'post-newest']);
  });

  it('prioritizes the exact failed head before later same-millisecond recovery candidates', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'failed-head-order-a');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-failed-head-watermark',
    });
    const post = (id: string) => ({
      id,
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: id,
      create_at: 100,
    });
    const watermark = post('post-failed-head-watermark');
    const failedHead = post('post-failed-head-a');
    const later = post('post-later-b');
    const routed: string[] = [];
    let headRecovered = false;
    const sink = vi.fn((frame: string) => {
      const id = JSON.parse((JSON.parse(frame) as { data: { post: string } }).data.post).id as string;
      if (id === later.id && !headRecovered) {
        throw new Error('Mattermost channel ingress is blocked by an earlier failed post');
      }
      routed.push(id);
      if (id === failedHead.id) headRecovered = true;
      return true;
    });
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'failed-head-order-fixture-token',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({
          status: 200,
          body: {
            order: [watermark.id, failedHead.id, later.id],
            posts: { [watermark.id]: watermark, [failedHead.id]: failedHead, [later.id]: later },
          },
        }),
      },
      sink,
      { failedHeadId: () => failedHead.id },
    );

    await expect(coordinator.recoverActiveChannels()).resolves.toBeUndefined();
    expect(routed).toEqual(['post-failed-head-a', 'post-later-b']);
  });

  it('issues only one bounded request for an unproven cursorful window', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'fresh-page-bound-a');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-outside-page-budget',
    });
    const request = vi.fn(() => {
      const posts = Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => {
          const id = `post-${index}`;
          return [
            id,
            {
              id,
              channel_id: 'channel-a',
              user_id: 'user-a',
              root_id: '',
              message: id,
              create_at: 10_000 - index,
            },
          ];
        }),
      );
      return Promise.resolve({ status: 200, body: { order: Object.keys(posts), posts } });
    });
    const sink = vi.fn().mockResolvedValue(true);
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'fresh-page-bound-fixture-token',
        instanceKey: 'primary',
      },
      { request },
      sink,
    );

    await expect(coordinator.recoverActiveChannels()).rejects.toThrow(
      'Mattermost catch-up durable watermark was not found',
    );
    expect(request).toHaveBeenCalledOnce();
    expect(sink).not.toHaveBeenCalled();
    expect(recoveryModule.listActiveMattermostRecoveryChannels('primary')).toEqual([
      { channelId: 'channel-a', lastPostCreatedAt: 100, lastPostId: 'post-outside-page-budget' },
    ]);
    expect(getMattermostReceiptRetentionFloor(getDb(), { instanceKey: 'primary', channelId: 'channel-a' })).toBeNull();
  });

  it('rejects a malformed catch-up post before routing or advancing the cursor', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'malformed-a');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-before-malformed-window',
    });
    const malformedPost = {
      id: 'post-malformed',
      channel_id: 'channel-a',
      user_id: 42,
      root_id: '',
      message: 'must not advance',
      create_at: 200,
    };
    const sink = vi.fn().mockResolvedValue(true);
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'malformed-fixture-token',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({
          status: 200,
          body: { order: [malformedPost.id], posts: { [malformedPost.id]: malformedPost } },
        }),
      },
      sink,
    );

    await expect(coordinator.recoverActiveChannels()).rejects.toThrow('Mattermost catch-up response was invalid');
    expect(sink).not.toHaveBeenCalled();
    expect(recoveryModule.listActiveMattermostRecoveryChannels('primary')).toEqual([
      {
        channelId: 'channel-a',
        lastPostCreatedAt: 100,
        lastPostId: 'post-before-malformed-window',
      },
    ]);
  });

  it('replays recoverable posts before applying current metadata for the same present channel', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'state-after-post-a');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-state-watermark',
    });
    const post = (id: string, createAt: number) => ({
      id,
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: id,
      create_at: createAt,
    });
    const recovered = post('post-retry-before-metadata', 200);
    const watermark = post('post-state-watermark', 100);
    const order: string[] = [];
    const request = vi.fn(({ url }: { url: string }) =>
      Promise.resolve(
        url.endsWith('/api/v4/users/me/channels?include_deleted=false')
          ? {
              status: 200,
              body: [
                {
                  id: 'channel-a',
                  name: 'channel-a',
                  display_name: 'Renamed after failed post',
                  type: 'O',
                  delete_at: 0,
                },
              ],
            }
          : {
              status: 200,
              body: {
                order: [recovered.id, watermark.id],
                posts: { [recovered.id]: recovered, [watermark.id]: watermark },
              },
            },
      ),
    );
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'state-after-post-fixture-token',
        instanceKey: 'primary',
      },
      { request },
      vi.fn(() => {
        order.push('post');
        return true;
      }),
      {
        stateSink: {
          onMetadata: () => {
            order.push('metadata');
          },
          onBotRemoved: () => {
            order.push('removed');
          },
        },
      },
    );

    await coordinator.recoverActiveChannels();

    expect(order).toEqual(['post', 'metadata']);
  });

  it('reconciles unfinished approvals from authenticated membership even without an active subscription', async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const bootstrapLegacy = vi.fn().mockReturnValue({ seeded: 0, rejected: 0 });
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: [
        {
          id: 'channel-pending',
          name: 'pending-channel',
          display_name: 'Pending Channel',
          type: 'O',
          delete_at: 0,
        },
        {
          id: 'direct-channel',
          name: 'direct-channel',
          display_name: 'Direct Channel',
          type: 'D',
          delete_at: 0,
        },
      ],
    });
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'approval-membership-fixture-token',
        instanceKey: 'primary',
      },
      { request },
      vi.fn(),
      {
        approvalRecovery: {
          hasWork: () => true,
          reconcile,
          bootstrapLegacy,
        },
        stateSink: { onMetadata: vi.fn(), onBotRemoved: vi.fn() },
      },
    );

    await coordinator.recoverActiveChannels();

    expect(request).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(new Set(['channel-pending']));
    expect(bootstrapLegacy).toHaveBeenCalledOnce();
  });

  it('rejects an ambiguous current-state identity for an active channel subscription', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'ambiguous-state-a');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-before-ambiguous-state',
    });
    const metadata = vi.fn();
    const removed = vi.fn();
    const postSink = vi.fn().mockResolvedValue(true);
    const request = vi.fn((input: { url: string }) =>
      Promise.resolve(
        input.url.endsWith('/api/v4/users/me/channels?include_deleted=false')
          ? {
              status: 200,
              body: [
                {
                  id: 'channel-a',
                  name: 'direct-conversation',
                  display_name: 'Not a subscribed channel',
                  type: 'D',
                  delete_at: 0,
                },
              ],
            }
          : {
              status: 200,
              body: {
                order: ['post-before-ambiguous-state'],
                posts: {
                  'post-before-ambiguous-state': {
                    id: 'post-before-ambiguous-state',
                    channel_id: 'channel-a',
                    user_id: 'user-a',
                    root_id: '',
                    message: 'trusted baseline',
                    create_at: 100,
                  },
                },
              },
            },
      ),
    );
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'ambiguous-state-fixture-token',
        instanceKey: 'primary',
      },
      { request },
      postSink,
      { stateSink: { onMetadata: metadata, onBotRemoved: removed } },
    );

    await expect(coordinator.recoverActiveChannels()).rejects.toThrow(
      'Mattermost channel-state active subscription identity was invalid',
    );
    expect(metadata).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
    expect(postSink).not.toHaveBeenCalled();
    expect(recoveryModule.listActiveMattermostRecoveryChannels('primary')).toEqual([
      { channelId: 'channel-a', lastPostCreatedAt: 100, lastPostId: 'post-before-ambiguous-state' },
    ]);
  });

  it('rejects a malformed identity anywhere in the authenticated current-channel set', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'malformed-state-a');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-before-malformed-state',
    });
    const metadata = vi.fn();
    const removed = vi.fn();
    const postSink = vi.fn().mockResolvedValue(true);
    const request = vi.fn((input: { url: string }) =>
      Promise.resolve(
        input.url.endsWith('/api/v4/users/me/channels?include_deleted=false')
          ? {
              status: 200,
              body: [
                {
                  id: 'channel-a',
                  name: 'channel-a',
                  display_name: 'Channel A',
                  type: 'O',
                  delete_at: 0,
                },
                {
                  id: 'x'.repeat(129),
                  name: 'malformed-channel',
                  display_name: 'Malformed channel',
                  type: 'O',
                  delete_at: 0,
                },
              ],
            }
          : {
              status: 200,
              body: {
                order: ['post-before-malformed-state'],
                posts: {
                  'post-before-malformed-state': {
                    id: 'post-before-malformed-state',
                    channel_id: 'channel-a',
                    user_id: 'user-a',
                    root_id: '',
                    message: 'trusted baseline',
                    create_at: 100,
                  },
                },
              },
            },
      ),
    );
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'malformed-state-fixture-token',
        instanceKey: 'primary',
      },
      { request },
      postSink,
      { stateSink: { onMetadata: metadata, onBotRemoved: removed } },
    );

    await expect(coordinator.recoverActiveChannels()).rejects.toThrow('Mattermost channel-state response was invalid');
    expect(metadata).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
    expect(postSink).not.toHaveBeenCalled();
  });

  it('retries rate limits and transient server failures before catch-up succeeds', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'retry-a');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-before-retry',
    });
    const watermark = {
      id: 'post-before-retry',
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: 'trusted baseline',
      create_at: 100,
    };
    const post = {
      id: 'post-after-retry',
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: 'eventually available',
      create_at: 500,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ status: 429, body: undefined, headers: { 'retry-after': '0.01' } })
      .mockResolvedValueOnce({ status: 503, body: { message: 'temporarily unavailable' } })
      .mockResolvedValueOnce({
        status: 200,
        body: { order: [post.id, watermark.id], posts: { [post.id]: post, [watermark.id]: watermark } },
      });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const sink = vi.fn().mockResolvedValue(true);
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'retry-fixture-token',
        instanceKey: 'primary',
      },
      { request },
      sink,
      { sleep, maxAttempts: 4, baseRetryDelayMs: 100, maxRetryDelayMs: 1_000 },
    );

    await coordinator.recoverActiveChannels();

    expect(request).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([10, 200]);
    expect(sink).toHaveBeenCalledOnce();
    expect(recoveryModule.listActiveMattermostRecoveryChannels('primary')).toEqual([
      { channelId: 'channel-a', lastPostCreatedAt: 500, lastPostId: 'post-after-retry' },
    ]);
  });

  it('retries rate limits and transient failures while reconciling current channel state', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'state-retry-a');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-before-state-retry',
    });
    const watermark = {
      id: 'post-before-state-retry',
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: 'trusted baseline',
      create_at: 100,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ status: 429, body: undefined, headers: { 'retry-after': '0.01' } })
      .mockResolvedValueOnce({ status: 503, body: { message: 'temporarily unavailable' } })
      .mockResolvedValueOnce({
        status: 200,
        body: [
          {
            id: 'channel-a',
            name: 'channel-a',
            display_name: 'Recovered channel name',
            type: 'O',
            delete_at: 0,
          },
        ],
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { order: [watermark.id], posts: { [watermark.id]: watermark } },
      });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const metadata = vi.fn();
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'state-retry-fixture-token',
        instanceKey: 'primary',
      },
      { request },
      vi.fn().mockResolvedValue(true),
      {
        sleep,
        maxAttempts: 4,
        baseRetryDelayMs: 100,
        maxRetryDelayMs: 1_000,
        stateSink: { onMetadata: metadata, onBotRemoved: vi.fn() },
      },
    );

    await coordinator.recoverActiveChannels();

    expect(request).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([10, 200]);
    expect(metadata).toHaveBeenCalledWith({
      platformId: 'mattermost:primary:channel-a',
      name: 'Recovered channel name',
      isGroup: true,
    });
  });

  it('retries a transient catch-up transport failure without exposing its cause', async () => {
    seedMattermostSubscription('primary', 'channel-a', 'network-retry-a');
    recoveryModule.advanceMattermostRecoveryCursor({
      instanceKey: 'primary',
      channelId: 'channel-a',
      lastPostCreatedAt: 100,
      lastPostId: 'post-before-network-retry',
    });
    const watermark = {
      id: 'post-before-network-retry',
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: 'trusted baseline',
      create_at: 100,
    };
    const post = {
      id: 'post-after-network-retry',
      channel_id: 'channel-a',
      user_id: 'user-a',
      root_id: '',
      message: 'network recovered',
      create_at: 600,
    };
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket included recovery-fixture-token'))
      .mockResolvedValueOnce({
        status: 200,
        body: { order: [post.id, watermark.id], posts: { [post.id]: post, [watermark.id]: watermark } },
      });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const coordinator = new recoveryModule.MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'recovery-fixture-token',
        instanceKey: 'primary',
      },
      { request },
      vi.fn().mockResolvedValue(true),
      { sleep, maxAttempts: 3, baseRetryDelayMs: 100, maxRetryDelayMs: 1_000 },
    );

    await coordinator.recoverActiveChannels();

    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
    expect(recoveryModule.listActiveMattermostRecoveryChannels('primary')).toEqual([
      { channelId: 'channel-a', lastPostCreatedAt: 600, lastPostId: 'post-after-network-retry' },
    ]);
  });
});
