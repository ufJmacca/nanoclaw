import fs from 'node:fs';
import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const approvalMocks = vi.hoisted(() => ({
  testRoot: `/tmp/nanoclaw-mattermost-channel-approval-${process.pid}`,
  deliver: vi.fn().mockResolvedValue('owner-card-id'),
  ensureUserDm: vi.fn(),
  isAvailable: vi.fn().mockReturnValue(true),
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: `${approvalMocks.testRoot}/data`,
    GROUPS_DIR: `${approvalMocks.testRoot}/groups`,
  };
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer: approvalMocks.wakeContainer,
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: approvalMocks.deliver, isAvailable: approvalMocks.isAvailable }),
}));

vi.mock('./user-dm.js', () => ({
  ensureUserDm: approvalMocks.ensureUserDm,
}));

async function lookupUserDm(userId: string) {
  const { getDb } = await import('../../db/connection.js');
  return getDb()
    .prepare(
      `SELECT mg.*
           FROM messaging_groups mg
           JOIN user_dms ud ON ud.messaging_group_id = mg.id
          WHERE ud.user_id = ?`,
    )
    .get(userId);
}

import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { routeInbound } from '../../router.js';
import {
  handleMattermostBotRemoved,
  subscribeMattermostChannelStrict,
} from '../../channels/mattermost-subscription.js';
import { openInboundDb } from '../../session-manager.js';
import { getAskQuestionRender } from '../../db/sessions.js';
import { grantRole } from './db/user-roles.js';
import { upsertUser } from './db/users.js';

function now(): string {
  return new Date().toISOString();
}

function unknownMattermostMention() {
  return {
    channelType: 'mattermost',
    platformId: 'mattermost:primary:channel-awaiting-owner',
    threadId: 'root-trigger',
    message: {
      id: 'mattermost-trigger-message',
      kind: 'chat' as const,
      content: JSON.stringify({
        sender: 'Mattermost Requester',
        senderId: 'mattermost:user-requester',
        text: '@nanoclaw subscribe this channel',
      }),
      timestamp: now(),
      isMention: true,
      isGroup: true,
    },
  };
}

beforeEach(async () => {
  fs.rmSync(approvalMocks.testRoot, { recursive: true, force: true });
  fs.mkdirSync(approvalMocks.testRoot, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  await import('./index.js');

  upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
  grantRole({
    user_id: 'telegram:owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  createMessagingGroup({
    id: 'mg-owner-dm',
    channel_type: 'telegram',
    platform_id: 'telegram:owner-dm',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  getDb()
    .prepare(
      `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
       VALUES ('telegram:owner', 'telegram', 'mg-owner-dm', ?)`,
    )
    .run(now());

  approvalMocks.deliver.mockClear();
  approvalMocks.ensureUserDm.mockReset().mockImplementation(lookupUserDm);
  approvalMocks.isAvailable.mockReset().mockReturnValue(true);
  approvalMocks.wakeContainer.mockClear();
});

afterEach(() => {
  closeDb();
  fs.rmSync(approvalMocks.testRoot, { recursive: true, force: true });
});

describe('Mattermost channel subscription approval', () => {
  it('leaves no pending request when the owner delivery channel is not active yet', async () => {
    approvalMocks.isAvailable.mockReturnValue(false);

    await routeInbound(unknownMattermostMention());

    expect(approvalMocks.deliver).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM pending_mattermost_channel_approvals').get()).toEqual({
      count: 0,
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_subscriptions').get()).toEqual({ count: 0 });
    expect(approvalMocks.wakeContainer).not.toHaveBeenCalled();
  });

  it('skips non-interactive Mattermost and CLI owner destinations for a reachable Telegram owner', async () => {
    upsertUser({ id: 'mattermost:mm-owner', kind: 'mattermost', display_name: 'MM Owner', created_at: now() });
    grantRole({
      user_id: 'mattermost:mm-owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: 'telegram:owner',
      granted_at: now(),
    });
    createMessagingGroup({
      id: 'mg-mm-owner-dm',
      channel_type: 'mattermost',
      platform_id: 'mattermost:primary:mm-owner-dm',
      name: 'Mattermost owner DM',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    getDb()
      .prepare(
        `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
         VALUES ('mattermost:mm-owner', 'mattermost', 'mg-mm-owner-dm', ?)`,
      )
      .run(now());
    upsertUser({ id: 'cli:local-owner', kind: 'cli', display_name: 'CLI Owner', created_at: now() });
    grantRole({
      user_id: 'cli:local-owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: 'telegram:owner',
      granted_at: '1970-01-01T00:00:00.000Z',
    });
    createMessagingGroup({
      id: 'mg-cli-owner',
      channel_type: 'cli',
      platform_id: 'cli:local-owner',
      name: 'CLI owner',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    getDb()
      .prepare(
        `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
         VALUES ('cli:local-owner', 'cli', 'mg-cli-owner', ?)`,
      )
      .run(now());

    await routeInbound(unknownMattermostMention());

    expect(approvalMocks.deliver).toHaveBeenCalledOnce();
    expect(approvalMocks.deliver.mock.calls[0].slice(0, 2)).toEqual(['telegram', 'telegram:owner-dm']);
    expect(getDb().prepare('SELECT approver_user_id FROM pending_mattermost_channel_approvals').get()).toEqual({
      approver_user_id: 'telegram:owner',
    });
  });

  it('removes an undelivered approval row so a later mention can retry', async () => {
    approvalMocks.deliver.mockRejectedValueOnce(new Error('injected owner delivery failure'));

    await expect(routeInbound(unknownMattermostMention())).rejects.toThrow('injected owner delivery failure');
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM pending_mattermost_channel_approvals').get()).toEqual({
      count: 0,
    });

    approvalMocks.deliver.mockResolvedValue('owner-card-retry');
    const retry = unknownMattermostMention();
    retry.message.id = 'mattermost-trigger-retry';
    await routeInbound(retry);
    expect(approvalMocks.deliver).toHaveBeenCalledTimes(2);
    expect(getDb().prepare('SELECT status FROM pending_mattermost_channel_approvals').get()).toEqual({
      status: 'pending',
    });
  });

  it('does not create an approval when bot removal wins during owner resolution', async () => {
    let releaseOwnerResolution!: () => void;
    const ownerResolution = new Promise<void>((resolve) => {
      releaseOwnerResolution = resolve;
    });
    approvalMocks.ensureUserDm.mockImplementation(async (userId: string) => {
      await ownerResolution;
      return lookupUserDm(userId);
    });

    const request = routeInbound(unknownMattermostMention());
    await vi.waitFor(() => expect(approvalMocks.ensureUserDm).toHaveBeenCalled());
    await handleMattermostBotRemoved('mattermost:primary:channel-awaiting-owner');
    releaseOwnerResolution();
    await request;

    expect(approvalMocks.deliver).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM pending_mattermost_channel_approvals').get()).toEqual({
      count: 0,
    });
    expect(
      getDb()
        .prepare(
          `SELECT denied_at IS NOT NULL AS denied
             FROM messaging_groups
            WHERE platform_id = 'mattermost:primary:channel-awaiting-owner'`,
        )
        .get(),
    ).toEqual({ denied: 1 });
  });

  it('lets only one concurrent mention persist and deliver the approval request', async () => {
    let releaseOwnerResolution!: () => void;
    const ownerResolution = new Promise<void>((resolve) => {
      releaseOwnerResolution = resolve;
    });
    approvalMocks.ensureUserDm.mockImplementation(async (userId: string) => {
      await ownerResolution;
      return lookupUserDm(userId);
    });
    const first = unknownMattermostMention();
    const second = unknownMattermostMention();
    second.message.id = 'mattermost-concurrent-trigger';

    const requests = [routeInbound(first), routeInbound(second)];
    await vi.waitFor(() => expect(approvalMocks.ensureUserDm).toHaveBeenCalledTimes(2));
    releaseOwnerResolution();
    const results = await Promise.allSettled(requests);

    expect(results).toEqual([
      expect.objectContaining({ status: 'fulfilled' }),
      expect.objectContaining({ status: 'fulfilled' }),
    ]);
    expect(approvalMocks.deliver).toHaveBeenCalledOnce();
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM pending_mattermost_channel_approvals').get()).toEqual({
      count: 1,
    });
  });

  it('delivers one dedicated subscription request to an existing owner without invoking an agent', async () => {
    const event = unknownMattermostMention();

    await routeInbound(event);

    expect(approvalMocks.deliver).toHaveBeenCalledTimes(1);
    expect(approvalMocks.deliver).toHaveBeenCalledWith(
      'telegram',
      'telegram:owner-dm',
      null,
      'chat-sdk',
      expect.any(String),
    );
    const payload = JSON.parse(approvalMocks.deliver.mock.calls[0][4] as string) as {
      type: string;
      questionId: string;
      title: string;
      options: Array<{ label: string; value: string }>;
    };
    expect(payload).toMatchObject({
      type: 'ask_question',
      title: 'Mattermost channel subscription request',
    });
    expect(payload.options).toEqual([
      expect.objectContaining({ label: 'Subscribe', value: 'approve' }),
      expect.objectContaining({ label: 'Reject', value: 'reject' }),
    ]);

    const pending = getDb().prepare('SELECT * FROM pending_mattermost_channel_approvals').get() as Record<
      string,
      unknown
    >;
    expect(pending).toMatchObject({
      approval_id: payload.questionId,
      instance_key: 'primary',
      channel_id: 'channel-awaiting-owner',
      requester_user_id: 'mattermost:user-requester',
      approver_user_id: 'telegram:owner',
      status: 'pending',
      original_message: JSON.stringify(event),
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_subscriptions').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM agent_groups').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM messaging_group_agents').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect(approvalMocks.wakeContainer).not.toHaveBeenCalled();
  });

  it('selects an owner and claims but refuses approve or reject clicks from non-owners', async () => {
    upsertUser({ id: 'telegram:global-admin', kind: 'telegram', display_name: 'Admin', created_at: now() });
    grantRole({
      user_id: 'telegram:global-admin',
      role: 'admin',
      agent_group_id: null,
      granted_by: 'telegram:owner',
      granted_at: now(),
    });

    await routeInbound(unknownMattermostMention());
    const pending = getDb().prepare('SELECT * FROM pending_mattermost_channel_approvals').get() as {
      approval_id: string;
      approver_user_id: string;
      status: string;
    };
    expect(pending.approver_user_id).toBe('telegram:owner');

    const { getResponseHandlers } = await import('../../response-registry.js');
    for (const attempt of [
      { value: 'approve', userId: 'global-admin' },
      { value: 'reject', userId: 'user-requester' },
    ]) {
      let claimed = false;
      for (const handler of getResponseHandlers()) {
        claimed = await handler({
          questionId: pending.approval_id,
          value: attempt.value,
          userId: attempt.userId,
          channelType: attempt.userId === 'user-requester' ? 'mattermost' : 'telegram',
          platformId: 'forwarded-card',
          threadId: null,
        });
        if (claimed) break;
      }
      expect(claimed).toBe(true);
    }

    expect(
      getDb()
        .prepare('SELECT status FROM pending_mattermost_channel_approvals WHERE approval_id = ?')
        .get(pending.approval_id),
    ).toEqual({ status: 'pending' });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_subscriptions').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM agent_groups').get()).toEqual({ count: 0 });
    expect(approvalMocks.wakeContainer).not.toHaveBeenCalled();
  });

  it('approves only through a fresh canonical Mattermost subscription identity', async () => {
    createAgentGroup({
      id: 'ag-telegram-existing',
      name: 'Existing Telegram agent',
      folder: 'telegram-existing',
      agent_provider: null,
      created_at: now(),
    });
    const existingMattermost = subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'other-channel',
      channelName: 'Other Mattermost channel',
    });

    await routeInbound(unknownMattermostMention());
    const pending = getDb().prepare('SELECT * FROM pending_mattermost_channel_approvals').get() as {
      approval_id: string;
      messaging_group_id: string;
    };
    expect(approvalMocks.wakeContainer).not.toHaveBeenCalled();
    const { getResponseHandlers } = await import('../../response-registry.js');
    let claimed = false;
    for (const handler of getResponseHandlers()) {
      claimed = await handler({
        questionId: pending.approval_id,
        value: 'approve',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'telegram:owner-dm',
        threadId: null,
      });
      if (claimed) break;
    }
    expect(claimed).toBe(true);

    const subscription = getDb()
      .prepare(
        `SELECT * FROM mattermost_subscriptions
          WHERE instance_key = 'primary' AND channel_id = 'channel-awaiting-owner'`,
      )
      .get() as {
      messaging_group_id: string;
      agent_group_id: string;
      wiring_id: string;
      status: string;
    };
    expect(subscription).toMatchObject({ messaging_group_id: pending.messaging_group_id, status: 'active' });
    expect(subscription.agent_group_id).not.toBe('ag-telegram-existing');
    expect(subscription.agent_group_id).not.toBe(existingMattermost.agentGroup.id);
    expect(subscription.agent_group_id).toMatch(/^ag-mattermost-/);
    expect(
      getDb().prepare('SELECT * FROM messaging_group_agents WHERE id = ?').get(subscription.wiring_id),
    ).toMatchObject({
      messaging_group_id: pending.messaging_group_id,
      agent_group_id: subscription.agent_group_id,
      session_mode: 'shared',
      sender_scope: 'known',
    });
    expect(
      getDb()
        .prepare('SELECT target_type, target_id FROM agent_destinations WHERE agent_group_id = ?')
        .all(subscription.agent_group_id),
    ).toEqual([{ target_type: 'channel', target_id: pending.messaging_group_id }]);
    expect(approvalMocks.wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('adds the requester only to the newly subscribed channel agent group', async () => {
    createAgentGroup({
      id: 'ag-unrelated',
      name: 'Unrelated agent',
      folder: 'unrelated',
      agent_provider: null,
      created_at: now(),
    });
    await routeInbound(unknownMattermostMention());
    const pending = getDb().prepare('SELECT approval_id FROM pending_mattermost_channel_approvals').get() as {
      approval_id: string;
    };
    expect(approvalMocks.wakeContainer).not.toHaveBeenCalled();
    const { getResponseHandlers } = await import('../../response-registry.js');
    for (const handler of getResponseHandlers()) {
      if (
        await handler({
          questionId: pending.approval_id,
          value: 'approve',
          userId: 'owner',
          channelType: 'telegram',
          platformId: 'telegram:owner-dm',
          threadId: null,
        })
      ) {
        break;
      }
    }

    const subscription = getDb()
      .prepare(
        `SELECT agent_group_id FROM mattermost_subscriptions
          WHERE instance_key = 'primary' AND channel_id = 'channel-awaiting-owner'`,
      )
      .get() as { agent_group_id: string };
    expect(
      getDb()
        .prepare(
          `SELECT user_id, agent_group_id, added_by
             FROM agent_group_members
            WHERE user_id = 'mattermost:user-requester'`,
        )
        .all(),
    ).toEqual([
      {
        user_id: 'mattermost:user-requester',
        agent_group_id: subscription.agent_group_id,
        added_by: 'telegram:owner',
      },
    ]);
    expect(
      getDb().prepare('SELECT COUNT(*) AS count FROM agent_group_members WHERE agent_group_id = ?').get('ag-unrelated'),
    ).toEqual({ count: 0 });
    expect(approvalMocks.wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('replays the exact trigger once under concurrent duplicate approvals', async () => {
    const event = unknownMattermostMention();
    await routeInbound(event);
    const pending = getDb().prepare('SELECT approval_id FROM pending_mattermost_channel_approvals').get() as {
      approval_id: string;
    };
    const { getResponseHandlers } = await import('../../response-registry.js');
    const approve = async (): Promise<void> => {
      for (const handler of getResponseHandlers()) {
        if (
          await handler({
            questionId: pending.approval_id,
            value: 'approve',
            userId: 'owner',
            channelType: 'telegram',
            platformId: 'telegram:owner-dm',
            threadId: null,
          })
        ) {
          break;
        }
      }
    };
    await Promise.all([approve(), approve()]);

    const subscription = getDb()
      .prepare(
        `SELECT agent_group_id, messaging_group_id
           FROM mattermost_subscriptions
          WHERE instance_key = 'primary' AND channel_id = 'channel-awaiting-owner'`,
      )
      .get() as { agent_group_id: string; messaging_group_id: string };
    const sessions = getDb()
      .prepare(
        `SELECT id, agent_group_id, messaging_group_id, thread_id
           FROM sessions
          WHERE agent_group_id = ?`,
      )
      .all(subscription.agent_group_id) as Array<{
      id: string;
      agent_group_id: string;
      messaging_group_id: string;
      thread_id: string | null;
    }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      agent_group_id: subscription.agent_group_id,
      messaging_group_id: subscription.messaging_group_id,
      thread_id: null,
    });
    const inbound = openInboundDb(subscription.agent_group_id, sessions[0].id);
    const messages = inbound
      .prepare('SELECT id, platform_id, channel_type, thread_id, content, trigger FROM messages_in')
      .all();
    inbound.close();
    expect(messages).toEqual([
      {
        id: `${event.message.id}:${subscription.agent_group_id}`,
        platform_id: event.platformId,
        channel_type: event.channelType,
        thread_id: event.threadId,
        content: event.message.content,
        trigger: 1,
      },
    ]);
    expect(approvalMocks.wakeContainer).toHaveBeenCalledTimes(1);
    expect(
      getDb()
        .prepare('SELECT status, replayed_at IS NOT NULL AS replayed FROM pending_mattermost_channel_approvals')
        .get(),
    ).toEqual({ status: 'completed', replayed: 1 });
  });

  it('releases a failed approval claim so the exact trigger can be retried safely', async () => {
    const event = unknownMattermostMention();
    await routeInbound(event);
    const pending = getDb().prepare('SELECT approval_id FROM pending_mattermost_channel_approvals').get() as {
      approval_id: string;
    };
    const { getResponseHandlers } = await import('../../response-registry.js');
    const approve = async (): Promise<void> => {
      for (const handler of getResponseHandlers()) {
        if (
          await handler({
            questionId: pending.approval_id,
            value: 'approve',
            userId: 'owner',
            channelType: 'telegram',
            platformId: 'telegram:owner-dm',
            threadId: null,
          })
        ) {
          return;
        }
      }
    };

    const digest = createHash('sha256').update('primary\0channel-awaiting-owner').digest('hex').slice(0, 24);
    const blockedWorkspace = `${approvalMocks.testRoot}/groups/mattermost-${digest}`;
    fs.mkdirSync(blockedWorkspace, { recursive: true });
    await expect(approve()).rejects.toThrow('Mattermost workspace identity already exists');
    expect(
      getDb()
        .prepare('SELECT status, replayed_at FROM pending_mattermost_channel_approvals WHERE approval_id = ?')
        .get(pending.approval_id),
    ).toEqual({ status: 'pending', replayed_at: null });

    fs.rmSync(blockedWorkspace, { recursive: true, force: true });
    await approve();
    expect(
      getDb()
        .prepare('SELECT status, replayed_at IS NOT NULL AS replayed FROM pending_mattermost_channel_approvals')
        .get(),
    ).toEqual({ status: 'completed', replayed: 1 });
    const subscription = getDb().prepare('SELECT agent_group_id FROM mattermost_subscriptions').get() as {
      agent_group_id: string;
    };
    const [session] = getDb()
      .prepare('SELECT id FROM sessions WHERE agent_group_id = ?')
      .all(subscription.agent_group_id) as Array<{ id: string }>;
    const inbound = openInboundDb(subscription.agent_group_id, session.id);
    expect(inbound.prepare('SELECT COUNT(*) AS count FROM messages_in').get()).toEqual({ count: 1 });
    inbound.close();
    expect(approvalMocks.wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('keeps a partial approval non-rejectable after strict topology already became active', async () => {
    const event = unknownMattermostMention();
    await routeInbound(event);
    const pending = getDb()
      .prepare('SELECT approval_id, messaging_group_id FROM pending_mattermost_channel_approvals')
      .get() as { approval_id: string; messaging_group_id: string };
    getDb().exec(`CREATE TRIGGER fail_mattermost_requester_membership
               BEFORE INSERT ON agent_group_members
               BEGIN
                 SELECT RAISE(ABORT, 'injected requester membership failure');
               END`);
    const { getResponseHandlers } = await import('../../response-registry.js');
    const respond = async (value: 'approve' | 'reject'): Promise<void> => {
      for (const handler of getResponseHandlers()) {
        if (
          await handler({
            questionId: pending.approval_id,
            value,
            userId: 'owner',
            channelType: 'telegram',
            platformId: 'telegram:owner-dm',
            threadId: null,
          })
        ) {
          return;
        }
      }
    };

    await expect(respond('approve')).rejects.toThrow('injected requester membership failure');
    expect(getDb().prepare('SELECT status FROM mattermost_subscriptions').get()).toEqual({ status: 'active' });

    await respond('reject');
    expect(
      getDb()
        .prepare('SELECT status FROM pending_mattermost_channel_approvals WHERE approval_id = ?')
        .get(pending.approval_id),
    ).toEqual({ status: 'processing' });
    expect(
      getDb().prepare('SELECT denied_at FROM messaging_groups WHERE id = ?').get(pending.messaging_group_id),
    ).toEqual({ denied_at: null });
  });

  it('rejects the pending channel without creating topology or prompting again', async () => {
    const event = unknownMattermostMention();
    await routeInbound(event);
    const pending = getDb()
      .prepare('SELECT approval_id, messaging_group_id FROM pending_mattermost_channel_approvals')
      .get() as {
      approval_id: string;
      messaging_group_id: string;
    };
    const { getResponseHandlers } = await import('../../response-registry.js');
    for (const handler of getResponseHandlers()) {
      if (
        await handler({
          questionId: pending.approval_id,
          value: 'reject',
          userId: 'owner',
          channelType: 'telegram',
          platformId: 'telegram:owner-dm',
          threadId: null,
        })
      ) {
        break;
      }
    }

    expect(
      getDb()
        .prepare('SELECT denied_at IS NOT NULL AS denied FROM messaging_groups WHERE id = ?')
        .get(pending.messaging_group_id),
    ).toEqual({ denied: 1 });
    expect(
      getDb()
        .prepare(
          `SELECT status, decided_by, decided_at IS NOT NULL AS decided
             FROM pending_mattermost_channel_approvals
            WHERE approval_id = ?`,
        )
        .get(pending.approval_id),
    ).toEqual({ status: 'rejected', decided_by: 'telegram:owner', decided: 1 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_subscriptions').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM agent_groups').get()).toEqual({ count: 0 });
    expect(approvalMocks.wakeContainer).not.toHaveBeenCalled();

    approvalMocks.deliver.mockClear();
    await routeInbound({ ...event, message: { ...event.message, id: 'mattermost-trigger-retry' } });
    expect(approvalMocks.deliver).not.toHaveBeenCalled();
  });

  it('resolves persisted button values for the Chat SDK response bridge', async () => {
    await routeInbound(unknownMattermostMention());
    const pending = getDb().prepare('SELECT approval_id FROM pending_mattermost_channel_approvals').get() as {
      approval_id: string;
    };

    expect(getAskQuestionRender(pending.approval_id)).toEqual({
      title: 'Mattermost channel subscription request',
      options: [
        { label: 'Subscribe', selectedLabel: '✅ Subscribed', value: 'approve' },
        { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
      ],
    });
  });
});
