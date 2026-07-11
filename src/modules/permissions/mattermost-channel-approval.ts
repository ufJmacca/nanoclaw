import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { subscribeMattermostChannelStrict } from '../../channels/mattermost-subscription.js';
import { getMessagingGroup, getMessagingGroupAgents } from '../../db/messaging-groups.js';
import { getDb } from '../../db/connection.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { ResponsePayload } from '../../response-registry.js';
import { routeInbound } from '../../router.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { pickApprovalDelivery } from '../approvals/primitive.js';
import {
  claimPendingMattermostChannelApproval,
  completeMattermostChannelApprovalReplay,
  createPendingMattermostChannelApproval,
  deletePendingMattermostChannelApproval,
  getPendingMattermostChannelApproval,
  hasPendingMattermostChannelApproval,
  releasePendingMattermostChannelApproval,
  rejectPendingMattermostChannelApproval,
} from './db/pending-mattermost-channel-approvals.js';
import { addMember } from './db/agent-group-members.js';
import { getOwners, isOwner } from './db/user-roles.js';
import { upsertUser } from './db/users.js';

const SAFE_IDENTITY_COMPONENT = '[A-Za-z0-9][A-Za-z0-9._-]{0,127}';
const MATTERMOST_PLATFORM_ID = new RegExp(`^mattermost:(${SAFE_IDENTITY_COMPONENT}):(${SAFE_IDENTITY_COMPONENT})$`);
const MATTERMOST_USER_ID = new RegExp(`^mattermost:(${SAFE_IDENTITY_COMPONENT})$`);

const SUBSCRIPTION_OPTIONS: RawOption[] = [
  { label: 'Subscribe', selectedLabel: '✅ Subscribed', value: 'approve' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
];

function parseMattermostChannel(platformId: string): { instanceKey: string; channelId: string } | null {
  const match = MATTERMOST_PLATFORM_ID.exec(platformId);
  return match ? { instanceKey: match[1], channelId: match[2] } : null;
}

function requesterFromEvent(event: InboundEvent): string | null {
  try {
    const content = JSON.parse(event.message.content) as Record<string, unknown>;
    const senderId = typeof content.senderId === 'string' ? content.senderId : null;
    return senderId && MATTERMOST_USER_ID.test(senderId) ? senderId : null;
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

function isPristineMattermostPlaceholder(messagingGroupId: string, platformId: string): boolean {
  const mg = getMessagingGroup(messagingGroupId);
  if (
    !mg ||
    mg.channel_type !== 'mattermost' ||
    mg.platform_id !== platformId ||
    mg.is_group !== 1 ||
    mg.unknown_sender_policy !== 'request_approval' ||
    mg.denied_at !== null ||
    getMessagingGroupAgents(messagingGroupId).length !== 0
  ) {
    return false;
  }
  const references = getDb()
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sessions WHERE messaging_group_id = ?) +
         (SELECT COUNT(*) FROM agent_destinations WHERE target_type = 'channel' AND target_id = ?) AS count`,
    )
    .get(messagingGroupId, messagingGroupId) as { count: number };
  return references.count === 0;
}

function generateApprovalId(): string {
  return `mma-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function requestMattermostChannelApproval(messagingGroupId: string, event: InboundEvent): Promise<void> {
  const channel = parseMattermostChannel(event.platformId);
  const requesterUserId = requesterFromEvent(event);
  if (!channel || !requesterUserId || !isPristineMattermostPlaceholder(messagingGroupId, event.platformId)) {
    log.warn('Mattermost subscription approval rejected invalid pending channel', { messagingGroupId });
    return;
  }
  if (hasPendingMattermostChannelApproval(channel.instanceKey, channel.channelId)) return;

  // Of the built-in adapters, Telegram is currently the only owner
  // destination with an authenticated interactive button round-trip. Native
  // Mattermost and CLI cannot return this approve/reject card yet.
  const owners = getOwners()
    .map((owner) => owner.user_id)
    .filter((userId) => userId.startsWith('telegram:'));
  const target = await pickApprovalDelivery(owners, 'telegram');
  if (!target) {
    log.warn('Mattermost subscription approval skipped because no owner DM is reachable', { messagingGroupId });
    return;
  }
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('Mattermost subscription approval skipped because delivery is unavailable', { messagingGroupId });
    return;
  }
  if (adapter.isAvailable?.(target.messagingGroup.channel_type) === false) {
    log.warn('Mattermost subscription approval deferred until the owner channel is active', {
      messagingGroupId,
      ownerChannelType: target.messagingGroup.channel_type,
    });
    return;
  }

  const approvalId = generateApprovalId();
  const title = 'Mattermost channel subscription request';
  const question = `Subscribe ${event.platformId} as a new isolated agent group?`;
  const options = normalizeOptions(SUBSCRIPTION_OPTIONS);
  const created = createPendingMattermostChannelApproval({
    approval_id: approvalId,
    instance_key: channel.instanceKey,
    channel_id: channel.channelId,
    messaging_group_id: messagingGroupId,
    requester_user_id: requesterUserId,
    approver_user_id: target.userId,
    original_message: JSON.stringify(event),
    status: 'pending',
    created_at: new Date().toISOString(),
    decided_at: null,
    decided_by: null,
    replayed_at: null,
    title,
    options_json: JSON.stringify(options),
  });
  if (!created) return;

  try {
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({ type: 'ask_question', questionId: approvalId, title, question, options }),
    );
  } catch (err) {
    deletePendingMattermostChannelApproval(approvalId);
    throw err;
  }
}

export async function handleMattermostChannelApprovalResponse(payload: ResponsePayload): Promise<boolean> {
  const row = getPendingMattermostChannelApproval(payload.questionId);
  if (!row) return false;

  const clickerId = payload.userId ? `${payload.channelType}:${payload.userId}` : null;
  if (clickerId !== row.approver_user_id || !clickerId || !isOwner(clickerId)) {
    log.warn('Mattermost subscription decision rejected because clicker is not the designated owner', {
      approvalId: row.approval_id,
      clickerId,
    });
    return true;
  }

  if (payload.value === 'reject') {
    rejectPendingMattermostChannelApproval(row.approval_id, clickerId, new Date().toISOString());
    return true;
  }
  if (payload.value !== 'approve') return true;

  let event: InboundEvent;
  try {
    event = JSON.parse(row.original_message) as InboundEvent;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    log.error('Mattermost subscription approval contains an invalid stored event', { approvalId: row.approval_id });
    return true;
  }
  const expectedPlatformId = `mattermost:${row.instance_key}:${row.channel_id}`;
  if (
    event.channelType !== 'mattermost' ||
    event.platformId !== expectedPlatformId ||
    requesterFromEvent(event) !== row.requester_user_id
  ) {
    log.error('Mattermost subscription approval event identity does not match the pending request', {
      approvalId: row.approval_id,
    });
    return true;
  }

  const claimed = claimPendingMattermostChannelApproval(row.approval_id);
  if (!claimed) return true;
  try {
    const subscription = subscribeMattermostChannelStrict({
      instanceKey: row.instance_key,
      channelId: row.channel_id,
    });
    upsertUser({
      id: row.requester_user_id,
      kind: 'mattermost',
      display_name: null,
      created_at: new Date().toISOString(),
    });
    addMember({
      user_id: row.requester_user_id,
      agent_group_id: subscription.agentGroup.id,
      added_by: clickerId,
      added_at: new Date().toISOString(),
    });
    await routeInbound(event);
    completeMattermostChannelApprovalReplay(row.approval_id, new Date().toISOString());
  } catch (err) {
    releasePendingMattermostChannelApproval(row.approval_id);
    throw err;
  }
  return true;
}
