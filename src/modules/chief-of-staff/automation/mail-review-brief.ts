import type { MailReviewDraftNotice } from '../mail-drafts/store.js';
import type { MailReviewCandidate, MailReviewInputs } from './mail-review-inputs.js';
import type { PoolClient } from 'pg';
import { digest, type Result } from '../domain/contracts.js';
import type { KnowledgeContext, KnowledgeStore } from '../knowledge/store.js';
import type { BoundedDatabase } from '../store/client.js';
import type { MailDraftStore } from '../mail-drafts/store.js';
import type { MailReviewContext } from './mail-review-context.js';
import type { MailReviewAccess, MailReviewSelection } from './mail-review-access.js';
import { contextGenerationPattern } from '../ops/conversation-ownership.js';

/** Host-collected references and observations only. The model cannot submit this snapshot. */
export type MailReviewBriefSnapshot = {
  format: 'cos-mail-review-brief/v1';
  run_id: string;
  run_generation: number;
  policy_id: string;
  policy_version: number;
  selection_digest: string;
  captured_at: string;
  last_success_at: string | null;
  coverage: MailReviewInputs['coverage'];
  excluded_threads: number;
  unexamined_threads: number;
  attention: {
    source_message_id: string;
    subject: string;
    reason: MailReviewCandidate['reason'];
    citation: { kind: 'source'; evidence_id: string };
  }[];
  drafts: MailReviewDraftNotice[];
};

function header(context: KnowledgeContext, selected: MailReviewSelection) {
  const inputs = selected.inputs;
  return {
    format: 'cos-mail-review-brief/v1' as const,
    run_id: context.origin!.runId,
    run_generation: context.origin!.generation,
    policy_id: selected.id,
    policy_version: selected.version,
    selection_digest: digest(inputs),
    captured_at: inputs.captured_at,
    last_success_at: inputs.last_success_at,
    coverage: inputs.coverage,
    excluded_threads: inputs.excluded_threads,
    unexamined_threads: inputs.unexamined_threads,
  };
}
/** Host-owned briefing input. No model text, new effect, calendar write or extra model attempt is accepted. */
export class MailReviewBrief {
  constructor(
    readonly dependencies: {
      database: Pick<BoundedDatabase, 'run'>;
      access: Pick<MailReviewAccess, 'check' | 'scopeForReads'>;
      view: Pick<MailReviewContext, 'read'>;
      drafts: Pick<MailDraftStore, 'reviewNotices' | 'reviewNoticesCurrent'>;
      knowledge: Pick<KnowledgeStore, 'answers'>;
    },
  ) {}
  get access() {
    return this.dependencies.access;
  }
  async collect(context: KnowledgeContext): Promise<Result | null> {
    const d = this.dependencies,
      ctx = structuredClone(context),
      original = digest(context);
    const result = await d.view.read(ctx);
    if (result === null) return null;
    if (result.status !== 'ok') return { status: result.status };
    const selected = await d.database.run((client) => d.access.check(client, ctx, 'read'));
    if (!selected || ctx.origin?.kind !== 'schedule' || digest(context) !== original) return { status: 'denied' };
    const disclosed = (
      result.mail_review as {
        candidates?: {
          source_message_id: string;
          source_id: string;
          revision_id: string;
          citation: { kind: 'source'; evidence_id: string };
        }[];
      }
    )?.candidates;
    if (!Array.isArray(disclosed) || disclosed.length !== selected.inputs.candidates.length || disclosed.length > 10)
      return { status: 'denied' };
    const attention: MailReviewBriefSnapshot['attention'] = [];
    for (const [index, candidate] of selected.inputs.candidates.entries()) {
      const item = disclosed[index];
      if (
        !item ||
        item.source_message_id !== candidate.source_message_id ||
        item.source_id !== candidate.source_id ||
        item.revision_id !== candidate.revision_id ||
        item.citation?.kind !== 'source' ||
        !contextGenerationPattern.test(item.citation.evidence_id)
      )
        return { status: 'denied' };
      attention.push({
        source_message_id: candidate.source_message_id,
        subject: candidate.subject,
        reason: candidate.reason,
        citation: structuredClone(item.citation),
      });
    }
    const drafts = await d.drafts.reviewNotices(ctx);
    if (drafts.status !== 'ok') return { status: drafts.status };
    const snapshot: MailReviewBriefSnapshot = {
      ...header(ctx, selected),
      attention,
      drafts: structuredClone(drafts.drafts as MailReviewDraftNotice[]),
    };
    return digest(context) === original &&
      digest(ctx) === original &&
      (await d.database.run((client) => this.validate(client, ctx, snapshot)))
      ? { status: 'ok', snapshot }
      : { status: 'denied' };
  }
  /** Caller-owned publication transaction. Resolve the exact current source anchors and independent effects. */
  async validate(client: PoolClient, context: KnowledgeContext, snapshot?: MailReviewBriefSnapshot): Promise<boolean> {
    const d = this.dependencies,
      original = digest(context),
      ctx = structuredClone(context);
    if (ctx.origin?.kind !== 'schedule') return snapshot === undefined;
    const scope = await d.access.scopeForReads(client, ctx);
    if (scope === null) return snapshot === undefined;
    const selected = await d.access.check(client, ctx, 'read');
    if (
      !selected ||
      !snapshot ||
      !Array.isArray(snapshot.attention) ||
      !Array.isArray(snapshot.drafts) ||
      snapshot.attention.length !== selected.inputs.candidates.length ||
      snapshot.attention.length > 10
    )
      return false;
    const { attention, drafts, ...frame } = snapshot;
    if (digest(frame) !== digest(header(ctx, selected))) return false;
    const anchors = [];
    for (const [index, candidate] of selected.inputs.candidates.entries()) {
      const item = attention[index];
      if (
        !item ||
        item.citation?.kind !== 'source' ||
        !contextGenerationPattern.test(item.citation.evidence_id) ||
        digest(item) !==
          digest({
            source_message_id: candidate.source_message_id,
            subject: candidate.subject,
            reason: candidate.reason,
            citation: item.citation,
          })
      )
        return false;
      anchors.push({
        evidence_id: item.citation.evidence_id,
        source_id: candidate.source_id,
        source_version: candidate.source_version,
        revision_id: candidate.revision_id,
        revision_digest: candidate.revision_digest,
      });
    }
    const checked = await client.query(
      `SELECT e.id FROM jsonb_to_recordset($5::jsonb) AS a(evidence_id text,source_id text,source_version integer,revision_id text,revision_digest text)
       JOIN cos.evidence_refs e ON e.scope_id=$1 AND e.session_id=$2 AND e.context_generation=$3 AND e.processing_provider=$4
        AND e.id::text=a.evidence_id AND e.source_id=a.source_id AND e.source_version=a.source_version
        AND e.revision_id=a.revision_id AND e.revision_digest=a.revision_digest`,
      [ctx.scopeId, ctx.sessionId, ctx.generation, ctx.provider, JSON.stringify(anchors)],
    );
    if (
      checked.rowCount !== anchors.length ||
      !(await d.knowledge.answers.validateWorkEvidence(
        client,
        ctx,
        attention.map((item) => item.citation),
        true,
      )) ||
      !(await d.drafts.reviewNoticesCurrent(client, ctx, drafts))
    )
      return false;
    return (
      digest(context) === original &&
      digest(ctx) === original &&
      digest(await d.access.check(client, ctx, 'read')) === digest(selected)
    );
  }
}
