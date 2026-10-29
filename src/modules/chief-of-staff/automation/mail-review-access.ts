import type { PoolClient } from 'pg';
import { digest } from '../domain/contracts.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import type { MailDraftAuthority } from '../mail-drafts/authority.js';
import { validMailDraftBinding } from '../mail-drafts/binding.js';
import { GOOGLE_MAIL_READ_SCOPE } from '../calendar/oauth-core.js';
import { validMailReviewBinding, type MailReviewBinding } from './mail-review-binding.js';
import { validMailReviewInputs, type MailReviewInputs } from './mail-review-inputs.js';
import { mailReviewSchedulePolicy } from './mail-review-policy.js';
import { contextGenerationPattern } from '../ops/conversation-ownership.js';
import { MAIL_RETENTION_MS } from '../mail/normalization.js';
import { mailSourceAccess } from '../mail/source-access.js';

export type MailReviewSelection = {
  id: string;
  version: number;
  digest: string;
  body: MailReviewBinding;
  inputs: MailReviewInputs;
};
export type MailReviewReadScope = { binding_id: string | null; thread_ids: string[] };
export type MailReviewPreparation = Omit<MailReviewSelection, 'inputs'> & {
  inputs: MailReviewInputs | null;
  captureId: string;
  captureDigest: string;
  capturedAt: string;
  lastSuccessAt: string | null;
  coverage: MailReviewInputs['coverage'];
};
type Identity = Pick<MailDraftAuthority, 'bindingDigest' | 'contextGeneration'>;
type QueryClient = Pick<PoolClient, 'query'>;

/** Additional scheduled-run fence. Existing source, credential, model and draft-journal checks still apply. */
export class MailReviewAccess {
  constructor(
    private readonly options: {
      /** Trusted native resolver, including the actual local scheduled origin. No model-supplied identity. */
      authority(context: KnowledgeContext): Identity | null;
      /** Retained owner identity for host preparation only, before any scheduled origin/model use. */
      ownerAuthority?(context: KnowledgeContext): Identity | null;
      /** Separately owned, current review profile. SQL checkpoints cannot enable it. */
      matches(context: KnowledgeContext, selection: Omit<MailReviewSelection, 'inputs'>): boolean;
    },
  ) {}

  private identity(context: KnowledgeContext): Identity | null {
    const origin = context.origin;
    if (
      context.provider !== 'codex' ||
      origin?.kind !== 'schedule' ||
      !/^[a-f0-9]{64}$/.test(origin.runId) ||
      !Number.isSafeInteger(origin.generation) ||
      origin.generation < 1 ||
      origin.generation > 2147483647 ||
      context.ingressId !== `brief:${origin.runId}:${origin.generation}` ||
      !contextGenerationPattern.test(context.generation)
    )
      return null;
    const identity = this.options.authority(context);
    return identity?.contextGeneration === context.generation && /^[a-f0-9]{64}$/.test(identity.bindingDigest)
      ? structuredClone(identity)
      : null;
  }
  private ownerIdentity(context: KnowledgeContext): Identity | null {
    if (context.origin || context.provider !== 'codex' || !contextGenerationPattern.test(context.generation))
      return null;
    const value = this.options.ownerAuthority?.(context);
    return value?.contextGeneration === context.generation && /^[a-f0-9]{64}$/.test(value.bindingDigest)
      ? structuredClone(value)
      : null;
  }

  /** null is reserved for ordinary owner reads or a separately verified generic scheduled brief.
   * Every missing, revoked or expired review returns an empty Mail scope, never an owner fallback. */
  async scopeForReads(client: QueryClient, context: KnowledgeContext): Promise<MailReviewReadScope | null> {
    if (context.origin?.kind !== 'schedule') return null;
    const ctx = structuredClone(context),
      identity = this.identity(ctx);
    if (!identity) return { binding_id: null, thread_ids: [] };
    const selected = await this.check(client, ctx, 'read');
    if (selected)
      return {
        binding_id: selected.body.readerBindingId,
        thread_ids: selected.inputs.candidates.map((c) => c.thread_id),
      };
    const generic = await client.query(
      `SELECT 1 FROM cos.brief_runs br
      JOIN cos.scopes sc ON sc.id=br.scope_id AND sc.status='active' AND sc.owner_id=$4 AND sc.agent_group_id=$6
      JOIN cos.brief_schedules bs ON bs.scope_id=br.scope_id AND bs.id=br.schedule_id AND bs.version=br.schedule_version
      WHERE br.scope_id=$1 AND br.id=$2 AND br.generation=$3 AND br.owner_id=$4 AND br.session_id=$5 AND br.agent_group_id=$6
       AND bs.owner_id=$4 AND bs.session_id=$5 AND bs.agent_group_id=$6 AND bs.purpose='brief' AND bs.policy->>'state'='active'
       AND br.state IN ('dispatched','prepared') AND br.lease_owner=$7 AND br.lease_until>clock_timestamp() AND br.deadline_at>clock_timestamp()
       AND br.model_calls<=(br.limits->>'max_turns')::integer AND br.tool_calls<=(br.limits->>'max_tool_calls')::integer`,
      [
        ctx.scopeId,
        ctx.origin!.runId,
        ctx.origin!.generation,
        ctx.ownerId,
        ctx.sessionId,
        ctx.agentGroupId,
        'cos-native-' + identity.bindingDigest,
      ],
    );
    return generic.rowCount === 1 && digest(this.identity(ctx)) === digest(identity)
      ? null
      : { binding_id: null, thread_ids: [] };
  }

  async check(
    client: QueryClient,
    context: KnowledgeContext,
    mode: 'read' | 'draft',
    threadId?: string,
  ): Promise<MailReviewSelection | null> {
    if (!['read', 'draft'].includes(mode)) return null;
    const selected = await this.selection(client, context, mode, threadId);
    return selected?.inputs
      ? {
          id: selected.id,
          version: selected.version,
          digest: selected.digest,
          body: selected.body,
          inputs: selected.inputs,
        }
      : null;
  }
  /** Host-only metadata. This never installs an origin, changes a selection, reserves model use or reads mail bodies. */
  async preparation(
    client: QueryClient,
    context: KnowledgeContext,
    runId: string,
    generation: number,
  ): Promise<MailReviewPreparation | null> {
    return this.selection(client, context, 'prepare', undefined, { runId, generation });
  }
  /** Caller owns the preparation transaction. Freeze once, before model/tool use; an identical
   * acknowledged selection can be reconciled but never replaced with another set of threads. */
  async freeze(
    client: QueryClient,
    context: KnowledgeContext,
    runId: string,
    generation: number,
    prepared: MailReviewPreparation,
    inputs: MailReviewInputs,
  ): Promise<boolean> {
    if (!validMailReviewInputs(inputs)) return false;
    const inputDigest = digest(inputs),
      preparationDigest = digest(prepared),
      contextDigest = digest(context),
      captured = structuredClone(inputs),
      ctx = structuredClone(context),
      stable = () =>
        digest(inputs) === inputDigest && digest(prepared) === preparationDigest && digest(context) === contextDigest;
    const current = await this.preparation(client, ctx, runId, generation);
    if (!current || !stable()) return false;
    if (current.inputs) return digest(current.inputs) === inputDigest;
    if (
      digest(current) !== preparationDigest ||
      captured.policy_id !== current.id ||
      captured.policy_version !== current.version ||
      captured.policy_digest !== current.digest ||
      captured.context_generation !== ctx.generation ||
      captured.reader_binding_id !== current.body.readerBindingId ||
      captured.writer_binding_id !== current.body.writerBindingId ||
      captured.capture_id !== current.captureId ||
      captured.captured_at !== current.capturedAt ||
      captured.last_success_at !== current.lastSuccessAt ||
      captured.coverage !== current.coverage
    )
      return false;
    const sources = await client.query(
      `SELECT c.source_message_id FROM jsonb_to_recordset($4::jsonb) AS c(
      source_message_id text,thread_id text,source_id text,source_version integer,revision_id text,revision_digest text,internal_date_ms double precision,subject text)
      JOIN cos.mail_messages mm ON mm.scope_id=$1 AND mm.binding_id=$2 AND mm.provider_message_id=c.source_message_id
       AND mm.provider_thread_id=c.thread_id AND mm.source_id=c.source_id
      JOIN cos.mail_states ms ON ms.scope_id=mm.scope_id AND ms.binding_id=mm.binding_id AND ms.current_capture=$3
      JOIN cos.sources s ON s.scope_id=mm.scope_id AND s.id=mm.source_id AND s.version=c.source_version
      JOIN cos.source_revisions r ON r.scope_id=s.scope_id AND r.source_id=s.id AND r.id=s.current_revision_id AND r.id=c.revision_id AND r.digest=c.revision_digest
      JOIN cos.artifacts a ON a.scope_id=r.scope_id AND a.id=r.artifact_id AND a.kind='source' AND a.lifecycle='published' AND a.digest=r.digest
      WHERE s.status IN ('current','stale') AND $5=ANY(s.processing_providers) AND s.provenance->>'origin'='mail_message'
       AND s.access_policy->>'scope_owner_only'='true' AND mm.message->>'subject'=c.subject
       AND floor(extract(epoch FROM mm.internal_date)*1000)::double precision=c.internal_date_ms
       AND NOT EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=s.scope_id AND t.source_id=s.id)
       AND ${mailSourceAccess("ARRAY['mail:'||$2::text]")} FOR SHARE OF mm,ms,s,r,a`,
      [ctx.scopeId, current.body.readerBindingId, current.captureId, JSON.stringify(captured.candidates), ctx.provider],
    );
    if (sources.rowCount !== captured.candidates.length || !stable()) return false;
    const saved = await client.query(
      `UPDATE cos.brief_runs br SET review_inputs=$4,version=br.version+1,updated_at=clock_timestamp()
      FROM cos.brief_schedules bs,cos.mail_review_policies p,cos.mail_review_policy_revisions pr,cos.scopes sc
      WHERE br.scope_id=$1 AND br.id=$2 AND br.generation=$3 AND br.review_inputs IS NULL AND br.model_calls=0 AND br.tool_calls=0
       AND br.state='dispatched' AND br.deadline_at>clock_timestamp() AND br.lease_until>clock_timestamp() AND br.lease_owner=$5
       AND br.owner_id=$6 AND br.session_id=$7 AND br.agent_group_id=$8
       AND sc.id=br.scope_id AND sc.owner_id=$6 AND sc.agent_group_id=$8 AND sc.status='active'
       AND bs.scope_id=br.scope_id AND bs.id=br.schedule_id AND bs.version=br.schedule_version
       AND bs.purpose='mail_review' AND bs.policy->>'state'='active' AND bs.mail_review_policy_id=$9 AND bs.mail_review_policy_version=$10
       AND p.scope_id=bs.scope_id AND p.id=bs.mail_review_policy_id AND p.version=bs.mail_review_policy_version AND p.state='enabled'
       AND pr.scope_id=p.scope_id AND pr.binding_id=p.id AND pr.version=p.version AND pr.digest=$11`,
      [
        ctx.scopeId,
        runId,
        generation,
        JSON.stringify(captured),
        'cos-native-' + current.body.nativeBindingDigest,
        ctx.ownerId,
        ctx.sessionId,
        ctx.agentGroupId,
        current.id,
        current.version,
        current.digest,
      ],
    );
    if (saved.rowCount !== 1 || !stable()) return false;
    const final = await this.preparation(client, ctx, runId, generation);
    return stable() && !!final?.inputs && digest(final.inputs) === inputDigest;
  }
  private async selection(
    client: QueryClient,
    context: KnowledgeContext,
    mode: 'read' | 'draft' | 'prepare',
    threadId?: string,
    preparation?: { runId: string; generation: number },
  ): Promise<MailReviewPreparation | null> {
    const ctx = structuredClone(context),
      preparing = mode === 'prepare',
      origin = preparing ? preparation : ctx.origin?.kind === 'schedule' ? ctx.origin : undefined;
    if (
      ctx.provider !== 'codex' ||
      !origin ||
      !/^[a-f0-9]{64}$/.test(origin.runId) ||
      !Number.isSafeInteger(origin.generation) ||
      origin.generation < 1 ||
      origin.generation > 2147483647 ||
      (preparing ? !!ctx.origin : ctx.ingressId !== `brief:${origin.runId}:${origin.generation}`) ||
      !['read', 'draft', 'prepare'].includes(mode) ||
      (mode === 'draft' && (typeof threadId !== 'string' || !/^[a-f0-9]{1,128}$/.test(threadId)))
    )
      return null;
    const identity = preparing ? this.ownerIdentity(ctx) : this.identity(ctx);
    if (!identity) return null;
    const pinnedIdentity = structuredClone(identity);
    const row = (
      await client.query(
        `SELECT p.id,p.version,pr.body,pr.digest,br.review_inputs AS inputs,bs.id AS schedule_id,bs.mail_review_slot AS slot,
       bs.policy,bs.limits,br.limits AS run_limits,br.model_calls,br.tool_calls,wr.body AS writer_body,wr.digest AS writer_digest,
       wr.consent_ref,mb.provider AS reader_provider,mb.mailbox_email,mc.capture_window,ms.last_success_at,
       ms.current_capture AS capture_id,mc.content_digest AS capture_digest,mc.metadata->>'contract' AS capture_contract,
       mc.metadata->'complete'='true'::jsonb AS capture_complete,mc.metadata->'limitations'='[]'::jsonb AS capture_unlimited,
       ms.current_capture=ms.last_attempt AS latest_capture,
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
        AND br.state=ANY($8::text[]) AND br.lease_owner=$7 AND br.lease_until>clock_timestamp() AND br.deadline_at>clock_timestamp()
        AND br.model_calls<=3 AND br.tool_calls<=16
        AND mb.permission_scopes=ARRAY['${GOOGLE_MAIL_READ_SCOPE}']::text[] AND 'codex'=ANY(mb.processing_providers)
        AND ($9::boolean OR br.review_inputs->>'capture_id'=mc.id::text)`,
        [
          ctx.scopeId,
          origin.runId,
          origin.generation,
          ctx.ownerId,
          ctx.sessionId,
          ctx.agentGroupId,
          'cos-native-' + pinnedIdentity.bindingDigest,
          mode === 'read' ? ['dispatched', 'prepared'] : ['dispatched'],
          preparing,
        ],
      )
    ).rows[0];
    if (
      !row ||
      !validMailReviewBinding(row.body) ||
      ((!preparing || row.inputs !== null) && !validMailReviewInputs(row.inputs)) ||
      !validMailDraftBinding(row.writer_body) ||
      digest(row.body) !== row.digest ||
      digest(row.writer_body) !== row.writer_digest
    )
      return null;
    const body: MailReviewBinding = row.body,
      inputs: MailReviewInputs | null = validMailReviewInputs(row.inputs) ? row.inputs : null;
    const lastSuccess = row.last_success_at?.toISOString() ?? null,
      stale = !lastSuccess || row.now.getTime() - Date.parse(lastSuccess) > 600000;
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
      !contextGenerationPattern.test(row.capture_id) ||
      !/^[a-f0-9]{64}$/.test(row.capture_digest) ||
      !Number.isSafeInteger(row.capture_window?.capturedAt) ||
      row.capture_window.capturedAt <= MAIL_RETENTION_MS ||
      row.capture_window.since !== row.capture_window.capturedAt - MAIL_RETENTION_MS ||
      row.capture_window.capturedAt > row.now.getTime() ||
      (preparing && !inputs && (row.model_calls !== 0 || row.tool_calls !== 0)) ||
      (inputs &&
        (inputs.capture_id !== row.capture_id ||
          inputs.policy_id !== row.id ||
          inputs.policy_version !== row.version ||
          inputs.policy_digest !== row.digest ||
          inputs.context_generation !== ctx.generation ||
          inputs.reader_binding_id !== body.readerBindingId ||
          inputs.writer_binding_id !== body.writerBindingId ||
          Date.parse(inputs.captured_at) !== row.capture_window?.capturedAt ||
          Date.parse(inputs.captured_at) > row.now.getTime() ||
          inputs.last_success_at !== lastSuccess)) ||
      (mode === 'draft' &&
        (!inputs ||
          row.model_calls < 1 ||
          stale ||
          inputs.coverage === 'stale' ||
          !inputs.candidates.some((c) => c.thread_id === threadId)))
    )
      return null;
    const selected: MailReviewPreparation = {
      id: row.id,
      version: row.version,
      digest: row.digest,
      body: structuredClone(body),
      inputs: structuredClone(inputs),
      captureId: row.capture_id,
      captureDigest: row.capture_digest,
      capturedAt: new Date(row.capture_window.capturedAt).toISOString(),
      lastSuccessAt: lastSuccess,
      coverage: stale
        ? 'stale'
        : row.capture_contract === 'cos-mail-capture/v1' &&
            row.capture_complete &&
            row.capture_unlimited &&
            row.latest_capture
          ? 'stored_selection'
          : 'incomplete',
    };
    return this.options.matches(ctx, selected) &&
      digest(preparing ? this.ownerIdentity(ctx) : this.identity(ctx)) === digest(pinnedIdentity)
      ? selected
      : null;
  }
}
