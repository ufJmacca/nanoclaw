import fs from 'node:fs';
import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recoveryMocks = vi.hoisted(() => ({
  testRoot: `/tmp/nanoclaw-mattermost-approval-recovery-${process.pid}`,
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: `${recoveryMocks.testRoot}/data`,
    GROUPS_DIR: `${recoveryMocks.testRoot}/groups`,
  };
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer: recoveryMocks.wakeContainer,
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

import * as approvalModule from './mattermost-channel-approval.js';
import {
  completeMattermostChannelApprovalReplay,
  createPendingMattermostChannelApproval,
  quarantineProcessingMattermostChannelApproval,
  releasePendingMattermostChannelApproval,
} from './db/pending-mattermost-channel-approvals.js';
import { addMember } from './db/agent-group-members.js';
import { upsertUser } from './db/users.js';
import { grantRole } from './db/user-roles.js';
import { closeDb, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { routeInbound } from '../../router.js';
import { registerInboundAttachmentLoaderFactory } from '../../channels/adapter.js';
import { subscribeMattermostChannelStrict } from '../../channels/mattermost-subscription.js';
import { mattermostChannelSequencer } from '../../channels/mattermost-inbound.js';
import { advanceMattermostRecoveryCursor } from '../../channels/mattermost-recovery.js';
import { inboundDbPath, openInboundDb, resolveSession, sessionDir } from '../../session-manager.js';

const EVENT = {
  channelType: 'mattermost',
  platformId: 'mattermost:primary:channel-recovery',
  threadId: 'root-recovery',
  message: {
    id: 'mattermost-recovery-trigger',
    kind: 'chat' as const,
    content: JSON.stringify({
      sender: 'Mattermost Requester',
      senderId: 'mattermost:user-requester',
      text: '@nanoclaw recover this subscription',
    }),
    timestamp: '2026-07-11T00:00:00.000Z',
    isMention: true,
    isGroup: true,
  },
};

function seedApproval(status: 'pending' | 'processing' = 'processing', instanceKey = 'primary'): void {
  const createdAt = '2026-07-11T00:00:00.000Z';
  const event = { ...EVENT, platformId: `mattermost:${instanceKey}:channel-recovery` };
  upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: createdAt });
  createMessagingGroup({
    id: 'mg-mattermost-recovery-placeholder',
    channel_type: 'mattermost',
    platform_id: event.platformId,
    name: 'Recovery channel',
    is_group: 1,
    unknown_sender_policy: 'request_approval',
    denied_at: null,
    created_at: createdAt,
  });
  expect(
    createPendingMattermostChannelApproval({
      approval_id: 'mma-recovery',
      instance_key: instanceKey,
      channel_id: 'channel-recovery',
      messaging_group_id: 'mg-mattermost-recovery-placeholder',
      requester_user_id: 'mattermost:user-requester',
      approver_user_id: 'telegram:owner',
      original_message: JSON.stringify(event),
      status,
      created_at: createdAt,
      decided_at: null,
      decided_by: null,
      replayed_at: null,
      title: 'Mattermost channel subscription request',
      options_json: '[]',
    }),
  ).toBe(true);
}

function seedProcessingApproval(instanceKey = 'primary'): void {
  seedApproval('processing', instanceKey);
}

beforeEach(async () => {
  fs.rmSync(recoveryMocks.testRoot, { recursive: true, force: true });
  fs.mkdirSync(recoveryMocks.testRoot, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  await import('./index.js');
  recoveryMocks.wakeContainer.mockClear();
});

afterEach(() => {
  closeDb();
  fs.rmSync(recoveryMocks.testRoot, { recursive: true, force: true });
});

describe('Mattermost processing approval crash recovery', () => {
  it('reports unfinished approval work before an adapter decides whether authenticated membership is required', () => {
    const hasWork = (
      approvalModule as typeof approvalModule & {
        hasMattermostApprovalMembershipWork?: (instanceKey: string) => boolean;
      }
    ).hasMattermostApprovalMembershipWork;

    expect(hasWork).toBeTypeOf('function');
    if (!hasWork) return;
    expect(hasWork('primary')).toBe(false);
    seedApproval('pending');
    expect(hasWork('primary')).toBe(true);
    expect(hasWork('secondary')).toBe(false);
    getDb().prepare("UPDATE pending_mattermost_channel_approvals SET status = 'rejected'").run();
    expect(hasWork('primary')).toBe(false);
  });

  it('terminal-cancels a pending approval when authenticated startup membership no longer contains its channel', async () => {
    seedApproval('pending');
    const reconcile = (
      approvalModule as typeof approvalModule & {
        recoverMattermostApprovalsForAuthenticatedMembership?: (
          instanceKey: string,
          currentChannelIds: ReadonlySet<string>,
        ) => Promise<{
          cancelledPending: number;
          membershipQuarantined: number;
          completed: number;
          quarantined: number;
        }>;
      }
    ).recoverMattermostApprovalsForAuthenticatedMembership;

    expect(reconcile).toBeTypeOf('function');
    if (!reconcile) return;
    await expect(reconcile('primary', new Set())).resolves.toEqual({
      cancelledPending: 1,
      membershipQuarantined: 0,
      completed: 0,
      quarantined: 0,
    });

    expect(getDb().prepare('SELECT 1 FROM pending_mattermost_channel_approvals').get()).toBeUndefined();
    await expect(
      approvalModule.handleMattermostChannelApprovalResponse({
        questionId: 'mma-recovery',
        value: 'approve',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'telegram:owner-dm',
        threadId: null,
      }),
    ).resolves.toBe(false);
    expect(getDb().prepare('SELECT denied_at FROM messaging_groups').get()).toEqual({
      denied_at: expect.any(String),
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_subscriptions').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect(recoveryMocks.wakeContainer).not.toHaveBeenCalled();
    await expect(
      approvalModule.recoverMattermostApprovalsForAuthenticatedMembership('primary', new Set()),
    ).resolves.toEqual({
      cancelledPending: 0,
      membershipQuarantined: 0,
      completed: 0,
      quarantined: 0,
    });
  });

  it('terminal-cancels an absent approval through the shared failed-head sequencer', async () => {
    seedApproval('pending');
    await expect(
      mattermostChannelSequencer.enqueue(
        EVENT.platformId,
        () => {
          throw new Error('injected failed channel head');
        },
        { headId: 'post-failed-before-removal' },
      ),
    ).rejects.toThrow('injected failed channel head');
    expect(mattermostChannelSequencer.failedHeadId(EVENT.platformId)).toBe('post-failed-before-removal');

    await approvalModule.recoverMattermostApprovalsForAuthenticatedMembership('primary', new Set());

    expect(mattermostChannelSequencer.failedHeadId(EVENT.platformId)).toBeUndefined();
  });

  it('quarantines an absent processing approval before any startup replay or wake', async () => {
    seedProcessingApproval();

    await expect(
      approvalModule.recoverMattermostApprovalsForAuthenticatedMembership('primary', new Set()),
    ).resolves.toEqual({
      cancelledPending: 0,
      membershipQuarantined: 1,
      completed: 0,
      quarantined: 0,
    });

    expect(getDb().prepare('SELECT status, replayed_at FROM pending_mattermost_channel_approvals').get()).toEqual({
      status: 'processing',
      replayed_at: null,
    });
    expect(getDb().prepare('SELECT reason FROM mattermost_approval_recovery_quarantine').get()).toEqual({
      reason: 'bot_membership_absent',
    });
    expect(getDb().prepare('SELECT denied_at FROM messaging_groups').get()).toEqual({
      denied_at: expect.any(String),
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_subscriptions').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect(recoveryMocks.wakeContainer).not.toHaveBeenCalled();
    await expect(
      approvalModule.recoverMattermostApprovalsForAuthenticatedMembership('primary', new Set()),
    ).resolves.toEqual({
      cancelledPending: 0,
      membershipQuarantined: 0,
      completed: 0,
      quarantined: 0,
    });
  });

  it('recovers a processing approval only after authenticated startup membership confirms the channel', async () => {
    seedProcessingApproval();

    await expect(
      approvalModule.recoverMattermostApprovalsForAuthenticatedMembership('primary', new Set(['channel-recovery'])),
    ).resolves.toEqual({
      cancelledPending: 0,
      membershipQuarantined: 0,
      completed: 1,
      quarantined: 0,
    });

    expect(getDb().prepare('SELECT status FROM pending_mattermost_channel_approvals').get()).toEqual({
      status: 'completed',
    });
    expect(getDb().prepare('SELECT status FROM mattermost_subscriptions').get()).toEqual({ status: 'active' });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });
    expect(recoveryMocks.wakeContainer).toHaveBeenCalledOnce();
  });

  it('rehydrates serialized attachment refs during authenticated startup approval recovery', async () => {
    seedProcessingApproval();
    const eventWithAttachmentRefs = {
      ...EVENT,
      message: {
        ...EVENT.message,
        attachmentRefs: [{ id: 'file-approved-recovery' }],
      },
    };
    getDb()
      .prepare('UPDATE pending_mattermost_channel_approvals SET original_message = ?')
      .run(JSON.stringify(eventWithAttachmentRefs));
    const loadAttachments = vi.fn().mockResolvedValue([
      {
        name: 'recovered.txt',
        mimeType: 'text/plain',
        size: 15,
        data: Buffer.from('recovered bytes'),
      },
    ]);
    const factory = vi.fn().mockReturnValue(loadAttachments);
    const unregister = registerInboundAttachmentLoaderFactory('mattermost', factory);

    try {
      await expect(
        approvalModule.recoverMattermostApprovalsForAuthenticatedMembership('primary', new Set(['channel-recovery'])),
      ).resolves.toEqual({
        cancelledPending: 0,
        membershipQuarantined: 0,
        completed: 1,
        quarantined: 0,
      });
    } finally {
      unregister();
    }

    expect(factory).toHaveBeenCalledOnce();
    expect(loadAttachments).toHaveBeenCalledOnce();
    const session = getDb().prepare('SELECT id, agent_group_id FROM sessions').get() as {
      id: string;
      agent_group_id: string;
    };
    const inbound = openInboundDb(session.agent_group_id, session.id);
    const row = inbound.prepare('SELECT id, content FROM messages_in').get() as { id: string; content: string };
    inbound.close();
    const content = JSON.parse(row.content) as { attachments: Array<Record<string, unknown>> };
    expect(content.attachments).toEqual([
      {
        type: 'file',
        name: 'recovered.txt',
        mimeType: 'text/plain',
        size: 15,
        localPath: `inbox/${row.id}/recovered.txt`,
      },
    ]);
    expect(
      fs.readFileSync(`${sessionDir(session.agent_group_id, session.id)}/inbox/${row.id}/recovered.txt`, 'utf8'),
    ).toBe('recovered bytes');
  });

  it('treats a live owner replay that completes ahead of stale startup recovery as resolved', async () => {
    seedApproval('pending');
    grantRole({
      user_id: 'telegram:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: '2026-07-11T00:00:00.000Z',
    });
    let releaseWake: (() => void) | undefined;
    const pendingWake = new Promise<boolean>((resolve) => {
      releaseWake = () => resolve(true);
    });
    recoveryMocks.wakeContainer.mockReturnValueOnce(pendingWake).mockResolvedValue(true);
    const liveApproval = approvalModule.handleMattermostChannelApprovalResponse({
      questionId: 'mma-recovery',
      value: 'approve',
      userId: 'owner',
      channelType: 'telegram',
      platformId: 'telegram:owner-dm',
      threadId: null,
    });
    await vi.waitFor(() => expect(recoveryMocks.wakeContainer).toHaveBeenCalledOnce());
    expect(getDb().prepare('SELECT status FROM pending_mattermost_channel_approvals').get()).toEqual({
      status: 'processing',
    });

    const startupRecovery = approvalModule.recoverProcessingMattermostChannelApprovals('primary');
    releaseWake?.();

    await expect(Promise.all([liveApproval, startupRecovery])).resolves.toEqual([
      true,
      { completed: 0, quarantined: 0 },
    ]);
    expect(recoveryMocks.wakeContainer).toHaveBeenCalledOnce();
    expect(getDb().prepare('SELECT status FROM pending_mattermost_channel_approvals').get()).toEqual({
      status: 'completed',
    });
  });

  it('deactivates partial processing topology when authenticated membership is absent', async () => {
    seedProcessingApproval();
    subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-recovery',
      recoveryBaseline: {
        postId: EVENT.message.id,
        createAt: Date.parse(EVENT.message.timestamp),
      },
    });

    await expect(
      approvalModule.recoverMattermostApprovalsForAuthenticatedMembership('primary', new Set()),
    ).resolves.toEqual({
      cancelledPending: 0,
      membershipQuarantined: 1,
      completed: 0,
      quarantined: 0,
    });

    expect(getDb().prepare('SELECT status FROM mattermost_subscriptions').get()).toEqual({
      status: 'unsubscribed',
    });
    expect(getDb().prepare('SELECT status FROM pending_mattermost_channel_approvals').get()).toEqual({
      status: 'processing',
    });
    expect(getDb().prepare('SELECT reason FROM mattermost_approval_recovery_quarantine').get()).toEqual({
      reason: 'bot_membership_absent',
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect(recoveryMocks.wakeContainer).not.toHaveBeenCalled();
  });

  it('resumes a claimed pre-topology approval through one exact replay', async () => {
    seedProcessingApproval();
    const recover = (
      approvalModule as typeof approvalModule & {
        recoverProcessingMattermostChannelApprovals?: () => Promise<{ completed: number; quarantined: number }>;
      }
    ).recoverProcessingMattermostChannelApprovals;

    expect(recover).toBeTypeOf('function');
    await expect(recover?.()).resolves.toEqual({ completed: 1, quarantined: 0 });

    const subscription = getDb()
      .prepare(
        `SELECT instance_key, channel_id, messaging_group_id, agent_group_id, status
           FROM mattermost_subscriptions`,
      )
      .get() as {
      instance_key: string;
      channel_id: string;
      messaging_group_id: string;
      agent_group_id: string;
      status: string;
    };
    expect(subscription).toMatchObject({
      instance_key: 'primary',
      channel_id: 'channel-recovery',
      messaging_group_id: 'mg-mattermost-recovery-placeholder',
      status: 'active',
    });
    expect(getDb().prepare('SELECT user_id, agent_group_id, added_by FROM agent_group_members').all()).toEqual([
      {
        user_id: 'mattermost:user-requester',
        agent_group_id: subscription.agent_group_id,
        added_by: 'telegram:owner',
      },
    ]);
    const sessions = getDb()
      .prepare('SELECT id, agent_group_id, messaging_group_id, thread_id FROM sessions')
      .all() as Array<{ id: string; agent_group_id: string; messaging_group_id: string; thread_id: string | null }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      agent_group_id: subscription.agent_group_id,
      messaging_group_id: subscription.messaging_group_id,
      thread_id: null,
    });
    const inbound = openInboundDb(subscription.agent_group_id, sessions[0].id);
    expect(inbound.prepare('SELECT id, content, trigger FROM messages_in').all()).toEqual([
      {
        id: `${EVENT.message.id}:${subscription.agent_group_id}`,
        content: EVENT.message.content,
        trigger: 1,
      },
    ]);
    inbound.close();
    expect(recoveryMocks.wakeContainer).toHaveBeenCalledOnce();
    expect(
      getDb()
        .prepare('SELECT status, replayed_at IS NOT NULL AS replayed FROM pending_mattermost_channel_approvals')
        .get(),
    ).toEqual({ status: 'completed', replayed: 1 });
    expect(
      getDb()
        .prepare(
          `SELECT last_post_created_at, last_post_id
             FROM mattermost_recovery_cursors
            WHERE instance_key = 'primary' AND channel_id = 'channel-recovery'`,
        )
        .get(),
    ).toEqual({
      last_post_created_at: Date.parse(EVENT.message.timestamp),
      last_post_id: EVENT.message.id,
    });
  });

  it('bootstraps an upgraded active subscription from its completed authorized approval', async () => {
    seedProcessingApproval();
    await approvalModule.recoverProcessingMattermostChannelApprovals();
    getDb()
      .prepare("DELETE FROM mattermost_recovery_cursors WHERE instance_key = 'primary' AND channel_id = ?")
      .run('channel-recovery');
    const bootstrap = (
      approvalModule as typeof approvalModule & {
        bootstrapLegacyMattermostRecoveryCursors?: () => { seeded: number; rejected: number };
      }
    ).bootstrapLegacyMattermostRecoveryCursors;
    expect(bootstrap).toBeTypeOf('function');
    if (!bootstrap) return;

    expect(bootstrap()).toEqual({ seeded: 1, rejected: 0 });
    expect(
      getDb()
        .prepare(
          `SELECT last_post_created_at, last_post_id
             FROM mattermost_recovery_cursors
            WHERE instance_key = 'primary' AND channel_id = 'channel-recovery'`,
        )
        .get(),
    ).toEqual({
      last_post_created_at: Date.parse(EVENT.message.timestamp),
      last_post_id: EVENT.message.id,
    });
  });

  it('bootstraps legacy cursors only for the authenticated Mattermost instance', async () => {
    seedProcessingApproval('secondary');
    await approvalModule.recoverProcessingMattermostChannelApprovals();
    getDb().prepare('DELETE FROM mattermost_recovery_cursors').run();

    expect(approvalModule.bootstrapLegacyMattermostRecoveryCursors('primary')).toEqual({ seeded: 0, rejected: 0 });
    expect(getDb().prepare('SELECT 1 FROM mattermost_recovery_cursors').get()).toBeUndefined();
  });

  it('rejects an unsafe legacy approval post identity instead of seeding a cursor', async () => {
    seedProcessingApproval();
    await approvalModule.recoverProcessingMattermostChannelApprovals();
    getDb()
      .prepare("DELETE FROM mattermost_recovery_cursors WHERE instance_key = 'primary' AND channel_id = ?")
      .run('channel-recovery');
    getDb()
      .prepare('UPDATE pending_mattermost_channel_approvals SET original_message = ?')
      .run(JSON.stringify({ ...EVENT, message: { ...EVENT.message, id: '../unsafe-post-id' } }));

    expect(approvalModule.bootstrapLegacyMattermostRecoveryCursors()).toEqual({ seeded: 0, rejected: 1 });
    expect(getDb().prepare('SELECT 1 FROM mattermost_recovery_cursors').get()).toBeUndefined();
  });

  it('re-wakes one exact pending replay persisted before the host crash', async () => {
    seedProcessingApproval();
    const subscription = subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-recovery',
    });
    upsertUser({
      id: 'mattermost:user-requester',
      kind: 'mattermost',
      display_name: null,
      created_at: '2026-07-11T00:00:00.000Z',
    });
    addMember({
      user_id: 'mattermost:user-requester',
      agent_group_id: subscription.agentGroup.id,
      added_by: 'telegram:owner',
      added_at: '2026-07-11T00:00:00.000Z',
    });
    await routeInbound(EVENT);
    recoveryMocks.wakeContainer.mockClear();

    await expect(approvalModule.recoverProcessingMattermostChannelApprovals()).resolves.toEqual({
      completed: 1,
      quarantined: 0,
    });

    const [session] = getDb().prepare('SELECT id FROM sessions').all() as Array<{ id: string }>;
    const inbound = openInboundDb(subscription.agentGroup.id, session.id);
    expect(inbound.prepare('SELECT id FROM messages_in').all()).toEqual([
      { id: `${EVENT.message.id}:${subscription.agentGroup.id}` },
    ]);
    inbound.close();
    expect(recoveryMocks.wakeContainer).toHaveBeenCalledOnce();
    expect(getDb().prepare('SELECT status FROM pending_mattermost_channel_approvals').get()).toEqual({
      status: 'completed',
    });
  });

  it('does not regress a cursor that advanced while the owner decision was pending', async () => {
    seedProcessingApproval();
    subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-recovery',
    });
    const newerCreateAt = Date.parse(EVENT.message.timestamp) + 1_000;
    expect(
      advanceMattermostRecoveryCursor({
        instanceKey: 'primary',
        channelId: 'channel-recovery',
        lastPostCreatedAt: newerCreateAt,
        lastPostId: 'mattermost-post-after-trigger',
      }),
    ).toBe(true);

    await expect(approvalModule.recoverProcessingMattermostChannelApprovals()).resolves.toEqual({
      completed: 1,
      quarantined: 0,
    });

    expect(
      getDb()
        .prepare(
          `SELECT last_post_created_at, last_post_id
             FROM mattermost_recovery_cursors
            WHERE instance_key = 'primary' AND channel_id = 'channel-recovery'`,
        )
        .get(),
    ).toEqual({
      last_post_created_at: newerCreateAt,
      last_post_id: 'mattermost-post-after-trigger',
    });
  });

  it('does not re-wake an exact replay that already completed execution', async () => {
    seedProcessingApproval();
    const subscription = subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-recovery',
    });
    upsertUser({
      id: 'mattermost:user-requester',
      kind: 'mattermost',
      display_name: null,
      created_at: '2026-07-11T00:00:00.000Z',
    });
    addMember({
      user_id: 'mattermost:user-requester',
      agent_group_id: subscription.agentGroup.id,
      added_by: 'telegram:owner',
      added_at: '2026-07-11T00:00:00.000Z',
    });
    await routeInbound(EVENT);
    const [session] = getDb().prepare('SELECT id FROM sessions').all() as Array<{ id: string }>;
    const inbound = openInboundDb(subscription.agentGroup.id, session.id);
    inbound.prepare("UPDATE messages_in SET status = 'completed'").run();
    inbound.close();
    recoveryMocks.wakeContainer.mockClear();

    await expect(approvalModule.recoverProcessingMattermostChannelApprovals()).resolves.toEqual({
      completed: 1,
      quarantined: 0,
    });

    const reopened = openInboundDb(subscription.agentGroup.id, session.id);
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM messages_in').get()).toEqual({ count: 1 });
    reopened.close();
    expect(recoveryMocks.wakeContainer).not.toHaveBeenCalled();
  });

  it('quarantines a malformed stored event without creating or waking topology', async () => {
    seedProcessingApproval();
    getDb().prepare("UPDATE pending_mattermost_channel_approvals SET original_message = '{malformed'").run();

    await expect(approvalModule.recoverProcessingMattermostChannelApprovals()).resolves.toEqual({
      completed: 0,
      quarantined: 1,
    });

    expect(
      getDb()
        .prepare(
          `SELECT approval_id, reason
             FROM mattermost_approval_recovery_quarantine`,
        )
        .all(),
    ).toEqual([{ approval_id: 'mma-recovery', reason: 'invalid_stored_event' }]);
    expect(getDb().prepare('SELECT status FROM pending_mattermost_channel_approvals').get()).toEqual({
      status: 'processing',
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_subscriptions').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM agent_groups').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect(recoveryMocks.wakeContainer).not.toHaveBeenCalled();
    await expect(approvalModule.recoverProcessingMattermostChannelApprovals()).resolves.toEqual({
      completed: 0,
      quarantined: 0,
    });
  });

  it.each([
    ['malformed attachment refs', { attachmentRefs: [{ id: '../file' }] }],
    ['duplicate attachment refs', { attachmentRefs: [{ id: 'file-a' }, { id: 'file-a' }] }],
    ['serialized loader shadow', { attachmentRefs: [{ id: 'file-a' }], loadAttachments: 'shadow' }],
  ])('quarantines a stored event with %s', async (_label, messagePatch) => {
    seedProcessingApproval();
    getDb()
      .prepare('UPDATE pending_mattermost_channel_approvals SET original_message = ?')
      .run(JSON.stringify({ ...EVENT, message: { ...EVENT.message, ...messagePatch } }));

    await expect(approvalModule.recoverProcessingMattermostChannelApprovals()).resolves.toEqual({
      completed: 0,
      quarantined: 1,
    });

    expect(getDb().prepare('SELECT reason FROM mattermost_approval_recovery_quarantine').get()).toEqual({
      reason: 'invalid_stored_event',
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_subscriptions').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect(recoveryMocks.wakeContainer).not.toHaveBeenCalled();
  });

  it('quarantines a stored event whose channel identity differs from the claimed approval', async () => {
    seedProcessingApproval();
    getDb()
      .prepare('UPDATE pending_mattermost_channel_approvals SET original_message = ?')
      .run(JSON.stringify({ ...EVENT, platformId: 'mattermost:primary:other-channel' }));

    await expect(approvalModule.recoverProcessingMattermostChannelApprovals()).resolves.toEqual({
      completed: 0,
      quarantined: 1,
    });

    expect(getDb().prepare('SELECT reason FROM mattermost_approval_recovery_quarantine').get()).toEqual({
      reason: 'event_identity_mismatch',
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_subscriptions').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect(recoveryMocks.wakeContainer).not.toHaveBeenCalled();
  });

  it('quarantines an unowned canonical workspace left before the topology commit', async () => {
    seedProcessingApproval();
    const digest = createHash('sha256').update('primary\0channel-recovery').digest('hex').slice(0, 24);
    const orphan = `${recoveryMocks.testRoot}/groups/mattermost-${digest}`;
    fs.mkdirSync(orphan, { recursive: true });

    await expect(approvalModule.recoverProcessingMattermostChannelApprovals()).resolves.toEqual({
      completed: 0,
      quarantined: 1,
    });

    expect(getDb().prepare('SELECT reason FROM mattermost_approval_recovery_quarantine').get()).toEqual({
      reason: 'orphan_workspace_identity',
    });
    expect(fs.statSync(orphan).isDirectory()).toBe(true);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_subscriptions').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM agent_groups').get()).toEqual({ count: 0 });
    expect(recoveryMocks.wakeContainer).not.toHaveBeenCalled();
  });

  it('quarantines a claimed pre-topology approval after its placeholder stops being pristine', async () => {
    seedProcessingApproval();
    getDb().prepare("UPDATE messaging_groups SET unknown_sender_policy = 'strict'").run();

    await expect(approvalModule.recoverProcessingMattermostChannelApprovals()).resolves.toEqual({
      completed: 0,
      quarantined: 1,
    });

    expect(getDb().prepare('SELECT reason FROM mattermost_approval_recovery_quarantine').get()).toEqual({
      reason: 'non_pristine_placeholder',
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_subscriptions').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM agent_groups').get()).toEqual({ count: 0 });
    expect(recoveryMocks.wakeContainer).not.toHaveBeenCalled();
  });

  it('quarantines an invalid committed subscription topology without replaying', async () => {
    seedProcessingApproval();
    const subscription = subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-recovery',
    });
    getDb().exec('DROP TRIGGER mattermost_guard_canonical_wiring_update');
    getDb()
      .prepare("UPDATE messaging_group_agents SET session_mode = 'per-thread' WHERE id = ?")
      .run(subscription.wiring.id);

    await expect(approvalModule.recoverProcessingMattermostChannelApprovals()).resolves.toEqual({
      completed: 0,
      quarantined: 1,
    });

    expect(getDb().prepare('SELECT reason FROM mattermost_approval_recovery_quarantine').get()).toEqual({
      reason: 'invalid_subscription_topology',
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM agent_group_members').get()).toEqual({ count: 0 });
    expect(recoveryMocks.wakeContainer).not.toHaveBeenCalled();
  });

  it('quarantines a committed subscription whose canonical workspace is unsafe', async () => {
    seedProcessingApproval();
    const subscription = subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-recovery',
    });
    const groupPath = `${recoveryMocks.testRoot}/groups/${subscription.agentGroup.folder}`;
    const outside = `${recoveryMocks.testRoot}/outside`;
    fs.mkdirSync(outside, { recursive: true });
    fs.rmSync(groupPath, { recursive: true, force: true });
    fs.symlinkSync(outside, groupPath);

    await expect(approvalModule.recoverProcessingMattermostChannelApprovals()).resolves.toEqual({
      completed: 0,
      quarantined: 1,
    });

    expect(getDb().prepare('SELECT reason FROM mattermost_approval_recovery_quarantine').get()).toEqual({
      reason: 'unsafe_subscription_filesystem',
    });
    expect(fs.lstatSync(groupPath).isSymbolicLink()).toBe(true);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM agent_group_members').get()).toEqual({ count: 0 });
    expect(recoveryMocks.wakeContainer).not.toHaveBeenCalled();
  });

  it('quarantines a partial topology with a non-shared channel session', async () => {
    seedProcessingApproval();
    const subscription = subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-recovery',
    });
    resolveSession(subscription.agentGroup.id, subscription.messagingGroup.id, 'wrong-thread', 'per-thread');

    await expect(approvalModule.recoverProcessingMattermostChannelApprovals()).resolves.toEqual({
      completed: 0,
      quarantined: 1,
    });

    expect(getDb().prepare('SELECT reason FROM mattermost_approval_recovery_quarantine').get()).toEqual({
      reason: 'invalid_session_topology',
    });
    expect(getDb().prepare('SELECT thread_id FROM sessions').all()).toEqual([{ thread_id: 'wrong-thread' }]);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM agent_group_members').get()).toEqual({ count: 0 });
    expect(recoveryMocks.wakeContainer).not.toHaveBeenCalled();
  });

  it('quarantines a deterministic inbound identity collision without waking it', async () => {
    seedProcessingApproval();
    const subscription = subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-recovery',
    });
    upsertUser({
      id: 'mattermost:user-requester',
      kind: 'mattermost',
      display_name: null,
      created_at: '2026-07-11T00:00:00.000Z',
    });
    addMember({
      user_id: 'mattermost:user-requester',
      agent_group_id: subscription.agentGroup.id,
      added_by: 'telegram:owner',
      added_at: '2026-07-11T00:00:00.000Z',
    });
    await routeInbound(EVENT);
    const [session] = getDb().prepare('SELECT id FROM sessions').all() as Array<{ id: string }>;
    const inbound = openInboundDb(subscription.agentGroup.id, session.id);
    inbound.prepare('UPDATE messages_in SET content = ?').run(JSON.stringify({ text: 'COLLISION' }));
    inbound.close();
    recoveryMocks.wakeContainer.mockClear();

    await expect(approvalModule.recoverProcessingMattermostChannelApprovals()).resolves.toEqual({
      completed: 0,
      quarantined: 1,
    });

    expect(getDb().prepare('SELECT reason FROM mattermost_approval_recovery_quarantine').get()).toEqual({
      reason: 'message_identity_collision',
    });
    expect(getDb().prepare('SELECT status FROM pending_mattermost_channel_approvals').get()).toEqual({
      status: 'processing',
    });
    expect(recoveryMocks.wakeContainer).not.toHaveBeenCalled();
  });

  it('quarantines an unsafe pre-existing session database artifact', async () => {
    seedProcessingApproval();
    const subscription = subscribeMattermostChannelStrict({
      instanceKey: 'primary',
      channelId: 'channel-recovery',
    });
    upsertUser({
      id: 'mattermost:user-requester',
      kind: 'mattermost',
      display_name: null,
      created_at: '2026-07-11T00:00:00.000Z',
    });
    addMember({
      user_id: 'mattermost:user-requester',
      agent_group_id: subscription.agentGroup.id,
      added_by: 'telegram:owner',
      added_at: '2026-07-11T00:00:00.000Z',
    });
    await routeInbound(EVENT);
    const [session] = getDb().prepare('SELECT id FROM sessions').all() as Array<{ id: string }>;
    const inboundPath = inboundDbPath(subscription.agentGroup.id, session.id);
    const outside = `${recoveryMocks.testRoot}/outside-inbound.db`;
    fs.writeFileSync(outside, 'not a session database');
    fs.rmSync(inboundPath, { force: true });
    fs.symlinkSync(outside, inboundPath);
    recoveryMocks.wakeContainer.mockClear();

    await expect(approvalModule.recoverProcessingMattermostChannelApprovals()).resolves.toEqual({
      completed: 0,
      quarantined: 1,
    });

    expect(getDb().prepare('SELECT reason FROM mattermost_approval_recovery_quarantine').get()).toEqual({
      reason: 'invalid_session_topology',
    });
    expect(fs.lstatSync(inboundPath).isSymbolicLink()).toBe(true);
    expect(recoveryMocks.wakeContainer).not.toHaveBeenCalled();
  });

  it('propagates a lost completion transition while preserving the exact replay for retry', async () => {
    seedProcessingApproval();
    getDb().exec(`
      CREATE TRIGGER ignore_mattermost_recovery_completion
      BEFORE UPDATE OF status ON pending_mattermost_channel_approvals
      WHEN NEW.status = 'completed'
      BEGIN
        SELECT RAISE(IGNORE);
      END
    `);

    await expect(approvalModule.recoverProcessingMattermostChannelApprovals()).rejects.toThrow(
      'Mattermost approval recovery completion transition failed',
    );

    expect(getDb().prepare('SELECT status FROM pending_mattermost_channel_approvals').get()).toEqual({
      status: 'processing',
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_approval_recovery_quarantine').get()).toEqual({
      count: 0,
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });
    expect(recoveryMocks.wakeContainer).toHaveBeenCalledOnce();
  });

  it('propagates an operational failure and resumes the same processing row on retry', async () => {
    seedProcessingApproval();
    getDb().exec(`
      CREATE TRIGGER fail_mattermost_recovery_membership
      BEFORE INSERT ON agent_group_members
      BEGIN
        SELECT RAISE(ABORT, 'injected operational membership failure');
      END
    `);

    await expect(approvalModule.recoverProcessingMattermostChannelApprovals()).rejects.toThrow(
      'injected operational membership failure',
    );
    expect(getDb().prepare('SELECT status FROM pending_mattermost_channel_approvals').get()).toEqual({
      status: 'processing',
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_approval_recovery_quarantine').get()).toEqual({
      count: 0,
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM mattermost_subscriptions').get()).toEqual({ count: 1 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect(recoveryMocks.wakeContainer).not.toHaveBeenCalled();

    getDb().exec('DROP TRIGGER fail_mattermost_recovery_membership');
    await expect(approvalModule.recoverProcessingMattermostChannelApprovals()).resolves.toEqual({
      completed: 1,
      quarantined: 0,
    });
    expect(getDb().prepare('SELECT status FROM pending_mattermost_channel_approvals').get()).toEqual({
      status: 'completed',
    });
    expect(recoveryMocks.wakeContainer).toHaveBeenCalledOnce();
  });

  it('keeps a quarantined approval processing and outside normal completion or release transitions', () => {
    seedProcessingApproval();
    expect(
      quarantineProcessingMattermostChannelApproval('mma-recovery', 'invalid_stored_event', '2026-07-11T00:01:00.000Z'),
    ).toBe(true);

    releasePendingMattermostChannelApproval('mma-recovery');
    expect(completeMattermostChannelApprovalReplay('mma-recovery', '2026-07-11T00:02:00.000Z')).toBe(false);

    expect(getDb().prepare('SELECT status, replayed_at FROM pending_mattermost_channel_approvals').get()).toEqual({
      status: 'processing',
      replayed_at: null,
    });
  });
});
