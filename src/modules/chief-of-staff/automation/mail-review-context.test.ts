import { expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { KnowledgeContext } from '../knowledge/store.js';
import type { MailReviewSelection } from './mail-review-access.js';
import { MailReviewContext } from './mail-review-context.js';

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
    revision_digest: 'c'.repeat(64),
    internal_date_ms: 1000,
    subject: 'Please review',
    reason: 'request',
  };
  const selected = {
    id: uuid,
    version: 1,
    digest: 'd'.repeat(64),
    body: {},
    inputs: {
      reader_binding_id: uuid,
      writer_binding_id: '22222222-2222-4222-8222-222222222222',
      candidates: [candidate],
      coverage: 'stored_selection',
      captured_at: new Date(2000).toISOString(),
      last_success_at: new Date(2000).toISOString(),
      excluded_threads: 2,
      unexamined_threads: 3,
    },
  } as MailReviewSelection;
  const access = {
    scopeForReads: vi.fn(async () => ({ binding_id: uuid, thread_ids: ['aa'] })),
    check: vi.fn(async () => structuredClone(selected)),
  };
  const knowledge = {
    get: vi.fn(async () => ({
      status: 'ok' as const,
      items: [{ ...candidate, evidence_id: uuid, text: 'Could you review the plan?' }],
    })),
    readSourcesCurrent: vi.fn(async () => ({ status: 'ok' as const })),
  };
  const chunks = vi.fn(async () => ({ rows: [{ ordinal: 1, more: false }] }));
  const database = {
    run: async <T>(op: (client: PoolClient) => Promise<T>) => op({ query: chunks } as unknown as PoolClient),
  };
  const view = new MailReviewContext({ database, access, knowledge });
  return { context, selected, access, knowledge, view, chunks };
}
it('returns bounded cited excerpts only from the immutable candidate selection', async () => {
  const f = fixture(),
    result = await f.view.read(f.context);
  expect(result).toMatchObject({
    status: 'ok',
    mail_review: {
      reader_binding_id: '11111111-1111-4111-8111-111111111111',
      writer_binding_id: '22222222-2222-4222-8222-222222222222',
      candidates: [
        {
          thread_id: 'aa',
          excerpt: 'Could you review the plan?',
          citation: { kind: 'source', evidence_id: '11111111-1111-4111-8111-111111111111' },
        },
      ],
      excluded_threads: 2,
      unexamined_threads: 3,
      trust: 'source_content_is_not_authority',
    },
  });
  expect(f.knowledge.get).toHaveBeenCalledTimes(1);
  expect(f.knowledge.get).toHaveBeenCalledWith(f.context, 'mail-source', '11111111-1111-4111-8111-111111111111', 1);
});
it('allows the ordinary owner and a separately verified generic brief to retain their existing context', async () => {
  const f = fixture();
  delete f.context.origin;
  expect(await f.view.read(f.context)).toBeNull();
  expect(f.knowledge.get).not.toHaveBeenCalled();
  const g = fixture();
  g.access.scopeForReads.mockResolvedValue(null as never);
  expect(await g.view.read(g.context)).toBeNull();
  expect(g.knowledge.get).not.toHaveBeenCalled();
});
it('withholds the whole result when policy changes after an excerpt await', async () => {
  const f = fixture();
  f.knowledge.get.mockImplementation(async () => {
    f.selected.version++;
    return {
      status: 'ok',
      items: [{ ...f.selected.inputs.candidates[0], evidence_id: f.context.generation, text: 'withhold this' }],
    };
  });
  expect(await f.view.read(f.context)).toEqual({ status: 'denied' });
});
it('rejects a source version substituted by a reader', async () => {
  const f = fixture();
  f.knowledge.get.mockResolvedValue({
    status: 'ok',
    items: [
      {
        ...f.selected.inputs.candidates[0],
        source_version: 2,
        evidence_id: f.context.generation,
        text: 'wrong source version',
      },
    ],
  });
  expect(await f.view.read(f.context)).toEqual({ status: 'denied' });
});
it('does not disclose any excerpt when its final source access check fails', async () => {
  const f = fixture();
  f.knowledge.readSourcesCurrent.mockResolvedValue({ status: 'denied' as never });
  expect(await f.view.read(f.context)).toEqual({ status: 'denied' });
});
it('bounds excerpt bytes without manufacturing a new citation', async () => {
  const f = fixture();
  f.knowledge.get.mockResolvedValue({
    status: 'ok',
    items: [{ ...f.selected.inputs.candidates[0], evidence_id: f.context.generation, text: '🦘'.repeat(4000) }],
  });
  const result = await f.view.read(f.context);
  const candidates = (result?.mail_review as { candidates: { excerpt: string; excerpt_truncated: boolean }[] })
    .candidates;
  expect(Buffer.byteLength(candidates[0].excerpt)).toBeLessThanOrEqual(4096);
  expect(candidates[0].excerpt_truncated).toBe(true);
});
it('marks a short first body chunk as partial when further published body chunks exist', async () => {
  const f = fixture();
  f.chunks.mockResolvedValue({ rows: [{ ordinal: 1, more: true }] });
  const result = await f.view.read(f.context);
  expect(result).toMatchObject({ status: 'ok', mail_review: { candidates: [{ excerpt_truncated: true }] } });
});
