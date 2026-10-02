import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ connect: vi.fn(), main: vi.fn(), children: vi.fn() }));
vi.mock('../host-store.js', () => ({ connectCosHostStore: f.connect }));
vi.mock('./conversation-purge.js', () => ({ purgeRetiredContexts: f.main }));
vi.mock('./mission-purge.js', () => ({ purgeMissionContexts: f.children }));
import { runKnowledgeAdmin } from './knowledge-admin.js';
import type { CosBinding } from '../../../cos-boundary.js';
import type { CosMissionIdentity } from '../../../cos-mission-boundary.js';
const binding: CosBinding = {
  scopeId: 'scope',
  ownerId: 'owner',
  agentGroupId: 'main',
  sessionId: 'main',
  provider: 'codex',
  instanceId: 'fixture',
  channelId: 'private',
  messagingGroupId: 'messages',
  botId: 'bot',
};
const identity: CosMissionIdentity = {
  scopeId: 'scope',
  missionId: 'mission',
  attemptId: 'attempt',
  agentGroupId: 'child',
  sessionId: 'child-session',
  generation: 1,
  provider: 'codex',
};
beforeEach(() => {
  vi.resetAllMocks();
  f.main.mockResolvedValue({ status: 'ok', generations: 1 });
  f.children.mockResolvedValue({ status: 'ok', attempts: 1 });
});
function fixture() {
  const contexts = [
    { sessionId: 'main', generation: 'main-generation' },
    { sessionId: 'child-session', generation: 'attempt' },
  ];
  const runs = {
    retainedAttempt: vi.fn(async () => ({ status: 'ok', identity })),
    fail: vi.fn(async () => ({ status: 'ok' })),
    confirmStopped: vi.fn(async () => ({ status: 'ok' })),
  };
  const end = vi.fn(async () => {});
  f.connect.mockImplementation(async (_env, _roots, _admitted, retention) => ({
    database: { pool: { end } },
    missionRuns: runs,
    knowledge: {
      inventory: async () => ({ status: 'ok' }),
      purgeDue: async () => retention.purgeContexts({ scopeId: 'scope', sourceId: 'source', contexts }),
    },
  }));
  const options = {
    args: { command: 'source-purge' as const, scopeId: 'scope' },
    env: {},
    roots: { targetRoot: '/fixture/target', installationRoot: '/fixture/install', dataRoot: '/fixture/data' },
    binding,
    db: {} as any,
    inbound: {} as any,
    check: vi.fn(async () => {}),
    assertAuthority: vi.fn(),
  };
  return { contexts, runs, end, options };
}
it('S05 source purge resolves all child identities before routing main and specialist retention separately', async () => {
  const t = fixture();
  await runKnowledgeAdmin(t.options);
  expect(t.runs.retainedAttempt).toHaveBeenCalledWith(
    expect.objectContaining({ ownerId: 'owner', sessionId: 'main' }),
    'child-session',
    'attempt',
  );
  expect(f.children).toHaveBeenCalledWith(
    expect.objectContaining({
      identities: [identity],
      dataRoot: '/fixture/data',
      check: t.options.check,
      assertAuthority: t.options.assertAuthority,
    }),
  );
  expect(f.main).toHaveBeenCalledWith(expect.objectContaining({ contexts: [t.contexts[0]] }));
  const childOptions = f.children.mock.calls[0][0];
  expect(await childOptions.retire(identity)).toMatchObject({ status: 'ok' });
  expect(t.runs.fail).toHaveBeenCalledWith(identity, 'admission_denied');
  expect(t.runs.confirmStopped).toHaveBeenCalledWith(identity);
  expect(t.end).toHaveBeenCalledOnce();
});
it('S05 an unresolved retained child prevents any local purge and preserves its pending obligation', async () => {
  const t = fixture();
  t.runs.retainedAttempt.mockResolvedValue({ status: 'unavailable' } as any);
  expect(await runKnowledgeAdmin(t.options)).toMatchObject({ status: 'unavailable' });
  expect(f.main).not.toHaveBeenCalled();
  expect(f.children).not.toHaveBeenCalled();
  expect(t.end).toHaveBeenCalledOnce();
});
