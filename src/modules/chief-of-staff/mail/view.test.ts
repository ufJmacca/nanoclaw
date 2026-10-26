import { describe, expect, it, vi } from 'vitest';
import { MailView } from './view.js';
const binding = '11111111-1111-4111-8111-111111111111';
const context = {
  scopeId: 'scope',
  ownerId: 'owner',
  agentGroupId: 'group',
  sessionId: 'session',
  ingressId: 'ingress',
  generation: 'generation',
  provider: 'codex',
};
const notice = {
  text: 'Incomplete stored Inbox/Sent observation; not an empty inbox.',
  fingerprint: 'capture',
  identityDigest: 'policy',
};
function fixture() {
  const row = {
    message_id: 'a1',
    thread_id: 'b1',
    source_id: 'source',
    revision_id: binding,
    version: 1,
    chunk_count: 3,
    readable: true,
  };
  const snapshot = { status: 'ok' as const, binding_id: binding, current_capture: 'capture', items: [row] };
  const store = {
    evidenceSnapshot: vi.fn(async () => snapshot),
    coverage: vi.fn(async () => ({ status: 'ok' as const, items: [] })),
  };
  const knowledge = {
    retrievalEnabled: () => true,
    recordMailContext: vi.fn(async () => ({ status: 'ok' as const, notice })),
    contextReady: vi.fn(async () => ({ status: 'ok' as const })),
    readSourcesCurrent: vi.fn(async () => ({ status: 'ok' as 'ok' | 'denied' })),
    searchMail: vi.fn(async () => ({
      status: 'ok' as const,
      items: [{ source_id: 'source', revision_id: binding, text: 'Untrusted mail' }],
    })),
    get: vi.fn(async (_c, _s, _r, ordinal: number) => ({
      status: 'ok' as const,
      items: [{ source_id: 'source', revision_id: binding, ordinal, text: 'Untrusted mail', evidence_id: 'evidence' }],
    })),
  };
  const options = { store, knowledge, enabled: () => true, assertOpen: vi.fn() };
  return { row, snapshot, store, knowledge, options, view: new MailView(options) };
}
describe('G04 bounded captured-mail view', () => {
  it('G06 rechecks selected source access after its final metadata awaits', async () => {
    const f = fixture(),
      runId = 'a'.repeat(64),
      ctx = { ...context, ingressId: `brief:${runId}:1`, origin: { kind: 'schedule' as const, runId, generation: 1 } };
    f.knowledge.readSourcesCurrent.mockResolvedValue({ status: 'denied' });
    expect(await f.view.thread(ctx, { binding_id: binding, thread_id: 'b1' })).toEqual({ status: 'denied' });
    expect(f.knowledge.readSourcesCurrent).toHaveBeenCalledWith(ctx, ['source']);
  });
  it('pages messages independently of chunk continuations and never reads more than five messages', async () => {
    const f = fixture();
    f.snapshot.items = Array.from({ length: 7 }, (_, i) => ({ ...f.row, message_id: i.toString(16) }));
    const first = await f.view.thread(context, { binding_id: binding, thread_id: 'b1' });
    expect(first.next_offset).toBe(5);
    expect(first.items).toHaveLength(5);
    expect(f.knowledge.get).toHaveBeenCalledTimes(10);
    f.knowledge.get.mockClear();
    const second = await f.view.thread(context, { binding_id: binding, thread_id: 'b1', offset: 5 });
    expect(second.next_offset).toBe(null);
    expect(second.items).toHaveLength(2);
    expect(f.knowledge.get).toHaveBeenCalledTimes(4);
  });
  it('does no metadata or source work while retrieval is disabled', async () => {
    const f = fixture();
    f.options.enabled = () => false;
    expect(await f.view.search(context, { binding_id: binding, query: 'alpha' })).toEqual({ status: 'unavailable' });
    expect(f.knowledge.recordMailContext).not.toHaveBeenCalled();
    expect(f.store.evidenceSnapshot).not.toHaveBeenCalled();
  });
  it('returns only captured thread members, at most two cited chunks each, with an explicit continuation', async () => {
    const f = fixture(),
      result = await f.view.thread(context, { binding_id: binding, thread_id: 'b1' });
    expect(result.status).toBe('ok');
    expect(f.store.evidenceSnapshot).toHaveBeenCalledWith(context, binding, 'b1');
    expect(f.knowledge.get).toHaveBeenCalledTimes(2);
    expect(result.items).toMatchObject([
      { message_id: 'a1', thread_id: 'b1', next_ordinal: 2, evidence: [{ ordinal: 0 }, { ordinal: 1 }] },
    ]);
    expect(result.freshness_notice).toBe(notice.text);
    expect(result.selection).toBe('captured_inbox_sent_last_30_days');
  });
  it('never reads an unavailable selected source or calls a provider to expand the thread', async () => {
    const f = fixture();
    f.row.readable = false;
    const result = await f.view.thread(context, { binding_id: binding, thread_id: 'b1' });
    expect(result.status).toBe('ok');
    expect(result.items).toEqual([]);
    expect(result.omitted_messages).toBe(1);
    expect(f.knowledge.get).not.toHaveBeenCalled();
    expect(result.freshness_notice).toContain('Incomplete');
  });
  it('binds mail search before ranking and pagination', async () => {
    const f = fixture(),
      result = await f.view.search(context, { binding_id: binding, query: 'alpha', limit: 1, offset: 4 });
    expect(result.status).toBe('ok');
    expect(f.knowledge.searchMail).toHaveBeenCalledWith(context, binding, { query: 'alpha', limit: 1, offset: 4 });
    expect(result.items).toMatchObject([{ message_id: 'a1', thread_id: 'b1' }]);
  });
  it('discards results if the committed selection changes while evidence is read', async () => {
    const f = fixture();
    f.store.evidenceSnapshot
      .mockResolvedValueOnce(structuredClone(f.snapshot))
      .mockResolvedValueOnce({ ...f.snapshot, current_capture: 'other' });
    const result = await f.view.thread(context, { binding_id: binding, thread_id: 'b1' });
    expect(result).toEqual({ status: 'conflict' });
  });
  it('closes on late host denial without returning accumulated evidence', async () => {
    const f = fixture();
    f.options.assertOpen
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw Error('private denial');
      });
    expect(await f.view.thread(context, { binding_id: binding, thread_id: 'b1' })).toEqual({ status: 'unavailable' });
  });
  it('rejects account, scope, thread and paging overrides before reading', async () => {
    const f = fixture();
    for (const extra of [{ thread_id: '../bad' }, { limit: 6 }, { account: 'other' }, { scope_id: 'other' }])
      expect(await f.view.thread(context, { binding_id: binding, thread_id: 'b1', ...extra })).toEqual({
        status: 'denied',
      });
    expect(f.store.evidenceSnapshot).not.toHaveBeenCalled();
  });
});
