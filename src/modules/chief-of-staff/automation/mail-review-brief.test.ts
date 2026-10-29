import { expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { digest, type Result } from '../domain/contracts.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import type { MailReviewSelection } from './mail-review-access.js';
import { MailReviewBrief, type MailReviewBriefSnapshot } from './mail-review-brief.js';

function fixture() {
  const uuid = '11111111-1111-4111-8111-111111111111';
  const context = {
    scopeId: 'scope',
    ownerId: 'owner',
    sessionId: 'session',
    agentGroupId: 'group',
    provider: 'codex',
    generation: uuid,
    ingressId: 'brief:' + 'a'.repeat(64) + ':1',
    origin: { kind: 'schedule', runId: 'a'.repeat(64), generation: 1 },
  } as KnowledgeContext;
  const candidate = {
    thread_id: 'aa',
    source_message_id: 'bb',
    source_id: 'mail-source',
    source_version: 1,
    revision_id: uuid,
    revision_digest: digest('revision'),
    internal_date_ms: 1000,
    subject: 'Please review',
    reason: 'request' as const,
  };
  const selection = {
    id: uuid,
    version: 1,
    digest: digest('policy'),
    body: {},
    inputs: {
      candidates: [candidate],
      coverage: 'stored_selection',
      captured_at: new Date(2000).toISOString(),
      last_success_at: new Date(2000).toISOString(),
      excluded_threads: 2,
      unexamined_threads: 3,
    },
  } as MailReviewSelection;
  let live = true;
  const access = {
    check: vi.fn(async () => (live ? structuredClone(selection) : null)),
    scopeForReads: vi.fn(async () => ({ binding_id: uuid, thread_ids: ['aa'] })),
  };
  const view = {
    read: vi.fn(
      async (): Promise<Result | null> => ({
        status: 'ok',
        mail_review: { candidates: [{ ...candidate, citation: { kind: 'source', evidence_id: uuid } }] },
      }),
    ),
  };
  const drafts = {
    reviewNotices: vi.fn(async (): Promise<Result> => ({ status: 'ok', drafts: [] })),
    reviewNoticesCurrent: vi.fn(async () => true),
  };
  const knowledge = { answers: { validateWorkEvidence: vi.fn(async () => true) } };
  const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
  const client = { query } as unknown as PoolClient;
  const database = { run: async <T>(op: (client: PoolClient) => Promise<T>) => op(client) };
  const brief = new MailReviewBrief({ database, access, view, drafts, knowledge: knowledge as never });
  return {
    context,
    selection,
    access,
    view,
    drafts,
    query,
    client,
    brief,
    revoke: () => {
      live = false;
    },
  };
}
it('collects the frozen source references and independently checked draft observations', async () => {
  const f = fixture(),
    result = await f.brief.collect(f.context);
  expect(result).toMatchObject({
    status: 'ok',
    snapshot: {
      format: 'cos-mail-review-brief/v1',
      selection_digest: digest(f.selection.inputs),
      attention: [{ source_message_id: 'bb', citation: { kind: 'source', evidence_id: f.context.generation } }],
      drafts: [],
    },
  });
  expect(await f.brief.validate(f.client, f.context, result!.snapshot as MailReviewBriefSnapshot)).toBe(true);
});
it('does not attach a review snapshot to an ordinary or separately verified generic briefing', async () => {
  const f = fixture();
  f.view.read.mockResolvedValue(null);
  expect(await f.brief.collect(f.context)).toBeNull();
  expect(f.drafts.reviewNotices).not.toHaveBeenCalled();
  f.access.scopeForReads.mockResolvedValue(null as never);
  expect(await f.brief.validate(f.client, f.context)).toBe(true);
});
it('withholds review output if policy is revoked while the context is being collected', async () => {
  const f = fixture();
  f.view.read.mockImplementation(async () => {
    f.revoke();
    return { status: 'ok', mail_review: { candidates: [] } };
  });
  expect(await f.brief.collect(f.context)).toEqual({ status: 'denied' });
});
it('rejects a changed source label, invented evidence, or changed independent draft observation at publication', async () => {
  const f = fixture(),
    result = await f.brief.collect(f.context),
    snapshot = result!.snapshot as MailReviewBriefSnapshot;
  expect(
    await f.brief.validate(f.client, f.context, {
      ...snapshot,
      attention: [{ ...snapshot.attention[0], subject: 'substituted subject' }],
    }),
  ).toBe(false);
  f.query.mockResolvedValue({ rows: [], rowCount: 0 });
  expect(await f.brief.validate(f.client, f.context, snapshot)).toBe(false);
  f.query.mockResolvedValue({ rows: [], rowCount: 1 });
  f.drafts.reviewNoticesCurrent.mockResolvedValue(false);
  expect(await f.brief.validate(f.client, f.context, snapshot)).toBe(false);
});
