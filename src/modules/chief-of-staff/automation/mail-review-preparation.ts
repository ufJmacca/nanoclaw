import type { PoolClient } from 'pg';
import { digest, type Result } from '../domain/contracts.js';
import type { KnowledgeContext, KnowledgeStore } from '../knowledge/store.js';
import type { MailConnector } from '../mail/connector.js';
import { MAIL_RETENTION_MS } from '../mail/normalization.js';
import type { BoundedDatabase } from '../store/client.js';
import type { MailReviewAccess, MailReviewPreparation } from './mail-review-access.js';
import { planMailReviewCandidates } from './mail-review-candidates.js';
import { validMailReviewInputs, type MailReviewInputs } from './mail-review-inputs.js';
import { loadMailReviewRecords } from './mail-review-records.js';

type Dependencies = {
  database: Pick<BoundedDatabase, 'run'>;
  access: Pick<MailReviewAccess, 'preparation' | 'freeze'>;
  knowledge: Pick<KnowledgeStore, 'actionContextCurrent'>;
  connector: Pick<MailConnector, 'reviewSource'>;
  current(): boolean;
  /** Trusted loader seam for isolated fixtures; runtime uses the published-source loader. */
  records?: typeof loadMailReviewRecords;
};
class PreparationDenied extends Error {}

/** Preparation has no model or draft port. Provider awaits never hold a database transaction. */
export class MailReviewPreparer {
  constructor(private readonly dependencies: Dependencies) {}

  async execute(context: KnowledgeContext, runId: string, generation: number, signal?: AbortSignal): Promise<Result> {
    const d = this.dependencies,
      ctx = structuredClone(context),
      original = digest(context);
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const timer = setTimeout(() => controller.abort(), 30000);
    const active = () => !combined.aborted && d.current() && digest(context) === original && digest(ctx) === original;
    const requireActive = () => {
      if (!active()) throw new PreparationDenied();
    };
    const transaction = <T>(operation: (client: PoolClient) => Promise<T>, mutation = false) =>
      d.database.run(
        async (client) => {
          requireActive();
          await client.query('BEGIN');
          try {
            if (!(await d.knowledge.actionContextCurrent(client, ctx))) throw new PreparationDenied();
            requireActive();
            const value = await operation(client);
            requireActive();
            await client.query('COMMIT');
            requireActive();
            return value;
          } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
          }
        },
        mutation,
        combined,
      );
    try {
      requireActive();
      if (ctx.origin) throw new PreparationDenied();
      const prepared = await transaction((client) => d.access.preparation(client, ctx, runId, generation));
      if (!prepared) throw new PreparationDenied();
      // Reconciliation never loads bodies, refreshes provider metadata or changes the frozen selection.
      if (prepared.inputs) return { status: 'ok' };
      const same = (value: MailReviewPreparation | null) => !!value && digest(value) === digest(prepared);
      const current = async () => {
        if (!active()) return false;
        return transaction(async (client) => same(await d.access.preparation(client, ctx, runId, generation)));
      };
      const records = await transaction(async (client) => {
        if (!same(await d.access.preparation(client, ctx, runId, generation))) throw new PreparationDenied();
        const rows = await (d.records ?? loadMailReviewRecords)(
          client,
          ctx,
          prepared.body.readerBindingId,
          prepared.captureId,
        );
        if (!same(await d.access.preparation(client, ctx, runId, generation))) throw new PreparationDenied();
        return rows;
      });
      const plan = planMailReviewCandidates(records),
        candidates: MailReviewInputs['candidates'] = [];
      let excluded = plan.excludedThreads,
        unexamined = plan.unexaminedThreads;
      if (prepared.coverage === 'stale') unexamined += plan.candidates.length;
      else
        for (const candidate of plan.candidates) {
          requireActive();
          if (!(await current())) throw new PreparationDenied();
          const capturedAt = Date.now();
          const fresh = await d.connector.reviewSource(
            ctx,
            prepared.body.readerBindingId,
            candidate.source_message_id,
            { capturedAt, since: capturedAt - MAIL_RETENTION_MS },
            current,
            combined,
          );
          requireActive();
          if (!(await current())) throw new PreparationDenied();
          const stored = records.find((row) => row.message.id === candidate.source_message_id)!.message;
          if (
            fresh.id !== stored.id ||
            fresh.threadId !== stored.threadId ||
            fresh.historyId !== stored.historyId ||
            fresh.internalDate !== stored.internalDate ||
            !Number.isSafeInteger(fresh.observedAt) ||
            fresh.observedAt < capturedAt - 60000 ||
            fresh.observedAt > Date.now() ||
            ![null, 'bulk_mail', 'automated_mail', 'no_reply'].includes(fresh.excluded)
          )
            throw new PreparationDenied();
          if (fresh.excluded) excluded++;
          else candidates.push(candidate);
        }
      const inputs: MailReviewInputs = {
        format: 'cos-mail-review-inputs/v1',
        policy_id: prepared.id,
        policy_version: prepared.version,
        policy_digest: prepared.digest,
        context_generation: ctx.generation,
        reader_binding_id: prepared.body.readerBindingId,
        writer_binding_id: prepared.body.writerBindingId,
        capture_id: prepared.captureId,
        captured_at: prepared.capturedAt,
        last_success_at: prepared.lastSuccessAt,
        coverage: prepared.coverage,
        excluded_threads: excluded,
        unexamined_threads: unexamined,
        candidates,
      };
      if (!validMailReviewInputs(inputs)) throw new PreparationDenied();
      await transaction(async (client) => {
        if (!(await d.access.freeze(client, ctx, runId, generation, prepared, inputs))) throw new PreparationDenied();
      }, true);
      return { status: 'ok' };
      // eslint-disable-next-line no-catch-all/no-catch-all -- Provider, database and private source failures are withheld from model-facing preparation results.
    } catch (error) {
      return { status: error instanceof PreparationDenied || !active() ? 'denied' : 'unavailable' };
    } finally {
      clearTimeout(timer);
    }
  }
}
