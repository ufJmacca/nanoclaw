import type Database from 'better-sqlite3';
import { getDb, hasTable } from '../../../db/connection.js';
import { getSession } from '../../../db/sessions.js';
import { cosBoundary, type CosBinding } from '../../../cos-boundary.js';
import { validateMattermostSessionForExecution } from '../../../channels/mattermost-subscription.js';
import { currentRelease, releaseMode } from '../../../release-runtime.js';
import { digest, type Context } from '../domain/contracts.js';
type MailContext = Context & { provider: string };
export type MailAuthorities = { poll(context: MailContext): boolean; retention(context: MailContext): boolean };
/** Native host authority for reads and already-authorized deletion obligations.
 * Neither path reads model sign-in, allowance, prompts or conversation content. */
export function createMailAuthorities(options: {
  db: Database.Database;
  admitted(): boolean;
  assertHostAuthority(): void;
}): MailAuthorities {
  const current = (context: MailContext, polling: boolean): boolean => {
    try {
      options.assertHostAuthority();
      if (
        !options.admitted() ||
        options.db !== getDb() ||
        context.origin ||
        !releaseMode() ||
        !currentRelease() ||
        !hasTable(options.db, 'cos_identity_boundaries')
      )
        return false;
      const row = options.db
        .prepare(
          'SELECT scope_id,agent_group_id,messaging_group_id,session_id,platform_id,binding FROM cos_identity_boundaries WHERE scope_id=?',
        )
        .get(context.scopeId) as
        | {
            scope_id: string;
            agent_group_id: string;
            messaging_group_id: string;
            session_id: string;
            platform_id: string;
            binding: string;
          }
        | undefined;
      if (!row || row.binding.length > 65536) return false;
      const binding = JSON.parse(row.binding) as CosBinding;
      if (
        !binding ||
        binding.scopeId !== row.scope_id ||
        binding.agentGroupId !== row.agent_group_id ||
        binding.sessionId !== row.session_id ||
        binding.messagingGroupId !== row.messaging_group_id ||
        row.platform_id !== `mattermost:${binding.instanceId}:${binding.channelId}` ||
        binding.provider !== 'codex' ||
        binding.scopeId !== context.scopeId ||
        binding.ownerId !== context.ownerId ||
        binding.agentGroupId !== context.agentGroupId ||
        binding.sessionId !== context.sessionId ||
        binding.provider !== context.provider
      )
        return false;
      // Retention remains a tightening obligation after owner pause or native
      // session closure. This cannot create provider reads or model admission.
      if (!polling) return true;
      const session = getSession(binding.sessionId);
      if (!session) return false;
      const boundary = cosBoundary(session, options.db),
        native = validateMattermostSessionForExecution(session);
      return (
        boundary.restricted &&
        !!boundary.binding &&
        !boundary.paused &&
        digest(boundary.binding) === digest(binding) &&
        native.strict &&
        native.valid &&
        native.value.agentGroup.id === binding.agentGroupId &&
        native.value.messagingGroup.id === binding.messagingGroupId &&
        native.value.messagingGroup.platform_id === row.platform_id
      );
      // eslint-disable-next-line no-catch-all/no-catch-all -- Uncertain native/lease/release metadata closes authority without returning private diagnostics.
    } catch {
      return false;
    }
  };
  return { poll: (context) => current(context, true), retention: (context) => current(context, false) };
}
