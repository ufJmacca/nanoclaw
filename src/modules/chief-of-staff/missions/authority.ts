import path from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb, hasTable } from '../../../db/connection.js';
import { getSession } from '../../../db/sessions.js';
import { cosBoundary } from '../../../cos-boundary.js';
import { validateMattermostSessionForExecution } from '../../../channels/mattermost-subscription.js';
import { currentRelease, releaseMode } from '../../../release-runtime.js';
import { subscriptionCoordinator } from '../../../providers/codex-subscription-coordinator.js';
import { digest } from '../domain/contracts.js';
import { subscriptionActivation } from '../bridge/model-policy.js';
import { policyAllowsBriefContext } from '../bridge/brief-context-renewal.js';
import {
  contextGenerationPattern,
  privateConversationDirectory,
  readConversationOwner,
} from '../ops/conversation-ownership.js';
import { readPrivate } from '../ops/target-state.js';
import { readDelegation } from './delegation.js';
import { RESEARCH_TEMPLATE } from './work-order.js';
import type { MissionAuthorityResolver } from './proposal-store.js';

/** Read-only local authority. Callers must separately verify current remote private membership,
 * source access and (for new requests) owner ingress. Historical ingress never renews model consent.
 */
export function createMissionAuthorityResolver(options: {
  targetRoot: string;
  db: Database.Database;
  admitted(): boolean;
  assertHostAuthority(): void;
}): MissionAuthorityResolver {
  return (context) => {
    try {
      options.assertHostAuthority();
      if (!options.admitted() || options.db !== getDb() || context.origin || !releaseMode() || !currentRelease())
        return null;
      const session = getSession(context.sessionId);
      if (!session || session.agent_group_id !== context.agentGroupId) return null;
      const boundary = cosBoundary(session, options.db),
        native = validateMattermostSessionForExecution(session);
      if (!boundary.restricted || boundary.paused || !boundary.binding || !native.strict || !native.valid) return null;
      const binding = boundary.binding;
      if (
        binding.scopeId !== context.scopeId ||
        binding.ownerId !== context.ownerId ||
        binding.provider !== 'codex' ||
        native.value.agentGroup.id !== binding.agentGroupId ||
        native.value.messagingGroup.id !== binding.messagingGroupId ||
        native.value.messagingGroup.platform_id !== `mattermost:${binding.instanceId}:${binding.channelId}`
      )
        return null;
      const delegation = readDelegation(options.targetRoot, binding);
      if (!delegation?.enabled) return null;
      const owner = subscriptionCoordinator();
      if (!owner) return null;
      const account = JSON.parse(owner.cached().authJson)?.tokens?.account_id;
      if (typeof account !== 'string' || !account || account.length > 65536) return null;
      const accountFingerprint = createHash('sha256').update(account).digest('hex');
      const row = options.db
        .prepare(
          'SELECT binding_digest,account_fingerprint,generation,status FROM cos_conversation_states WHERE scope_id=?',
        )
        .get(binding.scopeId) as
        | { binding_digest: string; account_fingerprint: string; generation: string; status: string }
        | undefined;
      if (
        !row ||
        row.status !== 'active' ||
        row.binding_digest !== digest(binding) ||
        row.account_fingerprint !== accountFingerprint ||
        !contextGenerationPattern.test(row.generation)
      )
        return null;
      // An interrupted renewal must be reconciled by the coordinator before missions can use either context.
      if (
        hasTable(options.db, 'cos_brief_context_renewals') &&
        options.db
          .prepare("SELECT 1 FROM cos_brief_context_renewals WHERE scope_id=? AND status='preparing'")
          .get(binding.scopeId)
      )
        return null;
      privateConversationDirectory(path.join(options.targetRoot, 'conversations'));
      privateConversationDirectory(path.join(options.targetRoot, 'conversations', row.generation));
      const retained = readConversationOwner(options.targetRoot, row.generation, binding);
      if (retained.state !== 'retained' || retained.accountFingerprint !== accountFingerprint) return null;
      const policy = subscriptionActivation(
        readPrivate(path.join(options.targetRoot, 'model-activation.json')),
        binding.scopeId,
        accountFingerprint,
      );
      if (!policy || !policyAllowsBriefContext(options.db, binding, policy, row.generation)) return null;
      // Reservation remains at the invocation boundary: the last admitted turn must retain read access
      // after it consumes the final allowance. This resolver never reserves or replenishes usage.
      options.assertHostAuthority();
      if (!options.admitted() || subscriptionCoordinator() !== owner) return null;
      return {
        bindingDigest: digest(binding),
        delegationDigest: digest(delegation),
        contextGeneration: row.generation,
        provider: { profile: RESEARCH_TEMPLATE.providerProfile, model: policy.model, policyDigest: digest(policy) },
      };
    } catch {
      // Missing/corrupt native, private or credential state denies authority without repair or secret output.
      return null;
    }
  };
}
