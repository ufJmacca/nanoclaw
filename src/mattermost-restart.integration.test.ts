import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session } from './types.js';

const restartMocks = vi.hoisted(() => ({
  testRoot: `/tmp/nanoclaw-mattermost-restart-${process.pid}`,
  wakeContainer: vi.fn(),
  getChannelAdapter: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: path.join(restartMocks.testRoot, 'data'),
    GROUPS_DIR: path.join(restartMocks.testRoot, 'groups'),
  };
});

vi.mock('./container-runner.js', () => ({
  wakeContainer: restartMocks.wakeContainer,
  isContainerRunning: vi.fn(() => false),
  getActiveContainerCount: vi.fn(() => 0),
  killContainer: vi.fn(),
}));

vi.mock('./channels/channel-registry.js', () => ({
  getChannelAdapter: restartMocks.getChannelAdapter,
}));

vi.mock('../container/agent-runner/src/destinations.js', () => ({
  findByRouting: vi.fn(() => undefined),
}));

import { MattermostInboundProcessor } from './channels/mattermost-inbound.js';
import {
  claimMattermostPostReceipt,
  completeMattermostPostReceipt,
  listActiveMattermostRecoveryChannels,
  MattermostRecoveryCoordinator,
  releaseMattermostPostReceipt,
  resetMattermostProcessingReceipts,
} from './channels/mattermost-recovery.js';
import { subscribeMattermostChannelStrict } from './channels/mattermost-subscription.js';
import { GROUPS_DIR } from './config.js';
import { closeDb, getDb, getSessionsByAgentGroup, initDb, runMigrations } from './db/index.js';
import { routeInbound } from './router.js';
import { inboundDbPath, sessionDir, writeSessionMessage } from './session-manager.js';

interface TestPost {
  id: string;
  channel_id: string;
  user_id: string;
  root_id: string;
  message: string;
  create_at: number;
}

const receiptStore = {
  claim: claimMattermostPostReceipt,
  complete: completeMattermostPostReceipt,
  release: releaseMattermostPostReceipt,
};

function postedFrame(post: TestPost, senderName?: string): string {
  return JSON.stringify({
    event: 'posted',
    data: { ...(senderName === undefined ? {} : { sender_name: senderName }), post: JSON.stringify(post) },
  });
}

afterEach(() => {
  closeDb();
  fs.rmSync(restartMocks.testRoot, { recursive: true, force: true });
});

describe('Mattermost file-backed restart recovery', () => {
  it('rejects pruned WS and changed REST replays after restart before session or wake', async () => {
    closeDb();
    fs.rmSync(restartMocks.testRoot, { recursive: true, force: true });
    fs.mkdirSync(restartMocks.testRoot, { recursive: true });
    restartMocks.wakeContainer.mockReset().mockResolvedValue(false);
    restartMocks.getChannelAdapter.mockReset().mockReturnValue({
      supportsThreads: true,
      threadSessionPolicy: 'honor-wiring',
    });

    const centralDbPath = path.join(restartMocks.testRoot, 'retired-replay.db');
    runMigrations(initDb(centralDbPath));
    const subscription = subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-retired-replay',
      channelName: 'Retired Replay Channel',
    });
    const post: TestPost = {
      id: 'post-retired-replay',
      channel_id: 'channel-retired-replay',
      user_id: 'user-retired-replay',
      root_id: 'root-retired-replay',
      message: 'retired exact payload',
      create_at: 99,
    };
    getDb()
      .prepare(
        `INSERT INTO mattermost_receipt_retention_floors (
           instance_key, channel_id, reject_before_create_at, updated_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run('primary', post.channel_id, 100, '2026-07-11T00:00:00.000Z');
    closeDb();

    runMigrations(initDb(centralDbPath));
    const restartedProcessor = new MattermostInboundProcessor(
      { instanceKey: 'primary', botUserId: 'bot-user' },
      routeInbound,
      undefined,
      receiptStore,
    );

    await expect(restartedProcessor.handle(postedFrame(post, 'WebSocket Sender'))).resolves.toBe(false);
    await expect(restartedProcessor.handle(postedFrame({ ...post, message: 'changed REST payload' }))).resolves.toBe(
      false,
    );

    expect(restartMocks.wakeContainer).not.toHaveBeenCalled();
    expect(getSessionsByAgentGroup(subscription.agentGroup.id)).toEqual([]);
    expect(
      getDb()
        .prepare('SELECT 1 FROM mattermost_post_receipts WHERE instance_key = ? AND post_id = ?')
        .get('primary', post.id),
    ).toBeUndefined();
    expect(
      getDb()
        .prepare(
          `SELECT reject_before_create_at
             FROM mattermost_receipt_retention_floors
            WHERE instance_key = ? AND channel_id = ?`,
        )
        .get('primary', post.channel_id),
    ).toEqual({ reject_before_create_at: 100 });
  });

  it('reconciles a WS sender label with REST crash replay without weakening stable identity', async () => {
    closeDb();
    fs.rmSync(restartMocks.testRoot, { recursive: true, force: true });
    fs.mkdirSync(restartMocks.testRoot, { recursive: true });
    restartMocks.wakeContainer.mockReset().mockResolvedValue(false);
    restartMocks.getChannelAdapter.mockReset().mockReturnValue({
      supportsThreads: true,
      threadSessionPolicy: 'honor-wiring',
    });

    const centralDbPath = path.join(restartMocks.testRoot, 'sender-replay.db');
    runMigrations(initDb(centralDbPath));
    const subscription = subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-sender-replay',
      channelName: 'Sender Replay Channel',
    });
    const post: TestPost = {
      id: 'post-sender-replay',
      channel_id: 'channel-sender-replay',
      user_id: 'user-sender-replay',
      root_id: 'root-sender-replay',
      message: 'stable crash-replay text',
      create_at: 1_700_000_000_300,
    };
    const crashingProcessor = new MattermostInboundProcessor(
      { instanceKey: 'primary', botUserId: 'bot-user' },
      routeInbound,
      undefined,
      {
        claim: claimMattermostPostReceipt,
        complete: () => false,
        // A process crash cannot run receipt cleanup. Preserve the exact
        // processing row so startup recovery exercises that durable state.
        release: () => false,
      },
    );

    await expect(crashingProcessor.handle(postedFrame(post, 'Ada Before Restart'))).rejects.toThrow(
      'Mattermost post receipt completion failed',
    );
    const [session] = getSessionsByAgentGroup(subscription.agentGroup.id);
    expect(restartMocks.wakeContainer).toHaveBeenCalledOnce();
    expect(
      getDb()
        .prepare('SELECT status FROM mattermost_post_receipts WHERE instance_key = ? AND post_id = ?')
        .get('primary', post.id),
    ).toEqual({ status: 'processing' });
    closeDb();

    runMigrations(initDb(centralDbPath));
    expect(resetMattermostProcessingReceipts('primary')).toBe(1);
    const restartedProcessor = new MattermostInboundProcessor(
      { instanceKey: 'primary', botUserId: 'bot-user' },
      routeInbound,
      undefined,
      receiptStore,
    );

    await expect(restartedProcessor.handle(postedFrame(post))).resolves.toBe(true);

    expect(restartMocks.wakeContainer).toHaveBeenCalledOnce();
    expect(getSessionsByAgentGroup(subscription.agentGroup.id)).toHaveLength(1);
    const inbox = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
    const rows = inbox
      .prepare('SELECT id, timestamp, platform_id, channel_type, thread_id, content FROM messages_in')
      .all();
    inbox.close();
    expect(rows).toEqual([
      {
        id: `${post.id}:${subscription.agentGroup.id}`,
        timestamp: new Date(post.create_at).toISOString(),
        platform_id: 'mattermost:primary:channel-sender-replay',
        channel_type: 'mattermost',
        thread_id: post.root_id,
        content: JSON.stringify({
          sender: 'Ada Before Restart',
          senderId: `mattermost:${post.user_id}`,
          text: post.message,
        }),
      },
    ]);
    expect(
      getDb()
        .prepare('SELECT status FROM mattermost_post_receipts WHERE instance_key = ? AND post_id = ?')
        .get('primary', post.id),
    ).toEqual({ status: 'completed' });

    const replay = {
      id: `${post.id}:${subscription.agentGroup.id}`,
      kind: 'chat',
      timestamp: new Date(post.create_at).toISOString(),
      platformId: 'mattermost:primary:channel-sender-replay',
      channelType: 'mattermost',
      threadId: post.root_id,
      content: JSON.stringify({ senderId: `mattermost:${post.user_id}`, text: post.message }),
      idempotent: true,
    } as const;
    for (const collision of [
      { ...replay, content: JSON.stringify({ senderId: 'mattermost:different-user', text: post.message }) },
      { ...replay, content: JSON.stringify({ senderId: `mattermost:${post.user_id}`, text: 'changed text' }) },
      { ...replay, platformId: 'mattermost:primary:different-channel' },
      { ...replay, threadId: 'different-root' },
      { ...replay, timestamp: new Date(post.create_at + 1).toISOString() },
    ]) {
      expect(() => writeSessionMessage(session.agent_group_id, session.id, collision)).toThrow(
        'Mattermost replay message identity collision',
      );
    }
  });

  it('reuses the durable channel session and skips a completed post while routing a missed post', async () => {
    closeDb();
    fs.rmSync(restartMocks.testRoot, { recursive: true, force: true });
    fs.mkdirSync(restartMocks.testRoot, { recursive: true });
    restartMocks.wakeContainer.mockReset().mockResolvedValue(false);
    restartMocks.getChannelAdapter.mockReset().mockReturnValue({
      supportsThreads: true,
      threadSessionPolicy: 'honor-wiring',
    });

    const centralDbPath = path.join(restartMocks.testRoot, 'central.db');
    runMigrations(initDb(centralDbPath));
    const subscription = subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-restart',
      channelName: 'Restart Channel',
    });
    const oldPost: TestPost = {
      id: 'post-before-restart',
      channel_id: 'channel-restart',
      user_id: 'user-restart',
      root_id: 'root-before-restart',
      message: 'accepted before restart',
      create_at: 1_700_000_000_100,
    };
    const initialProcessor = new MattermostInboundProcessor(
      { instanceKey: 'primary', botUserId: 'bot-user' },
      routeInbound,
      undefined,
      receiptStore,
    );

    await expect(initialProcessor.handle(postedFrame(oldPost))).resolves.toBe(true);

    const [initialSession] = getSessionsByAgentGroup(subscription.agentGroup.id);
    expect(initialSession).toMatchObject({
      messaging_group_id: subscription.messagingGroup.id,
      thread_id: null,
      status: 'active',
    });
    const initialSessionPath = sessionDir(initialSession.agent_group_id, initialSession.id);
    const workspacePath = path.join(GROUPS_DIR, subscription.agentGroup.folder);
    const workspaceMarker = path.join(workspacePath, 'restart-identity-marker.txt');
    fs.writeFileSync(workspaceMarker, 'same-channel-workspace');
    const initialWorkspaceInode = fs.statSync(workspacePath).ino;
    const initialSessionInode = fs.statSync(initialSessionPath).ino;
    closeDb();

    runMigrations(initDb(centralDbPath));
    const persistedSubscription = getDb()
      .prepare(
        `SELECT messaging_group_id, agent_group_id, wiring_id, status
           FROM mattermost_subscriptions
          WHERE instance_key = ? AND channel_id = ?`,
      )
      .get('primary', 'channel-restart');
    expect(persistedSubscription).toEqual({
      messaging_group_id: subscription.messagingGroup.id,
      agent_group_id: subscription.agentGroup.id,
      wiring_id: subscription.wiring.id,
      status: 'active',
    });
    expect(listActiveMattermostRecoveryChannels('primary')).toEqual([
      {
        channelId: oldPost.channel_id,
        lastPostCreatedAt: oldPost.create_at,
        lastPostId: oldPost.id,
      },
    ]);
    const oldReceipt = {
      instanceKey: 'primary',
      postId: oldPost.id,
      channelId: oldPost.channel_id,
      createAt: oldPost.create_at,
      payloadDigest: (
        getDb()
          .prepare(
            `SELECT payload_digest
               FROM mattermost_post_receipts
              WHERE instance_key = ? AND post_id = ?`,
          )
          .get('primary', oldPost.id) as { payload_digest: string }
      ).payload_digest,
    };
    expect(claimMattermostPostReceipt(oldReceipt)).toBe('completed');

    const [reopenedSession] = getSessionsByAgentGroup(subscription.agentGroup.id);
    expect(reopenedSession).toEqual(initialSession);
    expect(sessionDir(reopenedSession.agent_group_id, reopenedSession.id)).toBe(initialSessionPath);
    expect(fs.statSync(workspacePath).ino).toBe(initialWorkspaceInode);
    expect(fs.statSync(initialSessionPath).ino).toBe(initialSessionInode);
    expect(fs.readFileSync(workspaceMarker, 'utf8')).toBe('same-channel-workspace');

    const missedPost: TestPost = {
      id: 'post-missed-during-restart',
      channel_id: 'channel-restart',
      user_id: 'user-restart',
      root_id: 'root-after-restart',
      message: 'recover me into the existing session',
      create_at: oldPost.create_at + 100,
    };
    const restartedProcessor = new MattermostInboundProcessor(
      { instanceKey: 'primary', botUserId: 'bot-user' },
      routeInbound,
      undefined,
      receiptStore,
    );
    const accepted: boolean[] = [];
    const coordinator = new MattermostRecoveryCoordinator(
      {
        baseUrl: 'https://mattermost.example.test',
        botToken: 'restart-fixture-token',
        instanceKey: 'primary',
      },
      {
        request: vi.fn().mockResolvedValue({
          status: 200,
          body: {
            order: [missedPost.id, oldPost.id],
            posts: { [missedPost.id]: missedPost, [oldPost.id]: oldPost },
          },
        }),
      },
      async (frame) => {
        const result = await restartedProcessor.handle(frame);
        accepted.push(result);
        return result;
      },
    );

    await coordinator.recoverActiveChannels();

    expect(accepted).toEqual([true]);
    expect(restartMocks.wakeContainer).toHaveBeenCalledTimes(2);
    expect(restartMocks.wakeContainer.mock.calls.map((call) => (call[0] as Session).id)).toEqual([
      initialSession.id,
      initialSession.id,
    ]);
    const sessionsAfterRecovery = getSessionsByAgentGroup(subscription.agentGroup.id);
    expect(sessionsAfterRecovery).toHaveLength(1);
    expect(sessionsAfterRecovery[0]).toMatchObject({
      id: initialSession.id,
      agent_group_id: initialSession.agent_group_id,
      messaging_group_id: initialSession.messaging_group_id,
      thread_id: null,
      status: 'active',
    });
    expect(listActiveMattermostRecoveryChannels('primary')).toEqual([
      {
        channelId: missedPost.channel_id,
        lastPostCreatedAt: missedPost.create_at,
        lastPostId: missedPost.id,
      },
    ]);

    const inbox = new Database(inboundDbPath(initialSession.agent_group_id, initialSession.id), { readonly: true });
    const messages = inbox.prepare('SELECT id, platform_id, thread_id FROM messages_in ORDER BY timestamp, id').all();
    inbox.close();
    expect(messages).toEqual([
      {
        id: `${oldPost.id}:${subscription.agentGroup.id}`,
        platform_id: 'mattermost:primary:channel-restart',
        thread_id: oldPost.root_id,
      },
      {
        id: `${missedPost.id}:${subscription.agentGroup.id}`,
        platform_id: 'mattermost:primary:channel-restart',
        thread_id: missedPost.root_id,
      },
    ]);
    expect(
      getDb()
        .prepare(
          `SELECT post_id, channel_id, status
             FROM mattermost_post_receipts
            WHERE instance_key = ?
            ORDER BY create_at, post_id`,
        )
        .all('primary'),
    ).toEqual([
      { post_id: oldPost.id, channel_id: oldPost.channel_id, status: 'completed' },
      { post_id: missedPost.id, channel_id: missedPost.channel_id, status: 'completed' },
    ]);
    expect(fs.statSync(workspacePath).ino).toBe(initialWorkspaceInode);
    expect(fs.statSync(initialSessionPath).ino).toBe(initialSessionInode);
  });
});
