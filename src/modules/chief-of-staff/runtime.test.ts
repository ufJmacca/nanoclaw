import { afterEach, expect, it, vi } from 'vitest';
import { initTestDb, closeDb } from '../../db/connection.js';
import { installCosBoundary, prepareCosLaunch, type CosBinding, type CosLaunch } from '../../cos-boundary.js';
import type { Session } from '../../types.js';
import type { PriorityStore } from './store/priorities.js';
import { createCosRuntime } from './runtime.js';

let runtime: ReturnType<typeof createCosRuntime> | undefined;
afterEach(() => {
  runtime?.dispose();
  closeDb();
  vi.useRealTimers();
});
it('keeps egress polling local between bounded remote checks while new admissions stay fresh', async () => {
  vi.useFakeTimers();
  const db = initTestDb();
  const binding: CosBinding = {
    scopeId: 'scope',
    agentGroupId: 'group',
    messagingGroupId: 'mg',
    sessionId: 'session',
    provider: 'codex',
    instanceId: 'fixture',
    channelId: 'private',
    ownerId: 'owner',
    botId: 'bot',
  };
  const session = {
    id: 'session',
    agent_group_id: 'group',
    messaging_group_id: 'mg',
    thread_id: null,
    status: 'active',
    agent_provider: 'codex',
  } as Session;
  installCosBoundary(binding, db);
  db.prepare('UPDATE cos_identity_boundaries SET paused=0, ingress_id=?, ingress_at=?').run(
    'ingress',
    new Date().toISOString(),
  );
  const facts = vi.fn(async () => ({
    id: 'private',
    type: 'P',
    delete_at: 0,
    members: ['bot', 'owner'],
    activeSubscription: true,
  }));
  const context = vi.fn(async () => ({ status: 'ok' }));
  let authorize!: (mode?: 'poll') => Promise<string | null>;
  runtime = createCosRuntime({
    db,
    enabled: true,
    store: { context } as unknown as PriorityStore,
    facts,
    session: () => session,
    destination: () => undefined,
    stop: vi.fn(),
    wake: vi.fn(),
    launcher: {
      ready: () => true,
      prepare: async (_binding, _session, check) => {
        authorize = check;
        return {} as CosLaunch;
      },
    },
  });
  await prepareCosLaunch(session);
  expect(await authorize()).toBe('ingress');
  for (let i = 0; i < 120; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    expect(await authorize('poll')).toBe('ingress');
  }
  expect(facts).toHaveBeenCalledTimes(9);
  expect(context).toHaveBeenCalledTimes(9);
  // New admission must not use the cached remote membership, even in the same second.
  facts.mockResolvedValue({
    id: 'private',
    type: 'P',
    delete_at: 0,
    members: ['bot', 'owner', 'stranger'],
    activeSubscription: true,
  });
  expect(await authorize()).toBeNull();
  expect(await authorize('poll')).toBeNull();
  expect(facts).toHaveBeenCalledTimes(10);
});
it('revokes model authorization when emergency pause arrives during the database check', async () => {
  const db = initTestDb();
  const binding: CosBinding = {
    scopeId: 'scope',
    agentGroupId: 'group',
    messagingGroupId: 'mg',
    sessionId: 'session',
    provider: 'codex',
    instanceId: 'fixture',
    channelId: 'private',
    ownerId: 'owner',
    botId: 'bot',
  };
  const session = {
    id: 'session',
    agent_group_id: 'group',
    messaging_group_id: 'mg',
    thread_id: null,
    status: 'active',
    agent_provider: 'codex',
  } as Session;
  installCosBoundary(binding, db);
  db.prepare('UPDATE cos_identity_boundaries SET paused=0, ingress_id=?, ingress_at=?').run(
    'ingress',
    new Date().toISOString(),
  );
  let authorization: string | null | undefined;
  const store = {
    context: vi.fn(async () => {
      db.exec('UPDATE cos_identity_boundaries SET paused=1');
      return { status: 'ok' };
    }),
  } as unknown as PriorityStore;
  runtime = createCosRuntime({
    db,
    enabled: true,
    store,
    facts: async () => ({
      id: 'private',
      type: 'P',
      delete_at: 0,
      members: ['bot', 'owner'],
      activeSubscription: true,
    }),
    session: () => session,
    destination: () => undefined,
    stop: vi.fn(),
    wake: vi.fn(),
    launcher: {
      ready: () => true,
      prepare: async (_binding, _session, authorize) => {
        authorization = await authorize();
        return {} as CosLaunch;
      },
    },
  });
  await expect(prepareCosLaunch(session)).rejects.toThrow('restricted_launch_denied');
  expect(store.context).toHaveBeenCalledOnce();
  expect(authorization).toBeNull();
});
