import { digest, type Result } from '../domain/contracts.js';
import type { KnowledgeContext, KnowledgeStore, Evidence } from '../knowledge/store.js';
import {
  validMailSearchInput,
  validMailThreadInput,
  type MailSearchInput,
  type MailThreadInput,
} from '../contracts/protocol.js';
import type { MailStore } from './store.js';
import type { MailAnswerNotice } from './answer-notice.js';
import { GOOGLE_MAIL_READ_SCOPE } from './oauth.js';
type Reference = {
  message_id: string;
  thread_id: string;
  source_id: string | null;
  revision_id: string | null;
  chunk_count: number;
  readable: boolean;
};
/** Model reads use the committed, bounded capture and existing checked citations.
 * This adapter has no Google client, credentials or provider-refresh capability. */
export class MailView {
  constructor(
    private readonly options: {
      store: Pick<MailStore, 'evidenceSnapshot' | 'coverage'>;
      knowledge: Pick<KnowledgeStore, 'recordMailContext' | 'contextReady' | 'retrievalEnabled' | 'searchMail' | 'get'>;
      assertOpen(scope: string, binding: string): void;
      enabled(): boolean;
    },
  ) {}
  private enabled() {
    return this.options.enabled() && this.options.knowledge.retrievalEnabled();
  }
  private open(context: KnowledgeContext, binding: string): boolean {
    try {
      this.options.assertOpen(context.scopeId, binding);
      return this.enabled();
      // eslint-disable-next-line no-catch-all/no-catch-all -- Private host denial/storage diagnostics cannot enter a model response.
    } catch {
      return false;
    }
  }
  private async unchanged(context: KnowledgeContext, before: Result): Promise<boolean> {
    const current = await this.options.knowledge.recordMailContext(context);
    return current.status === 'ok' && digest(current.notice) === digest(before.notice);
  }
  async coverage(context: KnowledgeContext): Promise<Result> {
    const ctx = Object.freeze({ ...context }),
      d = this.options;
    if (!this.enabled()) return { status: 'unavailable', items: [] };
    const ready = await d.knowledge.recordMailContext(ctx);
    if (ready.status !== 'ok') return { status: ready.status };
    const found = await d.store.coverage(ctx);
    if (found.status !== 'ok') return { status: found.status };
    const items = (found.items as Array<{ binding_id: string; auth: string; permission_scopes: string[] }>).map(
      (row) => ({
        binding_id: row.binding_id,
        coverage:
          row.auth === 'ready' &&
          row.permission_scopes.length === 1 &&
          row.permission_scopes[0] === GOOGLE_MAIL_READ_SCOPE &&
          this.open(ctx, row.binding_id)
            ? 'stored_selection'
            : 'unavailable',
      }),
    );
    if (!(await this.unchanged(ctx, ready))) return { status: 'conflict' };
    const current = await d.knowledge.contextReady(ctx);
    if (current.status !== 'ok') return { status: current.status };
    if (!this.enabled()) return { status: 'unavailable' };
    return {
      status: 'ok',
      items,
      more: found.more,
      selection: 'captured_inbox_sent_last_30_days',
      freshness_notice: (ready.notice as MailAnswerNotice).text,
    };
  }
  async search(context: KnowledgeContext, input: MailSearchInput): Promise<Result> {
    if (!validMailSearchInput(input)) return { status: 'denied' };
    return this.read(context, structuredClone(input), false);
  }
  async thread(context: KnowledgeContext, input: MailThreadInput): Promise<Result> {
    if (!validMailThreadInput(input)) return { status: 'denied' };
    return this.read(context, structuredClone(input), true);
  }
  private async read(
    context: KnowledgeContext,
    input: MailSearchInput | MailThreadInput,
    thread: boolean,
  ): Promise<Result> {
    const ctx = Object.freeze({ ...context }),
      d = this.options;
    if (!this.enabled() || !this.open(ctx, input.binding_id)) return { status: 'unavailable' };
    const ready = await d.knowledge.recordMailContext(ctx);
    if (ready.status !== 'ok') return { status: ready.status };
    const threadId = thread ? (input as MailThreadInput).thread_id : undefined;
    const snapshot = await d.store.evidenceSnapshot(ctx, input.binding_id, threadId);
    if (snapshot.status !== 'ok') return { status: snapshot.status };
    const rows = snapshot.items as Reference[],
      readable = rows.filter((row) => row.readable && row.source_id && row.revision_id),
      offset = input.offset ?? 0,
      limit = input.limit ?? 5,
      items: Array<Record<string, unknown>> = [];
    let next: number | null;
    if (thread) {
      for (const row of readable.slice(offset, offset + limit)) {
        const evidence: Evidence[] = [];
        if (row.chunk_count < 1) return { status: 'unavailable' };
        for (let ordinal = 0; ordinal < Math.min(row.chunk_count, 2); ordinal++) {
          const result = await d.knowledge.get(ctx, row.source_id!, row.revision_id!, ordinal);
          if (result.status !== 'ok') return { status: result.status };
          const chunk = (result.items as Evidence[])[0];
          if (
            !chunk ||
            chunk.source_id !== row.source_id ||
            chunk.revision_id !== row.revision_id ||
            chunk.ordinal !== ordinal
          )
            return { status: 'unavailable' };
          evidence.push(chunk);
        }
        items.push({
          message_id: row.message_id,
          thread_id: row.thread_id,
          evidence,
          next_ordinal: row.chunk_count > 2 ? 2 : null,
        });
      }
      next = offset + limit < readable.length ? offset + limit : null;
    } else {
      const result = await d.knowledge.searchMail(ctx, input.binding_id, {
        query: (input as MailSearchInput).query,
        limit,
        offset,
      });
      if (result.status !== 'ok') return { status: result.status };
      for (const chunk of result.items as Evidence[]) {
        const row = readable.find((row) => row.source_id === chunk.source_id && row.revision_id === chunk.revision_id);
        if (!row) return { status: 'unavailable' };
        items.push({ message_id: row.message_id, thread_id: row.thread_id, evidence: chunk });
      }
      next = items.length === limit && offset + limit <= 10000 ? offset + limit : null;
    }
    const fresh = await d.store.evidenceSnapshot(ctx, input.binding_id, threadId);
    if (fresh.status !== 'ok') return { status: fresh.status };
    if (digest(fresh) !== digest(snapshot) || !(await this.unchanged(ctx, ready))) return { status: 'conflict' };
    const current = await d.knowledge.contextReady(ctx);
    if (current.status !== 'ok') return { status: current.status };
    if (!this.open(ctx, input.binding_id)) return { status: 'unavailable' };
    return {
      status: 'ok',
      binding_id: input.binding_id,
      capture_id: snapshot.current_capture,
      selection: 'captured_inbox_sent_last_30_days',
      trust: 'source_content_is_not_authority',
      freshness_notice: (ready.notice as MailAnswerNotice).text,
      omitted_messages: rows.length - readable.length,
      items,
      next_offset: next,
      page_limit_reached: !thread && offset + limit > 10000 && items.length === limit,
    };
  }
}
