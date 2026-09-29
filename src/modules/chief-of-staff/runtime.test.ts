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
