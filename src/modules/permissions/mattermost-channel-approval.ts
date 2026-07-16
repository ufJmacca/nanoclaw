import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { mattermostChannelSequencer } from '../../channels/mattermost-inbound.js';
import {
  subscribeMattermostChannelStrict,
  handleMattermostBotRemoved,
  validateMattermostSessionForExecution,
  validateMattermostSubscriptionForRouting,
} from '../../channels/mattermost-subscription.js';
import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { getMessagingGroup, getMessagingGroupAgents } from '../../db/messaging-groups.js';
import { getDb } from '../../db/connection.js';
import { findSessionForAgent } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { ResponsePayload } from '../../response-registry.js';
import { routeInbound } from '../../router.js';
import { inboundDbPath, openInboundDb, outboundDbPath, sessionDir } from '../../session-manager.js';
import type { Session } from '../../types.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { pickApprovalDelivery } from '../approvals/primitive.js';
import {
  claimPendingMattermostChannelApproval,
  completeMattermostChannelApprovalReplay,
  createPendingMattermostChannelApproval,
  deletePendingMattermostChannelApproval,
  getPendingMattermostChannelApproval,
  hasPendingMattermostChannelApproval,
  listProcessingMattermostChannelApprovals,
  listUnfinishedMattermostChannelApprovals,
  quarantineProcessingMattermostChannelApproval,
  releasePendingMattermostChannelApproval,
  rejectPendingMattermostChannelApproval,
  type MattermostApprovalRecoveryQuarantineReason,
  type PendingMattermostChannelApproval,
} from './db/pending-mattermost-channel-approvals.js';
import { addMember } from './db/agent-group-members.js';
import { getOwners, isOwner } from './db/user-roles.js';
import { upsertUser } from './db/users.js';

const SAFE_IDENTITY_COMPONENT = '[A-Za-z0-9][A-Za-z0-9._-]{0,127}';
const MATTERMOST_PLATFORM_ID = new RegExp(`^mattermost:(${SAFE_IDENTITY_COMPONENT}):(${SAFE_IDENTITY_COMPONENT})$`);
const MATTERMOST_USER_ID = new RegExp(`^mattermost:(${SAFE_IDENTITY_COMPONENT})$`);
const MATTERMOST_POST_ID = new RegExp(`^${SAFE_IDENTITY_COMPONENT}$`);
const MATTERMOST_APPROVAL_MAX_ATTACHMENTS = 5;

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

function parseStoredMattermostApprovalEvent(row: PendingMattermostChannelApproval):
  | { valid: true; event: InboundEvent }
  | {
      valid: false;
      reason: Extract<MattermostApprovalRecoveryQuarantineReason, 'invalid_stored_event' | 'event_identity_mismatch'>;
    } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.original_message);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { valid: false, reason: 'invalid_stored_event' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, reason: 'invalid_stored_event' };
  }
  const candidate = parsed as Record<string, unknown>;
  const message = candidate.message;
  if (
    candidate.channelType !== 'mattermost' ||
    typeof candidate.platformId !== 'string' ||
    (candidate.threadId !== null && typeof candidate.threadId !== 'string') ||
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message)
  ) {
    return { valid: false, reason: 'invalid_stored_event' };
  }
  const candidateMessage = message as Record<string, unknown>;
  const attachmentRefs = candidateMessage.attachmentRefs;
  const validAttachmentRefs =
    attachmentRefs === undefined ||
    (Array.isArray(attachmentRefs) &&
      attachmentRefs.length > 0 &&
      attachmentRefs.length <= MATTERMOST_APPROVAL_MAX_ATTACHMENTS &&
      attachmentRefs.every(
        (reference) =>
          reference !== null &&
          typeof reference === 'object' &&
          !Array.isArray(reference) &&
          Object.keys(reference).length === 1 &&
          typeof (reference as Record<string, unknown>).id === 'string' &&
          MATTERMOST_POST_ID.test((reference as Record<string, unknown>).id as string),
      ) &&
      new Set(attachmentRefs.map((reference) => (reference as { id: string }).id)).size === attachmentRefs.length);
  const messageTimestamp =
    typeof candidateMessage.timestamp === 'string' ? Date.parse(candidateMessage.timestamp) : Number.NaN;
  if (
    typeof candidateMessage.id !== 'string' ||
    !MATTERMOST_POST_ID.test(candidateMessage.id) ||
    candidateMessage.kind !== 'chat' ||
    typeof candidateMessage.content !== 'string' ||
    !Number.isSafeInteger(messageTimestamp) ||
    messageTimestamp < 0 ||
    candidateMessage.isMention !== true ||
    candidateMessage.isGroup !== true ||
    candidateMessage.loadAttachments !== undefined ||
    !validAttachmentRefs
  ) {
    return { valid: false, reason: 'invalid_stored_event' };
  }

  const event = parsed as InboundEvent;
  const expectedPlatformId = `mattermost:${row.instance_key}:${row.channel_id}`;
  if (event.platformId !== expectedPlatformId || requesterFromEvent(event) !== row.requester_user_id) {
    return { valid: false, reason: 'event_identity_mismatch' };
  }
  return { valid: true, event };
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

function isSafeOwnedRecoveryDirectory(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }

  const rootStat = fs.lstatSync(resolvedRoot, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return false;
  let cursor = resolvedRoot;
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component);
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
  }

  const canonicalRoot = fs.realpathSync(resolvedRoot);
  const canonicalCandidate = fs.realpathSync(resolvedCandidate);
  const canonicalRelative = path.relative(canonicalRoot, canonicalCandidate);
  return (
    canonicalRelative !== '' &&
    canonicalRelative !== '..' &&
    !canonicalRelative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(canonicalRelative)
  );
}

function isSafeOwnedRecoveryFile(parent: string, candidate: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedParent, resolvedCandidate);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  const stat = fs.lstatSync(resolvedCandidate, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return false;
  const canonicalParent = fs.realpathSync(resolvedParent);
  const canonicalCandidate = fs.realpathSync(resolvedCandidate);
  const canonicalRelative = path.relative(canonicalParent, canonicalCandidate);
  if (
    canonicalRelative === '' ||
    canonicalRelative === '..' ||
    canonicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(canonicalRelative)
  ) {
    return false;
  }
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const sidecar = fs.lstatSync(`${resolvedCandidate}${suffix}`, { throwIfNoEntry: false });
    if (sidecar && (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1)) return false;
  }
  return true;
}

function classifyMattermostApprovalTopologyCorruption(
  row: PendingMattermostChannelApproval,
): Extract<
  MattermostApprovalRecoveryQuarantineReason,
  | 'non_pristine_placeholder'
  | 'orphan_workspace_identity'
  | 'invalid_subscription_topology'
  | 'unsafe_subscription_filesystem'
  | 'invalid_session_topology'
> | null {
  const subscription = getDb()
    .prepare(
      `SELECT messaging_group_id
         FROM mattermost_subscriptions
        WHERE instance_key = ? AND channel_id = ?`,
    )
    .get(row.instance_key, row.channel_id) as { messaging_group_id: string } | undefined;
  const subscriptionByMessagingGroup = getDb()
    .prepare('SELECT instance_key, channel_id FROM mattermost_subscriptions WHERE messaging_group_id = ?')
    .get(row.messaging_group_id) as { instance_key: string; channel_id: string } | undefined;
  if (subscription) {
    if (subscription.messaging_group_id !== row.messaging_group_id) return 'invalid_subscription_topology';
    const messagingGroup = getMessagingGroup(row.messaging_group_id);
    if (!messagingGroup) return 'invalid_subscription_topology';
    const validation = validateMattermostSubscriptionForRouting(messagingGroup);
    if (!validation.valid) {
      return 'invalid_subscription_topology';
    }
    const stateRoot = path.join(DATA_DIR, 'v2-sessions');
    if (
      !isSafeOwnedRecoveryDirectory(GROUPS_DIR, path.join(GROUPS_DIR, validation.value.agentGroup.folder)) ||
      !isSafeOwnedRecoveryDirectory(stateRoot, path.join(stateRoot, validation.value.agentGroup.id))
    ) {
      return 'unsafe_subscription_filesystem';
    }
    const sessions = getDb()
      .prepare(
        `SELECT *
           FROM sessions
          WHERE agent_group_id = ? OR messaging_group_id = ?`,
      )
      .all(validation.value.agentGroup.id, validation.value.messagingGroup.id) as Session[];
    if (sessions.length > 1) return 'invalid_session_topology';
    if (sessions.length === 1) {
      const sessionBoundary = validateMattermostSessionForExecution(sessions[0]);
      if (!sessionBoundary.strict || !sessionBoundary.valid) return 'invalid_session_topology';
      const ownedSessionDir = sessionDir(sessions[0].agent_group_id, sessions[0].id);
      if (
        !isSafeOwnedRecoveryFile(ownedSessionDir, inboundDbPath(sessions[0].agent_group_id, sessions[0].id)) ||
        !isSafeOwnedRecoveryFile(ownedSessionDir, outboundDbPath(sessions[0].agent_group_id, sessions[0].id))
      ) {
        return 'invalid_session_topology';
      }
    }
    return null;
  }
  if (subscriptionByMessagingGroup) return 'invalid_subscription_topology';
  const platformId = `mattermost:${row.instance_key}:${row.channel_id}`;
  if (!isPristineMattermostPlaceholder(row.messaging_group_id, platformId)) {
    return 'non_pristine_placeholder';
  }

  const digest = createHash('sha256').update(`${row.instance_key}\0${row.channel_id}`).digest('hex').slice(0, 24);
  const canonicalRoots = [
    path.join(GROUPS_DIR, `mattermost-${digest}`),
    path.join(DATA_DIR, 'v2-sessions', `ag-mattermost-${digest}`),
  ];
  return canonicalRoots.some((root) => fs.lstatSync(root, { throwIfNoEntry: false }) !== undefined)
    ? 'orphan_workspace_identity'
    : null;
}

function generateApprovalId(): string {
  return `mma-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function persistMattermostApprovalReplay(
  row: PendingMattermostChannelApproval,
  event: InboundEvent,
  addedBy: string,
  wakePersistedReplay = false,
): Promise<boolean> {
  return mattermostChannelSequencer.enqueue(
    event.platformId,
    async () => {
      const current = getPendingMattermostChannelApproval(row.approval_id);
      if (current?.status !== 'processing') return false;
      await persistMattermostApprovalReplayWithinChannel(current, event, addedBy, wakePersistedReplay);
      return true;
    },
    { headId: event.message.id as string },
  );
}

async function persistMattermostApprovalReplayWithinChannel(
  row: PendingMattermostChannelApproval,
  event: InboundEvent,
  addedBy: string,
  wakePersistedReplay = false,
): Promise<void> {
  const persistedPendingSession = wakePersistedReplay
    ? findPersistedPendingMattermostApprovalReplay(row, event)
    : undefined;
  const subscription = subscribeMattermostChannelStrict({
    instanceKey: row.instance_key,
    channelId: row.channel_id,
    recoveryBaseline: {
      postId: event.message.id as string,
      createAt: Date.parse(event.message.timestamp),
    },
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
    added_by: addedBy,
    added_at: new Date().toISOString(),
  });
  await routeInbound(event);
  if (persistedPendingSession) await wakeContainer(persistedPendingSession);
}

function findPersistedPendingMattermostApprovalReplay(
  row: PendingMattermostChannelApproval,
  event: InboundEvent,
): Session | undefined {
  if (!event.message.id) return undefined;
  const subscription = getDb()
    .prepare(
      `SELECT agent_group_id, messaging_group_id
         FROM mattermost_subscriptions
        WHERE instance_key = ? AND channel_id = ? AND status = 'active'`,
    )
    .get(row.instance_key, row.channel_id) as { agent_group_id: string; messaging_group_id: string } | undefined;
  if (!subscription || subscription.messaging_group_id !== row.messaging_group_id) return undefined;
  const session = findSessionForAgent(subscription.agent_group_id, subscription.messaging_group_id, null);
  if (!session) return undefined;

  const inbound = openInboundDb(session.agent_group_id, session.id);
  try {
    const persisted = inbound
      .prepare('SELECT status, trigger FROM messages_in WHERE id = ?')
      .get(`${event.message.id}:${session.agent_group_id}`) as { status: string; trigger: number } | undefined;
    return persisted?.status === 'pending' && persisted.trigger === 1 ? session : undefined;
  } finally {
    inbound.close();
  }
}

function quarantineMattermostApprovalRecovery(
  row: PendingMattermostChannelApproval,
  reason: MattermostApprovalRecoveryQuarantineReason,
): boolean {
  return quarantineProcessingMattermostChannelApproval(row.approval_id, reason, new Date().toISOString());
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
  if (row.status !== 'pending') return true;

  const storedEvent = parseStoredMattermostApprovalEvent(row);
  if (!storedEvent.valid) {
    log.error('Mattermost subscription approval contains an invalid stored event', { approvalId: row.approval_id });
    return true;
  }
  const event = storedEvent.event;

  await mattermostChannelSequencer.enqueue(
    event.platformId,
    async () => {
      const claimed = claimPendingMattermostChannelApproval(row.approval_id);
      if (!claimed) {
        const current = getPendingMattermostChannelApproval(row.approval_id);
        if (current?.status === 'processing') {
          throw new Error('Mattermost approval replay is already processing');
        }
        return;
      }
      try {
        await persistMattermostApprovalReplayWithinChannel(claimed, event, clickerId);
        if (!completeMattermostChannelApprovalReplay(row.approval_id, new Date().toISOString())) {
          throw new Error('Mattermost approval replay completion transition failed');
        }
      } catch (err) {
        releasePendingMattermostChannelApproval(row.approval_id);
        throw err;
      }
    },
    { headId: event.message.id as string },
  );
  return true;
}

export async function recoverProcessingMattermostChannelApprovals(instanceKey?: string): Promise<{
  completed: number;
  quarantined: number;
}> {
  let completed = 0;
  let quarantined = 0;
  for (const row of listProcessingMattermostChannelApprovals(instanceKey)) {
    const storedEvent = parseStoredMattermostApprovalEvent(row);
    if (!storedEvent.valid) {
      if (quarantineMattermostApprovalRecovery(row, storedEvent.reason)) quarantined += 1;
      continue;
    }
    const topologyCorruption = classifyMattermostApprovalTopologyCorruption(row);
    if (topologyCorruption) {
      if (quarantineMattermostApprovalRecovery(row, topologyCorruption)) quarantined += 1;
      continue;
    }
    try {
      const replayed = await persistMattermostApprovalReplay(row, storedEvent.event, row.approver_user_id, true);
      if (!replayed) continue;
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'Mattermost replay message identity collision') throw err;
      if (quarantineMattermostApprovalRecovery(row, 'message_identity_collision')) quarantined += 1;
      continue;
    }
    const transitioned = completeMattermostChannelApprovalReplay(row.approval_id, new Date().toISOString());
    if (!transitioned) throw new Error('Mattermost approval recovery completion transition failed');
    completed += 1;
  }
  return { completed, quarantined };
}

export async function recoverMattermostApprovalsForAuthenticatedMembership(
  instanceKey: string,
  currentChannelIds: ReadonlySet<string>,
): Promise<{
  cancelledPending: number;
  membershipQuarantined: number;
  completed: number;
  quarantined: number;
}> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(instanceKey)) {
    throw new Error('Invalid Mattermost approval membership instance');
  }
  for (const channelId of currentChannelIds) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channelId)) {
      throw new Error('Invalid Mattermost approval membership channel');
    }
  }

  let cancelledPending = 0;
  let membershipQuarantined = 0;
  for (const row of listUnfinishedMattermostChannelApprovals(instanceKey)) {
    if (currentChannelIds.has(row.channel_id)) continue;
    if (row.status === 'processing' && quarantineMattermostApprovalRecovery(row, 'bot_membership_absent')) {
      membershipQuarantined += 1;
    }
    const platformId = `mattermost:${row.instance_key}:${row.channel_id}`;
    await mattermostChannelSequencer.enqueue(platformId, () => handleMattermostBotRemoved(platformId), {
      terminal: true,
    });
    if (row.status === 'pending' && !getPendingMattermostChannelApproval(row.approval_id)) {
      cancelledPending += 1;
    }
  }
  const recovered = await recoverProcessingMattermostChannelApprovals(instanceKey);
  return { cancelledPending, membershipQuarantined, ...recovered };
}

export function hasMattermostApprovalMembershipWork(instanceKey: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(instanceKey)) return false;
  return listUnfinishedMattermostChannelApprovals(instanceKey).length > 0;
}

/**
 * Upgrade Phase-7 owner-approved subscriptions that predate durable recovery
 * cursors. The stored authenticated trigger supplies a content-free exact
 * baseline; manual/ambiguous subscriptions remain unbootstrapped and fail
 * closed in the recovery coordinator.
 */
export function bootstrapLegacyMattermostRecoveryCursors(instanceKey?: string): { seeded: number; rejected: number } {
  if (instanceKey !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(instanceKey)) {
    throw new Error('Invalid Mattermost legacy recovery instance');
  }
  const candidates = getDb()
    .prepare(
      `SELECT approval.*
         FROM pending_mattermost_channel_approvals approval
         JOIN mattermost_subscriptions subscription
           ON subscription.instance_key = approval.instance_key
          AND subscription.channel_id = approval.channel_id
          AND subscription.messaging_group_id = approval.messaging_group_id
          AND subscription.status = 'active'
         LEFT JOIN mattermost_recovery_cursors cursor
           ON cursor.instance_key = subscription.instance_key
          AND cursor.channel_id = subscription.channel_id
        WHERE approval.status = 'completed'
          AND cursor.instance_key IS NULL
          AND (? IS NULL OR approval.instance_key = ?)
        ORDER BY approval.created_at, approval.approval_id`,
    )
    .all(instanceKey ?? null, instanceKey ?? null) as PendingMattermostChannelApproval[];
  let seeded = 0;
  let rejected = 0;
  for (const row of candidates) {
    const storedEvent = parseStoredMattermostApprovalEvent(row);
    if (!storedEvent.valid) {
      rejected += 1;
      continue;
    }
    const createAt = Date.parse(storedEvent.event.message.timestamp);
    const postId = storedEvent.event.message.id;
    if (!postId || !Number.isSafeInteger(createAt) || createAt < 0) {
      rejected += 1;
      continue;
    }
    const result = getDb()
      .prepare(
        `INSERT OR IGNORE INTO mattermost_recovery_cursors (
           instance_key, channel_id, last_post_created_at, last_post_id, updated_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.instance_key, row.channel_id, createAt, postId, new Date().toISOString());
    if (result.changes === 1) seeded += 1;
  }
  return { seeded, rejected };
}
