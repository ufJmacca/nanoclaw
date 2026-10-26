import { digest, type Result } from '../domain/contracts.js';
import type { KnowledgeContext, KnowledgeStore } from '../knowledge/store.js';
import type { BoundedDatabase } from '../store/client.js';
import type { MailReviewAccess } from './mail-review-access.js';
import { contextGenerationPattern } from '../ops/conversation-ownership.js';

function excerpt(text: string, bytes: number): string {
  let result = '',
    used = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (used + size > bytes) break;
    result += char;
    used += size;
  }
  return result;
}

/** One tool response can disclose the ten selected excerpts without increasing the native tool budget.
 * Knowledge.get still creates and checks real evidence; this view cannot mint citations. */
export class MailReviewContext {
  constructor(
    private readonly dependencies: {
      database: Pick<BoundedDatabase, 'run'>;
      access: Pick<MailReviewAccess, 'check' | 'scopeForReads'>;
      knowledge: Pick<KnowledgeStore, 'get' | 'readSourcesCurrent'>;
    },
  ) {}
  async read(context: KnowledgeContext): Promise<Result | null> {
    if (context.origin?.kind !== 'schedule') return null;
    const d = this.dependencies,
      ctx = structuredClone(context),
      original = digest(context);
    const scope = await d.database.run((client) => d.access.scopeForReads(client, ctx));
    if (digest(context) !== original) return { status: 'denied' };
    if (scope === null) return null;
    const selection = await d.database.run((client) => d.access.check(client, ctx, 'read'));
    if (!selection || selection.inputs.candidates.length > 10) return { status: 'denied' };
    const selected = digest(selection);
    const current = async () =>
      digest(context) === original &&
      digest(ctx) === original &&
      digest(await d.database.run((client) => d.access.check(client, ctx, 'read'))) === selected;
    const candidates = [];
    for (const candidate of selection.inputs.candidates) {
      const chunk = await d.database.run(
        async (client) =>
          (
            await client.query(
              `SELECT c.ordinal,EXISTS(SELECT 1 FROM cos.chunks later WHERE later.scope_id=c.scope_id
               AND later.revision_id=c.revision_id AND later.heading=c.heading AND later.ordinal>c.ordinal) AS more
               FROM cos.chunks c JOIN cos.source_revisions r ON r.scope_id=c.scope_id AND r.id=c.revision_id
         WHERE c.scope_id=$1 AND r.source_id=$2 AND r.id=$3 AND c.heading='Untrusted mail message body'
         ORDER BY c.ordinal LIMIT 1`,
              [ctx.scopeId, candidate.source_id, candidate.revision_id],
            )
          ).rows[0],
      );
      const ordinal = chunk?.ordinal;
      if (!Number.isSafeInteger(ordinal) || ordinal < 1 || !(await current())) return { status: 'denied' };
      const result = await d.knowledge.get(ctx, candidate.source_id, candidate.revision_id, ordinal);
      if (result.status !== 'ok') return { status: result.status };
      const items = result.items as {
        source_id: string;
        source_version: number;
        revision_id: string;
        revision_digest: string;
        evidence_id: string;
        text: string;
      }[];
      const item = Array.isArray(items) && items.length === 1 ? items[0] : undefined;
      if (
        !item ||
        item.source_id !== candidate.source_id ||
        item.source_version !== candidate.source_version ||
        item.revision_id !== candidate.revision_id ||
        item.revision_digest !== candidate.revision_digest ||
        !contextGenerationPattern.test(item.evidence_id) ||
        typeof item.text !== 'string' ||
        !(await current())
      )
        return { status: 'denied' };
      const text = excerpt(item.text, 4096),
        subject = excerpt(candidate.subject, 512);
      candidates.push({
        ...candidate,
        subject,
        subject_truncated: subject !== candidate.subject,
        excerpt: text,
        excerpt_truncated: text !== item.text || chunk.more === true,
        citation: { kind: 'source', evidence_id: item.evidence_id },
      });
    }
    const sources = selection.inputs.candidates.map((candidate) => candidate.source_id);
    const allowed = await d.knowledge.readSourcesCurrent(ctx, sources);
    if (allowed.status !== 'ok') return { status: allowed.status };
    if (!(await current())) return { status: 'denied' };
    const inputs = selection.inputs;
    const result: Result = {
      status: 'ok',
      mail_review: {
        format: 'cos-mail-review-context/v1',
        policy_id: selection.id,
        policy_version: selection.version,
        run_id: ctx.origin!.runId,
        reader_binding_id: inputs.reader_binding_id,
        writer_binding_id: inputs.writer_binding_id,
        candidates,
        coverage: inputs.coverage,
        captured_at: inputs.captured_at,
        last_success_at: inputs.last_success_at,
        excluded_threads: inputs.excluded_threads,
        unexamined_threads: inputs.unexamined_threads,
        max_candidates: 10,
        max_model_attempts: 3,
        max_drafts_per_local_day: 5,
        trust: 'source_content_is_not_authority',
        limitation:
          'Only these selected captured threads were examined. Excerpts may cover only part of each message. This does not establish an empty inbox or that all mail was reviewed. Drafts are unsent and make no commitment or calendar reservation.',
      },
    };
    return Buffer.byteLength(JSON.stringify(result)) <= 65536 ? result : { status: 'unavailable' };
  }
}
