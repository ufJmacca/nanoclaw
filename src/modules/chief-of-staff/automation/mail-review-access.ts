import type { PoolClient } from 'pg';
import { digest } from '../domain/contracts.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import type { MailDraftAuthority } from '../mail-drafts/authority.js';
import { validMailDraftBinding } from '../mail-drafts/binding.js';
import { GOOGLE_MAIL_READ_SCOPE } from '../calendar/oauth-core.js';
import { validMailReviewBinding, type MailReviewBinding } from './mail-review-binding.js';
import { validMailReviewInputs, type MailReviewInputs } from './mail-review-inputs.js';
import { mailReviewSchedulePolicy } from './mail-review-policy.js';

export type MailReviewSelection = {
  id: string;
  version: number;
  digest: string;
  body: MailReviewBinding;
  inputs: MailReviewInputs;
};
type Identity = Pick<MailDraftAuthority, 'bindingDigest' | 'contextGeneration'>;
type QueryClient = Pick<PoolClient, 'query'>;

/** Additional scheduled-run fence. Existing source, credential, model and draft-journal checks still apply. */
export class MailReviewAccess {
  constructor(
    private readonly options: {
      /** Trusted native resolver, including the actual local scheduled origin. No model-supplied identity. */
      authority(context: KnowledgeContext): Identity | null;
      /** Separately owned, current review profile. SQL checkpoints cannot enable it. */
      matches(context: KnowledgeContext, selection: MailReviewSelection): boolean;
    },
  ) {}

  async check(
    client: QueryClient,
    context: KnowledgeContext,
    mode: 'read' | 'draft',
    threadId?: string,
  ): Promise<MailReviewSelection | null> {
    const ctx = structuredClone(context),
      origin = ctx.origin;
    if (
      ctx.provider !== 'codex' ||
      origin?.kind !== 'schedule' ||
      !/^[a-f0-9]{64}$/.test(origin.runId) ||
      !Number.isSafeInteger(origin.generation) ||
      origin.generation < 1 ||
      origin.generation > 2147483647 ||
      ctx.ingressId !== `brief:${origin.runId}:${origin.generation}` ||
      !['read', 'draft'].includes(mode) ||
      (mode === 'draft' && (typeof threadId !== 'string' || !/^[a-f0-9]{1,128}$/.test(threadId)))
    )
      return null;
    const identity = this.options.authority(ctx);
    if (!identity || identity.contextGeneration !== ctx.generation || !/^[a-f0-9]{64}$/.test(identity.bindingDigest))
      return null;
    const pinnedIdentity = structuredClone(identity);
    const row = (
      await client.query(
        `SELECT p.id,p.version,pr.body,pr.digest,br.review_inputs AS inputs,bs.id AS schedule_id,bs.mail_review_slot AS slot,
       bs.policy,bs.limits,br.limits AS run_limits,br.model_calls,wr.body AS writer_body,wr.digest AS writer_digest,
       wr.consent_ref,mb.provider AS reader_provider,mb.mailbox_email,mc.capture_window,ms.last_success_at,
       clock_timestamp() AS now
       FROM cos.brief_runs br
       JOIN cos.scopes sc ON sc.id=br.scope_id AND sc.status='active'
       JOIN cos.brief_schedules bs ON bs.scope_id=br.scope_id AND bs.id=br.schedule_id AND bs.version=br.schedule_version
       JOIN cos.mail_review_policies p ON p.scope_id=bs.scope_id AND p.id=bs.mail_review_policy_id
        AND p.version=bs.mail_review_policy_version AND p.state='enabled'
       JOIN cos.mail_review_policy_revisions pr ON pr.scope_id=p.scope_id AND pr.binding_id=p.id AND pr.version=p.version
       JOIN cos.mail_draft_writer_bindings w ON w.scope_id=pr.scope_id AND w.id=pr.writer_binding_id
        AND w.version=pr.writer_version AND w.reader_binding_id=pr.reader_binding_id AND w.state='enabled'
       JOIN cos.mail_draft_writer_revisions wr ON wr.scope_id=w.scope_id AND wr.binding_id=w.id AND wr.version=w.version
       JOIN cos.mail_bindings mb ON mb.scope_id=pr.scope_id AND mb.id=pr.reader_binding_id AND mb.auth='ready'
       JOIN cos.mail_states ms ON ms.scope_id=mb.scope_id AND ms.binding_id=mb.id
       JOIN cos.mail_captures mc ON mc.scope_id=mb.scope_id AND mc.binding_id=mb.id AND mc.id=ms.current_capture
        AND mc.status='complete' AND mc.binding_version=mb.version
       WHERE br.scope_id=$1 AND br.id=$2 AND br.generation=$3 AND br.owner_id=$4 AND br.session_id=$5 AND br.agent_group_id=$6
        AND sc.owner_id=$4 AND sc.agent_group_id=$6
        AND bs.owner_id=$4 AND bs.session_id=$5 AND bs.agent_group_id=$6 AND bs.purpose='mail_review' AND bs.policy->>'state'='active'
        AND p.owner_id=$4 AND p.session_id=$5 AND p.agent_group_id=$6 AND w.owner_id=$4 AND w.session_id=$5
        AND br.state='dispatched' AND br.lease_owner=$7 AND br.lease_until>clock_timestamp() AND br.deadline_at>clock_timestamp()
        AND br.model_calls<=3 AND br.tool_calls<=16
        AND mb.permission_scopes=ARRAY['${GOOGLE_MAIL_READ_SCOPE}']::text[] AND 'codex'=ANY(mb.processing_providers)
        AND br.review_inputs->>'capture_id'=mc.id::text`,
        [
          ctx.scopeId,
          origin.runId,
          origin.generation,
          ctx.ownerId,
          ctx.sessionId,
          ctx.agentGroupId,
          'cos-native-' + pinnedIdentity.bindingDigest,
        ],
      )
    ).rows[0];
    if (
      !row ||
      !validMailReviewBinding(row.body) ||
      !validMailReviewInputs(row.inputs) ||
      !validMailDraftBinding(row.writer_body) ||
      digest(row.body) !== row.digest ||
      digest(row.writer_body) !== row.writer_digest
    )
      return null;
    const body: MailReviewBinding = row.body,
      inputs: MailReviewInputs = row.inputs;
    const limits = { max_turns: 3, max_tool_calls: 16, deadline_seconds: 300, refresh_seconds: 30 };
    if (
      !['morning', 'afternoon'].includes(row.slot) ||
      row.schedule_id !== (row.slot === 'morning' ? body.morningScheduleId : body.afternoonScheduleId) ||
      digest(row.policy) !== digest(mailReviewSchedulePolicy(row.slot)) ||
      digest(row.limits) !== digest(limits) ||
      digest(row.run_limits) !== digest(limits) ||
      body.nativeBindingDigest !== pinnedIdentity.bindingDigest ||
      body.contextGeneration !== ctx.generation ||
      body.writerDigest !== row.writer_digest ||
      body.writerConsentRef !== row.consent_ref ||
      body.readerBindingId !== row.writer_body.readerBindingId ||
      body.nativeBindingDigest !== row.writer_body.nativeBindingDigest ||
      body.mailboxDigest !== row.writer_body.mailboxDigest ||
      body.mailboxDigest !== digest(row.mailbox_email.toLowerCase()) ||
      body.provider !== row.reader_provider ||
      body.provider !== row.writer_body.provider ||
      inputs.policy_id !== row.id ||
      inputs.policy_version !== row.version ||
      inputs.policy_digest !== row.digest ||
      inputs.context_generation !== ctx.generation ||
      inputs.reader_binding_id !== body.readerBindingId ||
      inputs.writer_binding_id !== body.writerBindingId ||
      Date.parse(inputs.captured_at) !== row.capture_window?.capturedAt ||
      Date.parse(inputs.captured_at) > row.now.getTime() ||
      inputs.last_success_at !== (row.last_success_at?.toISOString() ?? null) ||
      (mode === 'draft' &&
        (row.model_calls < 1 ||
          inputs.coverage === 'stale' ||
          !inputs.candidates.some((c) => c.thread_id === threadId)))
    )
      return null;
    const selected: MailReviewSelection = {
      id: row.id,
      version: row.version,
      digest: row.digest,
      body: structuredClone(body),
      inputs: structuredClone(inputs),
    };
    return this.options.matches(ctx, selected) && digest(this.options.authority(ctx)) === digest(pinnedIdentity)
      ? selected
      : null;
  }
}
