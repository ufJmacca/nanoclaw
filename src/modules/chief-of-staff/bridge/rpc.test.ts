import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRpcHandler } from './rpc.js';
import { digest } from '../domain/contracts.js';
import type { PriorityStore } from '../store/priorities.js';
import type { Session } from '../../../types.js';
import type { KnowledgeStore } from '../knowledge/store.js';
const databases: Database.Database[] = [];
const request = {
  protocol: 'cos-rpc/v1',
  request_id: '11111111-1111-4111-8111-111111111111',
  method: 'cos_context_get',
  params: { view: 'today' },
};
function fixture(allowed = true) {
  const db = new Database(':memory:');
  databases.push(db);
  const context = {
    scopeId: 'fixture',
    ownerId: 'owner',
    sessionId: 'session',
    agentGroupId: 'group',
    ingressId: 'verified',
  };
  const store = {
    context: vi.fn().mockResolvedValue({ status: 'ok', records: [{ id: 'approved-record' }] }),
    propose: vi.fn(),
    status: vi.fn(),
  };
  const resolveContext = vi.fn().mockResolvedValue(allowed ? context : null);
  const handler = createRpcHandler({ resolveContext, store: store as unknown as PriorityStore });
  return { db, handler, store, resolveContext };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('S01 host-owned SQLite RPC response bridge', () => {
  it('mirrors the authorised result separately from chat using the actual session', async () => {
    const { db, handler, store, resolveContext } = fixture();
    const session = { id: 'session', agent_group_id: 'group' } as Session;
    await handler({ action: 'cos_rpc', delivery_id: '22222222-2222-4222-8222-222222222222', request }, session, db);
    const row = db
      .prepare('SELECT response FROM cos_rpc_responses WHERE request_id=? AND payload_hash=?')
      .get(request.request_id, digest(request)) as { response: string };
    expect(row).toBeDefined();
    expect(JSON.parse(row.response)).toMatchObject({
      protocol: 'cos-rpc/v1',
      status: 'ok',
      result: { records: [{ id: 'approved-record' }] },
    });
    expect(resolveContext).toHaveBeenCalledWith(session, db);
    expect(store.context).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='messages_in'").get()).toBeUndefined();
  });
  it('denies unbound sessions without querying private state', async () => {
    const { db, handler, store } = fixture(false);
    await handler(
      { action: 'cos_rpc', delivery_id: '22222222-2222-4222-8222-222222222222', request },
      {} as Session,
      db,
    );
    const row = db.prepare('SELECT response FROM cos_rpc_responses').get() as { response: string };
    expect(row).toBeDefined();
    expect(JSON.parse(row.response).status).toBe('denied');
    expect(store.context).not.toHaveBeenCalled();
  });
  it('rejects caller-supplied identity before resolving authority', async () => {
    const { db, handler, resolveContext } = fixture();
    await handler(
      {
        action: 'cos_rpc',
        delivery_id: '22222222-2222-4222-8222-222222222222',
        request: { ...request, ownerId: 'forged' },
      },
      {} as Session,
      db,
    );
    expect(resolveContext).not.toHaveBeenCalled();
  });
  it('revalidates current authority on every read instead of returning stale private responses', async () => {
    const { db, handler, store, resolveContext } = fixture();
    await handler(
      { action: 'cos_rpc', delivery_id: '22222222-2222-4222-8222-222222222222', request },
      {} as Session,
      db,
    );
    resolveContext.mockResolvedValue(null);
    await handler(
      { action: 'cos_rpc', delivery_id: '22222222-2222-4222-8222-222222222222', request },
      {} as Session,
      db,
    );
    const row = db.prepare('SELECT response FROM cos_rpc_responses').get() as { response: string };
    expect(row).toBeDefined();
    expect(JSON.parse(row.response).status).toBe('denied');
    expect(store.context).toHaveBeenCalledTimes(1);
  });
});
describe('S02 knowledge RPC host authority', () => {
  it.each(['cos_answer_prepare', 'cos_answer_get'])(
    'routes %s with host context and suppresses output when the generation changes',
    async (method) => {
      const { db, store } = fixture();
      const context = {
        scopeId: 'fixture',
        ownerId: 'owner',
        sessionId: 'session',
        agentGroupId: 'group',
        ingressId: 'verified',
      };
      const knowledgeContext = { ...context, provider: 'codex', generation: '33333333-3333-4333-8333-333333333333' };
      const artifactId = 'a'.repeat(64) + '-' + 'b'.repeat(64);
      const draft = { kind: 'answer', coverage: 'insufficient', claims: [] };
      const knowledge = {
        contextReady: vi.fn().mockResolvedValue({ status: 'ok' }),
        answers: {
          prepare: vi.fn().mockResolvedValue({ status: 'ok', artifact_id: artifactId, text: 'private answer canary' }),
          get: vi.fn().mockResolvedValue({ status: 'ok', artifact_id: artifactId, text: 'private answer canary' }),
        },
      };
      const resolveKnowledgeContext = vi.fn().mockResolvedValue(knowledgeContext);
      const handler = createRpcHandler({
        resolveContext: async () => context,
        store: store as unknown as PriorityStore,
        knowledge: knowledge as unknown as KnowledgeStore,
        resolveKnowledgeContext,
      });
      const content = {
        action: 'cos_rpc',
        delivery_id: '22222222-2222-4222-8222-222222222222',
        request: {
          ...request,
          method,
          params: method === 'cos_answer_prepare' ? { draft } : { artifact_id: artifactId },
        },
      };
      const response = () =>
        JSON.parse((db.prepare('SELECT response FROM cos_rpc_responses').get() as { response: string }).response);
      await handler(content, {} as Session, db);
      expect(response()).toMatchObject({ status: 'ok', result: { text: 'private answer canary' } });
      if (method === 'cos_answer_prepare')
        expect(knowledge.answers.prepare).toHaveBeenCalledWith(knowledgeContext, request.request_id, draft);
      else expect(knowledge.answers.get).toHaveBeenCalledWith(knowledgeContext, artifactId);
      expect(store.propose).not.toHaveBeenCalled();
      resolveKnowledgeContext
        .mockResolvedValueOnce(knowledgeContext)
        .mockResolvedValue({ ...knowledgeContext, generation: '44444444-4444-4444-8444-444444444444' });
      await handler(content, {} as Session, db);
      expect(response().status).toBe('denied');
      expect(JSON.stringify(response())).not.toContain('private answer canary');
    },
  );
  it('derives provider and generation on the host, and rejects a prepared response after revocation', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const context = {
      scopeId: 'fixture',
      ownerId: 'owner',
      sessionId: 'session',
      agentGroupId: 'group',
      ingressId: 'verified',
    };
    const knowledge = {
      search: vi.fn().mockResolvedValue({ status: 'ok', items: [{ text: 'private canary' }] }),
      contextReady: vi.fn().mockResolvedValue({ status: 'ok' }),
    };
    const resolveKnowledgeContext = vi
      .fn()
      .mockResolvedValue({ ...context, provider: 'codex', generation: '33333333-3333-4333-8333-333333333333' });
    const handler = createRpcHandler({
      resolveContext: async () => context,
      store: {} as PriorityStore,
      knowledge: knowledge as unknown as KnowledgeStore,
      resolveKnowledgeContext,
    });
    const query = { ...request, method: 'cos_knowledge_search', params: { query: 'Pilot Alpha', limit: 2 } };
    const content = { action: 'cos_rpc', delivery_id: '22222222-2222-4222-8222-222222222222', request: query };
    await handler(content, { id: 'session' } as Session, db);
    expect(
      JSON.parse((db.prepare('SELECT response FROM cos_rpc_responses').get() as { response: string }).response),
    ).toMatchObject({ status: 'ok', result: { items: [{ text: 'private canary' }] } });
    expect(knowledge.search).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeId: 'fixture',
        provider: 'codex',
        generation: '33333333-3333-4333-8333-333333333333',
      }),
      expect.objectContaining({ query: 'Pilot Alpha', limit: 2 }),
    );
    knowledge.contextReady.mockResolvedValueOnce({ status: 'ok' }).mockResolvedValue({ status: 'denied' });
    await handler(content, { id: 'session' } as Session, db);
    const denied = (db.prepare('SELECT response FROM cos_rpc_responses').get() as { response: string }).response;
    expect(JSON.parse(denied).status).toBe('denied');
    expect(denied).not.toContain('private canary');
  });
});
