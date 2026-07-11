import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { updateContainerConfig } from '../container-config.js';
import { createAgentGroup, getAgentGroup } from '../db/agent-groups.js';
import { getDb } from '../db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroup,
  getMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  setMessagingGroupDeniedAt,
  updateMessagingGroup,
} from '../db/messaging-groups.js';
import { initGroupFilesystem } from '../group-init.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent, Session } from '../types.js';

const SAFE_IDENTITY_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MATTERMOST_DEFAULT_AGENT_PROVIDER = 'codex';

function isValidSubscriptionIdentityComponent(component: string): boolean {
  return SAFE_IDENTITY_COMPONENT.test(component) && component.length <= 128;
}

function claimMattermostWorkspaceDirectory(directory: string): void {
  try {
    fs.mkdirSync(directory);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Mattermost workspace identity already exists', { cause: err });
    }
    throw err;
  }
}

export interface MattermostSubscriptionInput {
  instanceKey: string;
  channelId: string;
  channelName?: string;
  /** Authenticated post that authorized this activation; never includes content. */
  recoveryBaseline?: {
    postId: string;
    createAt: number;
  };
}

export interface MattermostSubscriptionResult {
  messagingGroup: MessagingGroup;
  agentGroup: AgentGroup;
  wiring: MessagingGroupAgent;
}

export type MattermostWorkspacePolicy = 'retain' | 'archive';

export interface MattermostDeactivationInput {
  instanceKey: string;
  channelId: string;
  workspacePolicy: MattermostWorkspacePolicy;
}

export interface MattermostDeactivationResult {
  status: 'unsubscribed' | 'archived';
  closedSessionIds: string[];
}

interface MattermostSubscriptionRow {
  instance_key: string;
  channel_id: string;
  messaging_group_id: string;
  agent_group_id: string;
  wiring_id: string;
  status: 'pending' | 'active' | 'unsubscribed' | 'archived';
  created_at: string;
  archived_at: string | null;
}

export type MattermostSubscriptionInvalidReason =
  | 'missing_subscription'
  | 'inactive_subscription'
  | 'identity_mismatch'
  | 'unsafe_messaging_group_policy'
  | 'non_canonical_agent_identity'
  | 'missing_agent'
  | 'missing_wiring'
  | 'non_shared_session'
  | 'unsafe_wiring_policy'
  | 'non_exclusive_messaging_group'
  | 'reused_agent_group'
  | 'unsafe_destination_topology'
  | 'cross_channel_agent_reuse'
  | 'unsafe_subscription_identity';

export type MattermostSubscriptionValidation =
  | { valid: true; value: MattermostSubscriptionResult }
  | { valid: false; reason: MattermostSubscriptionInvalidReason };

export type MattermostRoutingBoundary = { strict: false } | ({ strict: true } & MattermostSubscriptionValidation);

export type MattermostSessionExecutionBoundary =
  | { strict: false }
  | ({ strict: true } & (
      | { valid: true; value: MattermostSubscriptionResult }
      | {
          valid: false;
          reason:
            | MattermostSubscriptionInvalidReason
            | 'session_identity_mismatch'
            | 'session_record_mismatch'
            | 'unsafe_session_identity'
            | 'unsafe_session_path'
            | 'duplicate_active_session'
            | 'threaded_session'
            | 'inactive_session';
        }
    ));

export function subscribeMattermostChannelStrict(input: MattermostSubscriptionInput): MattermostSubscriptionResult {
  if (
    !isValidSubscriptionIdentityComponent(input.instanceKey) ||
    !isValidSubscriptionIdentityComponent(input.channelId) ||
    (input.recoveryBaseline !== undefined &&
      (!isValidSubscriptionIdentityComponent(input.recoveryBaseline.postId) ||
        !Number.isSafeInteger(input.recoveryBaseline.createAt) ||
        input.recoveryBaseline.createAt < 0))
  ) {
    throw new Error('Invalid Mattermost subscription identity');
  }
  const digest = subscriptionDigest(input.instanceKey, input.channelId);
  let messagingGroup: MessagingGroup = {
    id: `mg-mattermost-${digest}`,
    channel_type: 'mattermost',
    platform_id: `mattermost:${input.instanceKey}:${input.channelId}`,
    name: input.channelName ?? null,
    is_group: 1,
    unknown_sender_policy: 'strict',
    denied_at: null,
    created_at: new Date().toISOString(),
  };
  const agentGroup: AgentGroup = {
    id: `ag-mattermost-${digest}`,
    name: input.channelName ?? `Mattermost ${input.channelId}`,
    folder: `mattermost-${digest}`,
    agent_provider: MATTERMOST_DEFAULT_AGENT_PROVIDER,
    created_at: messagingGroup.created_at,
  };
  let wiring: MessagingGroupAgent = {
    id: `mga-mattermost-${digest}`,
    messaging_group_id: messagingGroup.id,
    agent_group_id: agentGroup.id,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'known',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: messagingGroup.created_at,
  };
  const groupPath = resolveGroupFolderPath(agentGroup.folder);
  const statePath = path.join(DATA_DIR, 'v2-sessions', agentGroup.id);
  let groupPathOwned = false;
  let statePathOwned = false;

  let result: MattermostSubscriptionResult | undefined;
  try {
    getDb()
      .transaction(() => {
        const existing = getDb()
          .prepare('SELECT * FROM mattermost_subscriptions WHERE instance_key = ? AND channel_id = ?')
          .get(input.instanceKey, input.channelId) as MattermostSubscriptionRow | undefined;
        if (existing) {
          const validation = validateMattermostSubscriptionRow(existing);
          if (!validation.valid) {
            throw new Error(`Invalid Mattermost subscription topology: ${validation.reason}`);
          }
          seedMattermostRecoveryBaseline(input);
          result = validation.value;
          return;
        }

        if (fs.existsSync(groupPath) || fs.existsSync(statePath)) {
          throw new Error('Mattermost workspace identity already exists');
        }

        const observed = getMessagingGroupByPlatform('mattermost', messagingGroup.platform_id);
        if (observed) {
          const existingSessions = getDb()
            .prepare('SELECT COUNT(*) AS count FROM sessions WHERE messaging_group_id = ?')
            .get(observed.id) as { count: number };
          const destinationReferences = getDb()
            .prepare(
              `SELECT COUNT(*) AS count
                 FROM agent_destinations
                WHERE target_type = 'channel' AND target_id = ?`,
            )
            .get(observed.id) as { count: number };
          if (
            getMessagingGroupAgents(observed.id).length !== 0 ||
            existingSessions.count !== 0 ||
            destinationReferences.count !== 0
          ) {
            throw new Error('Invalid pre-existing Mattermost channel mapping');
          }
          updateMessagingGroup(observed.id, {
            name: input.channelName ?? observed.name,
            is_group: 1,
            unknown_sender_policy: 'strict',
          });
          setMessagingGroupDeniedAt(observed.id, null);
          messagingGroup = {
            ...observed,
            name: input.channelName ?? observed.name,
            is_group: 1,
            unknown_sender_policy: 'strict',
            denied_at: null,
          };
          wiring = { ...wiring, messaging_group_id: observed.id };
        } else {
          createMessagingGroup(messagingGroup);
        }
        createAgentGroup(agentGroup);
        createMessagingGroupAgent(wiring);
        getDb()
          .prepare(
            `INSERT INTO mattermost_subscriptions (
           instance_key, channel_id, messaging_group_id, agent_group_id,
           wiring_id, status, created_at, archived_at
         ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL)`,
          )
          .run(
            input.instanceKey,
            input.channelId,
            messagingGroup.id,
            agentGroup.id,
            wiring.id,
            messagingGroup.created_at,
          );
        seedMattermostRecoveryBaseline(input);
        result = { messagingGroup, agentGroup, wiring };

        // Atomically claim the two channel-owned roots. Observation alone is
        // racy: another process can create either directory before this
        // transaction begins initialization. Cleanup below is limited to
        // directories this invocation successfully created.
        fs.mkdirSync(path.dirname(groupPath), { recursive: true });
        claimMattermostWorkspaceDirectory(groupPath);
        groupPathOwned = true;
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        claimMattermostWorkspaceDirectory(statePath);
        statePathOwned = true;
        initGroupFilesystem(agentGroup);
        updateContainerConfig(agentGroup.folder, (config) => {
          config.provider = MATTERMOST_DEFAULT_AGENT_PROVIDER;
        });
      })
      .immediate();
  } catch (err) {
    if (groupPathOwned) fs.rmSync(groupPath, { force: true, recursive: true });
    if (statePathOwned) fs.rmSync(statePath, { force: true, recursive: true });
    throw err;
  }

  if (!result) throw new Error('Mattermost subscription transaction produced no result');
  return result;
}

function seedMattermostRecoveryBaseline(input: MattermostSubscriptionInput): void {
  const baseline = input.recoveryBaseline;
  if (!baseline) return;
  getDb()
    .prepare(
      `INSERT INTO mattermost_recovery_cursors (
         instance_key, channel_id, last_post_created_at, last_post_id, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(instance_key, channel_id) DO UPDATE SET
         last_post_created_at = excluded.last_post_created_at,
         last_post_id = excluded.last_post_id,
         updated_at = excluded.updated_at
       WHERE excluded.last_post_created_at > mattermost_recovery_cursors.last_post_created_at
          OR (
            excluded.last_post_created_at = mattermost_recovery_cursors.last_post_created_at
            AND excluded.last_post_id > COALESCE(mattermost_recovery_cursors.last_post_id, '')
          )`,
    )
    .run(input.instanceKey, input.channelId, baseline.createAt, baseline.postId, new Date().toISOString());
}

export async function deactivateMattermostChannelStrict(
  input: MattermostDeactivationInput,
): Promise<MattermostDeactivationResult> {
  if (
    !isValidSubscriptionIdentityComponent(input.instanceKey) ||
    !isValidSubscriptionIdentityComponent(input.channelId) ||
    (input.workspacePolicy !== 'retain' && input.workspacePolicy !== 'archive')
  ) {
    throw new Error('Invalid Mattermost deactivation request');
  }
  const runnerPromise = import('../container-runner.js');

  const transition = getDb()
    .transaction(() => {
      const row = getDb()
        .prepare('SELECT * FROM mattermost_subscriptions WHERE instance_key = ? AND channel_id = ?')
        .get(input.instanceKey, input.channelId) as MattermostSubscriptionRow | undefined;
      if (!row) throw new Error('Mattermost subscription not found');
      if (row.status === 'archived') throw new Error('Archived Mattermost subscription is terminal');

      const sessions = getDb()
        .prepare(
          `SELECT id, container_status
             FROM sessions
            WHERE agent_group_id = ? OR messaging_group_id = ?`,
        )
        .all(row.agent_group_id, row.messaging_group_id) as Array<{
        id: string;
        container_status: Session['container_status'];
      }>;

      if (row.status !== 'active' && row.status !== 'unsubscribed') {
        throw new Error(`Mattermost subscription cannot be deactivated from ${row.status}`);
      }

      getDb()
        .prepare(
          `UPDATE sessions
              SET status = 'closed', container_status = 'stopped'
            WHERE agent_group_id = ? OR messaging_group_id = ?`,
        )
        .run(row.agent_group_id, row.messaging_group_id);

      if (row.status === 'active') {
        getDb()
          .prepare(
            `UPDATE mattermost_subscriptions
                SET status = 'unsubscribed', archived_at = NULL
              WHERE instance_key = ? AND channel_id = ? AND status = 'active'`,
          )
          .run(input.instanceKey, input.channelId);
      }

      let finalStatus: MattermostDeactivationResult['status'] = 'unsubscribed';
      if (input.workspacePolicy === 'archive') {
        getDb()
          .prepare(
            `UPDATE mattermost_subscriptions
                SET status = 'archived', archived_at = ?
              WHERE instance_key = ? AND channel_id = ? AND status = 'unsubscribed'`,
          )
          .run(new Date().toISOString(), input.instanceKey, input.channelId);
        finalStatus = 'archived';
      }

      return {
        status: finalStatus,
        closedSessionIds: sessions.map((session) => session.id),
        runningSessionIds: sessions
          .filter((session) => session.container_status === 'running' || session.container_status === 'idle')
          .map((session) => session.id),
      };
    })
    .immediate();

  const { killContainer } = await runnerPromise;
  for (const sessionId of transition.runningSessionIds) {
    killContainer(sessionId, 'Mattermost channel unsubscribed');
  }
  return { status: transition.status, closedSessionIds: transition.closedSessionIds };
}

export function resubscribeMattermostChannelStrict(input: {
  instanceKey: string;
  channelId: string;
}): MattermostSubscriptionResult {
  if (
    !isValidSubscriptionIdentityComponent(input.instanceKey) ||
    !isValidSubscriptionIdentityComponent(input.channelId)
  ) {
    throw new Error('Invalid Mattermost resubscription identity');
  }

  return getDb()
    .transaction(() => {
      const row = getDb()
        .prepare('SELECT * FROM mattermost_subscriptions WHERE instance_key = ? AND channel_id = ?')
        .get(input.instanceKey, input.channelId) as MattermostSubscriptionRow | undefined;
      if (!row) throw new Error('Mattermost subscription not found');
      if (row.status !== 'unsubscribed' || row.archived_at !== null) {
        throw new Error('Only a retained Mattermost subscription can be reactivated');
      }

      const ownedSessions = getDb()
        .prepare(
          `SELECT id, agent_group_id, messaging_group_id, thread_id, status, container_status
             FROM sessions
            WHERE agent_group_id = ? OR messaging_group_id = ?`,
        )
        .all(row.agent_group_id, row.messaging_group_id) as Session[];
      if (ownedSessions.length > 1) {
        throw new Error('Mattermost resubscription found ambiguous session ownership');
      }
      const ownedSession = ownedSessions[0];
      if (
        ownedSession &&
        (ownedSession.agent_group_id !== row.agent_group_id ||
          ownedSession.messaging_group_id !== row.messaging_group_id ||
          ownedSession.thread_id !== null ||
          ownedSession.status !== 'closed' ||
          ownedSession.container_status !== 'stopped')
      ) {
        throw new Error('Mattermost resubscription found an unsafe owned session');
      }

      const validation = validateMattermostSubscriptionRow({ ...row, status: 'active' });
      if (!validation.valid) {
        throw new Error(`Invalid Mattermost subscription topology: ${validation.reason}`);
      }
      const workspacePath = resolveGroupFolderPath(validation.value.agentGroup.folder);
      const stateRoot = path.join(DATA_DIR, 'v2-sessions');
      const statePath = path.join(stateRoot, validation.value.agentGroup.id);
      if (!isSafeOwnedDirectory(GROUPS_DIR, workspacePath) || !isSafeOwnedDirectory(stateRoot, statePath)) {
        throw new Error('Unsafe Mattermost workspace identity');
      }

      getDb()
        .prepare(
          `UPDATE mattermost_subscriptions
              SET status = 'active', archived_at = NULL
            WHERE instance_key = ? AND channel_id = ? AND status = 'unsubscribed'`,
        )
        .run(input.instanceKey, input.channelId);
      if (ownedSession) {
        getDb()
          .prepare("UPDATE sessions SET status = 'active', container_status = 'stopped' WHERE id = ?")
          .run(ownedSession.id);
      }
      return validation.value;
    })
    .immediate();
}

export async function handleMattermostBotRemoved(platformId: string): Promise<void> {
  const match = /^mattermost:([^:]+):([^:]+)$/.exec(platformId);
  if (!match || !isValidSubscriptionIdentityComponent(match[1]) || !isValidSubscriptionIdentityComponent(match[2])) {
    return;
  }
  const [, instanceKey, channelId] = match;
  getDb()
    .transaction(() => {
      getDb()
        .prepare(
          `DELETE FROM pending_mattermost_channel_approvals
            WHERE instance_key = ? AND channel_id = ?
              AND status IN ('pending', 'processing')
              AND (
                status = 'pending'
                OR NOT EXISTS (
                  SELECT 1
                    FROM mattermost_approval_recovery_quarantine quarantine
                   WHERE quarantine.approval_id = pending_mattermost_channel_approvals.approval_id
                )
              )`,
        )
        .run(instanceKey, channelId);
      getDb()
        .prepare(
          `UPDATE messaging_groups
              SET denied_at = COALESCE(denied_at, ?)
            WHERE channel_type = 'mattermost'
              AND platform_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM mattermost_subscriptions ms
                 WHERE ms.messaging_group_id = messaging_groups.id
              )`,
        )
        .run(new Date().toISOString(), platformId);
    })
    .immediate();

  const row = getDb()
    .prepare('SELECT status FROM mattermost_subscriptions WHERE instance_key = ? AND channel_id = ?')
    .get(instanceKey, channelId) as { status: MattermostSubscriptionRow['status'] } | undefined;
  if (row?.status === 'active') {
    await deactivateMattermostChannelStrict({ instanceKey, channelId, workspacePolicy: 'retain' });
  }
}

function validateMattermostSubscriptionRow(row: MattermostSubscriptionRow): MattermostSubscriptionValidation {
  if (row.status !== 'active') return { valid: false, reason: 'inactive_subscription' };
  if (
    !isValidSubscriptionIdentityComponent(row.instance_key) ||
    !isValidSubscriptionIdentityComponent(row.channel_id)
  ) {
    return { valid: false, reason: 'unsafe_subscription_identity' };
  }

  const messagingGroup = getMessagingGroup(row.messaging_group_id);
  if (
    !messagingGroup ||
    messagingGroup.channel_type !== 'mattermost' ||
    messagingGroup.platform_id !== `mattermost:${row.instance_key}:${row.channel_id}`
  ) {
    return { valid: false, reason: 'identity_mismatch' };
  }
  if (
    messagingGroup.is_group !== 1 ||
    messagingGroup.unknown_sender_policy !== 'strict' ||
    messagingGroup.denied_at !== null
  ) {
    return { valid: false, reason: 'unsafe_messaging_group_policy' };
  }

  const agentGroup = getAgentGroup(row.agent_group_id);
  if (!agentGroup) return { valid: false, reason: 'missing_agent' };
  const digest = subscriptionDigest(row.instance_key, row.channel_id);
  if (agentGroup.id !== `ag-mattermost-${digest}` || agentGroup.folder !== `mattermost-${digest}`) {
    return { valid: false, reason: 'non_canonical_agent_identity' };
  }

  const wiring = getMessagingGroupAgent(row.wiring_id);
  if (!wiring || wiring.messaging_group_id !== row.messaging_group_id || wiring.agent_group_id !== row.agent_group_id) {
    return { valid: false, reason: 'missing_wiring' };
  }
  if (wiring.session_mode !== 'shared') return { valid: false, reason: 'non_shared_session' };
  if (
    wiring.engage_mode !== 'pattern' ||
    wiring.engage_pattern !== '.' ||
    wiring.sender_scope !== 'known' ||
    wiring.ignored_message_policy !== 'drop'
  ) {
    return { valid: false, reason: 'unsafe_wiring_policy' };
  }
  if (getMessagingGroupAgents(row.messaging_group_id).length !== 1) {
    return { valid: false, reason: 'non_exclusive_messaging_group' };
  }
  const reverseCount = (
    getDb()
      .prepare('SELECT COUNT(*) AS count FROM messaging_group_agents WHERE agent_group_id = ?')
      .get(row.agent_group_id) as {
      count: number;
    }
  ).count;
  if (reverseCount !== 1) return { valid: false, reason: 'reused_agent_group' };

  const destinations = getDb()
    .prepare('SELECT target_type, target_id FROM agent_destinations WHERE agent_group_id = ?')
    .all(row.agent_group_id) as Array<{ target_type: string; target_id: string }>;
  if (
    destinations.length !== 1 ||
    destinations[0].target_type !== 'channel' ||
    destinations[0].target_id !== row.messaging_group_id
  ) {
    return { valid: false, reason: 'unsafe_destination_topology' };
  }
  const incomingAgentDestinations = (
    getDb()
      .prepare("SELECT COUNT(*) AS count FROM agent_destinations WHERE target_type = 'agent' AND target_id = ?")
      .get(row.agent_group_id) as { count: number }
  ).count;
  if (incomingAgentDestinations !== 0) {
    return { valid: false, reason: 'unsafe_destination_topology' };
  }

  return { valid: true, value: { messagingGroup, agentGroup, wiring } };
}

function subscriptionDigest(instanceKey: string, channelId: string): string {
  return createHash('sha256').update(`${instanceKey}\0${channelId}`).digest('hex').slice(0, 24);
}

function isExpectedFilesystemBoundaryError(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof err.code === 'string' &&
    ['EACCES', 'EINVAL', 'ELOOP', 'ENOENT', 'ENOTDIR', 'EPERM'].includes(err.code)
  );
}

function isSafeOwnedDirectory(root: string, candidate: string): boolean {
  try {
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = path.resolve(candidate);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return false;
    }

    let cursor = resolvedRoot;
    for (const component of relative.split(path.sep)) {
      cursor = path.join(cursor, component);
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) return false;
    }

    const canonicalRoot = fs.realpathSync(resolvedRoot);
    const canonicalCandidate = fs.realpathSync(resolvedCandidate);
    const canonicalRelative = path.relative(canonicalRoot, canonicalCandidate);
    return (
      fs.statSync(canonicalCandidate).isDirectory() &&
      canonicalRelative !== '..' &&
      !canonicalRelative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(canonicalRelative)
    );
  } catch (err) {
    if (isExpectedFilesystemBoundaryError(err)) return false;
    throw err;
  }
}

export function validateMattermostSubscriptionForRouting(
  messagingGroup: MessagingGroup,
): MattermostSubscriptionValidation {
  const row = getDb()
    .prepare('SELECT * FROM mattermost_subscriptions WHERE messaging_group_id = ?')
    .get(messagingGroup.id) as MattermostSubscriptionRow | undefined;
  if (!row) return { valid: false, reason: 'missing_subscription' };
  return validateMattermostSubscriptionRow(row);
}

export function validateMattermostRoutingBoundary(messagingGroup: MessagingGroup): MattermostRoutingBoundary {
  const direct = getDb()
    .prepare('SELECT * FROM mattermost_subscriptions WHERE messaging_group_id = ?')
    .get(messagingGroup.id) as MattermostSubscriptionRow | undefined;
  if (direct) return { strict: true, ...validateMattermostSubscriptionRow(direct) };

  const reusedMattermostAgent = getDb()
    .prepare(
      `SELECT 1
         FROM messaging_group_agents current_wiring
        WHERE current_wiring.messaging_group_id = ?
          AND (
            EXISTS (
              SELECT 1 FROM mattermost_subscriptions ms
               WHERE ms.agent_group_id = current_wiring.agent_group_id
            )
            OR EXISTS (
              SELECT 1
                FROM messaging_group_agents other_wiring
                JOIN messaging_groups other_group ON other_group.id = other_wiring.messaging_group_id
               WHERE other_wiring.agent_group_id = current_wiring.agent_group_id
                 AND other_wiring.messaging_group_id <> current_wiring.messaging_group_id
                 AND other_group.channel_type = 'mattermost'
            )
          )
        LIMIT 1`,
    )
    .get(messagingGroup.id);
  if (reusedMattermostAgent) {
    return { strict: true, valid: false, reason: 'cross_channel_agent_reuse' };
  }
  if (messagingGroup.channel_type === 'mattermost') {
    return { strict: true, valid: false, reason: 'missing_subscription' };
  }
  return { strict: false };
}

export function validateMattermostSessionForExecution(session: Session): MattermostSessionExecutionBoundary {
  const byAgent = getDb()
    .prepare('SELECT * FROM mattermost_subscriptions WHERE agent_group_id = ?')
    .get(session.agent_group_id) as MattermostSubscriptionRow | undefined;
  const byMessagingGroup = session.messaging_group_id
    ? (getDb()
        .prepare('SELECT * FROM mattermost_subscriptions WHERE messaging_group_id = ?')
        .get(session.messaging_group_id) as MattermostSubscriptionRow | undefined)
    : undefined;

  if (!byAgent && !byMessagingGroup) {
    const referencedMessagingGroup = session.messaging_group_id
      ? getMessagingGroup(session.messaging_group_id)
      : undefined;
    if (
      referencedMessagingGroup?.channel_type === 'mattermost' ||
      isMattermostOwnedAgentGroup(session.agent_group_id)
    ) {
      return { strict: true, valid: false, reason: 'missing_subscription' };
    }
    return { strict: false };
  }
  if (
    !byAgent ||
    !byMessagingGroup ||
    byAgent.instance_key !== byMessagingGroup.instance_key ||
    byAgent.channel_id !== byMessagingGroup.channel_id ||
    session.agent_group_id !== byAgent.agent_group_id ||
    session.messaging_group_id !== byAgent.messaging_group_id
  ) {
    return { strict: true, valid: false, reason: 'session_identity_mismatch' };
  }
  if (!isValidSubscriptionIdentityComponent(session.id)) {
    return { strict: true, valid: false, reason: 'unsafe_session_identity' };
  }
  if (session.thread_id !== null) return { strict: true, valid: false, reason: 'threaded_session' };
  if (session.status !== 'active') return { strict: true, valid: false, reason: 'inactive_session' };
  const storedSession = getDb()
    .prepare('SELECT agent_group_id, messaging_group_id, thread_id, agent_provider, status FROM sessions WHERE id = ?')
    .get(session.id) as
    | Pick<Session, 'agent_group_id' | 'messaging_group_id' | 'thread_id' | 'agent_provider' | 'status'>
    | undefined;
  if (
    !storedSession ||
    storedSession.agent_group_id !== session.agent_group_id ||
    storedSession.messaging_group_id !== session.messaging_group_id ||
    storedSession.thread_id !== session.thread_id ||
    storedSession.agent_provider !== session.agent_provider ||
    storedSession.status !== session.status
  ) {
    return { strict: true, valid: false, reason: 'session_record_mismatch' };
  }
  const activeBoundarySessions = getDb()
    .prepare(
      `SELECT COUNT(*) AS count
         FROM (
           SELECT id FROM sessions WHERE status = 'active' AND agent_group_id = ?
           UNION
           SELECT id FROM sessions WHERE status = 'active' AND messaging_group_id = ?
         )`,
    )
    .get(session.agent_group_id, session.messaging_group_id) as { count: number };
  if (activeBoundarySessions.count !== 1) {
    return { strict: true, valid: false, reason: 'duplicate_active_session' };
  }

  const subscription = validateMattermostSubscriptionRow(byAgent);
  if (!subscription.valid) return { strict: true, ...subscription };
  const groupDir = resolveGroupFolderPath(subscription.value.agentGroup.folder);
  const sessionStateRoot = path.join(DATA_DIR, 'v2-sessions');
  const agentStateDir = path.join(sessionStateRoot, session.agent_group_id);
  const ownedSessionDir = path.join(agentStateDir, session.id);
  if (
    !isSafeOwnedDirectory(GROUPS_DIR, groupDir) ||
    !isSafeOwnedDirectory(sessionStateRoot, agentStateDir) ||
    !isSafeOwnedDirectory(agentStateDir, ownedSessionDir)
  ) {
    return { strict: true, valid: false, reason: 'unsafe_session_path' };
  }
  return { strict: true, ...subscription };
}

export function isMattermostOwnedAgentGroup(agentGroupId: string): boolean {
  return Boolean(
    getDb()
      .prepare(
        `SELECT 1 FROM mattermost_subscriptions WHERE agent_group_id = ?
         UNION ALL
         SELECT 1
           FROM messaging_group_agents mga
           JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
          WHERE mga.agent_group_id = ? AND mg.channel_type = 'mattermost'
          LIMIT 1`,
      )
      .get(agentGroupId, agentGroupId),
  );
}

export interface MattermostOwnedFilesystemIdentity {
  agentGroupId: string;
  folder: string;
}

export function listMattermostOwnedFilesystemIdentities(): MattermostOwnedFilesystemIdentity[] {
  return getDb()
    .prepare(
      `SELECT ag.id AS agentGroupId, ag.folder
         FROM agent_groups ag
         JOIN mattermost_subscriptions ms ON ms.agent_group_id = ag.id
       UNION
       SELECT ag.id AS agentGroupId, ag.folder
         FROM agent_groups ag
         JOIN messaging_group_agents mga ON mga.agent_group_id = ag.id
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
        WHERE mg.channel_type = 'mattermost'`,
    )
    .all() as MattermostOwnedFilesystemIdentity[];
}

export function excludeMattermostOwnedAgentGroups(agentGroups: AgentGroup[]): AgentGroup[] {
  return agentGroups.filter((agentGroup) => !isMattermostOwnedAgentGroup(agentGroup.id));
}
