import fs from 'node:fs';
import path from 'node:path';
import type { CosBinding } from '../../../cos-boundary.js';
import { installCosBoundary } from '../../../cos-boundary.js';
import { getDb } from '../../../db/connection.js';
import { acquireHostExecutionLease, releaseHostExecutionLease } from '../../../db/host-execution-lease.js';
import { getMessagingGroupByPlatform } from '../../../db/messaging-groups.js';
import { getSessionsByAgentGroup, getSession, updateSession } from '../../../db/sessions.js';
import {
  validateMattermostRoutingBoundary,
  validateMattermostSessionForExecution,
} from '../../../channels/mattermost-subscription.js';
import { resolveSession, sessionDir, initSessionFolder, openInboundDb } from '../../../session-manager.js';
import { ensureRpcSchema } from '../bridge/rpc.js';
import { validPrivateChannel, type ChannelFacts } from '../bridge/identity.js';
import { digest, type Result } from '../domain/contracts.js';

export type BindingRequest = Omit<CosBinding, 'agentGroupId' | 'messagingGroupId' | 'sessionId'>;
/** Trusted admin path, after target maintenance/drain and protected-state backup. Never an agent action. */
export async function bindCoordinator(
  request: BindingRequest,
  dependencies: { facts(binding: CosBinding): Promise<ChannelFacts>; bindScope(binding: CosBinding): Promise<Result> },
): Promise<CosBinding> {
  const db = getDb();
  if (
    !['codex', 'claude'].includes(request.provider) ||
    [request.scopeId, request.instanceId, request.channelId, request.ownerId, request.botId].some(
      (value) => !/^[a-zA-Z0-9_-]{1,128}$/.test(value),
    )
  )
    throw new Error('invalid_binding_request');
  const lease = acquireHostExecutionLease(db);
  let result: CosBinding | undefined;
  let failure: unknown;
  let released = false;
  try {
    const mg = getMessagingGroupByPlatform('mattermost', `mattermost:${request.instanceId}:${request.channelId}`);
    if (!mg) throw new Error('private_subscription_required');
    const native = validateMattermostRoutingBoundary(mg);
    if (!native.strict || !native.valid || native.value.agentGroup.agent_provider !== request.provider)
      throw new Error('private_subscription_required');
    const sessions = getSessionsByAgentGroup(native.value.agentGroup.id).filter(
      (session) => session.status === 'active',
    );
    if (sessions.length > 1 || sessions.some((session) => session.container_status !== 'stopped'))
      throw new Error('coordinator_not_quiescent');
    const session = sessions[0] ?? resolveSession(native.value.agentGroup.id, mg.id, null, 'shared').session;
    const valid = validateMattermostSessionForExecution(session);
    if (!valid.strict || !valid.valid) throw new Error('private_session_required');
    const binding: CosBinding = {
      ...request,
      agentGroupId: session.agent_group_id,
      messagingGroupId: mg.id,
      sessionId: session.id,
    };
    if (!validPrivateChannel(binding, await dependencies.facts(binding)))
      throw new Error('private_owner_membership_required');
    const rows = db
      .prepare(
        'SELECT binding FROM cos_identity_boundaries WHERE scope_id=? OR agent_group_id=? OR messaging_group_id=? OR session_id=?',
      )
      .all(binding.scopeId, binding.agentGroupId, binding.messagingGroupId, binding.sessionId) as Array<{
      binding: string;
    }>;
    if (rows.length && (rows.length !== 1 || digest(JSON.parse(rows[0].binding)) !== digest(binding)))
      throw new Error('binding_identity_conflict');
    const freshPath = rows.length
      ? sessionDir(session.agent_group_id, session.id)
      : path.join(sessionDir(session.agent_group_id, session.id), 'cos-v1');
    if (!rows.length && fs.lstatSync(freshPath, { throwIfNoEntry: false })) throw new Error('unowned_cos_state_exists');
    db.transaction(() => {
      updateSession(session.id, { agent_provider: request.provider });
      if (!rows.length) installCosBoundary(binding, db);
      db.prepare('UPDATE cos_identity_boundaries SET paused=1 WHERE scope_id=?').run(binding.scopeId);
    })();
    if (!rows.length) fs.mkdirSync(freshPath, { mode: 0o700 });
    const stat = fs.lstatSync(freshPath);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      fs.realpathSync(freshPath) !== path.resolve(freshPath)
    )
      throw new Error('unsafe_cos_state');
    initSessionFolder(binding.agentGroupId, binding.sessionId);
    const inbound = openInboundDb(binding.agentGroupId, binding.sessionId);
    try {
      ensureRpcSchema(inbound);
    } finally {
      inbound.close();
    }
    if ((await dependencies.bindScope(binding)).status !== 'ok') throw new Error('scope_binding_not_confirmed');
    const refreshed = getSession(session.id);
    if (!refreshed || refreshed.agent_provider !== request.provider) throw new Error('binding_identity_changed');
    result = binding;
  } catch (error) {
    failure = error;
  } finally {
    released = releaseHostExecutionLease(db, lease);
  }
  if (!released) throw new Error('setup_lease_release_failed', { cause: failure });
  if (failure) throw failure;
  if (!result) throw new Error('binding_not_confirmed');
  return result;
}
