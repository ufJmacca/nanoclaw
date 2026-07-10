import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
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
}

export interface MattermostSubscriptionResult {
  messagingGroup: MessagingGroup;
  agentGroup: AgentGroup;
  wiring: MessagingGroupAgent;
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
    !isValidSubscriptionIdentityComponent(input.channelId)
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
    agent_provider: null,
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
