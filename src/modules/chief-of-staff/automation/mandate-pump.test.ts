import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { INBOUND_SCHEMA } from '../../../db/schema.js';
import { countDueMessages } from '../../../db/session-db.js';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { NativeMandateTasks } from './mandate-native.js';
import { MandatePump } from './mandate-pump.js';
const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
const binding: CosBinding = {
  scopeId: 'scope',
  ownerId: 'owner',
  sessionId: 'session',
  agentGroupId: 'group',
  messagingGroupId: 'mg',
  instanceId: 'fixture',
  channelId: 'private',
  botId: 'bot',
  provider: 'codex',
};
function fixture() {
  const db = new Database(':memory:');
  dbs.push(db);
  db.exec(INBOUND_SCHEMA);
  const tasks = new NativeMandateTasks(db);
  const head = {
    id: 'mandate-' + 'a'.repeat(64),
    revision: 1,
    state: 'active',
    eligible: true,
    sourceDigest: digest('approved source revisions'),
    wake: { mandateId: 'mandate-' + 'a'.repeat(64), revision: 1, wakeAt: '2026-10-04T08:00:00.000Z' },
    now: '2026-10-04T07:00:00.000Z',
  };
  const store = {
    headsForHost: vi.fn(async () => ({ status: 'ok' as const, heads: [head], next_after: null })),
    bindNative: vi.fn(async () => ({ status: 'ok' as const })),
    evaluate: vi.fn(async () => ({
      status: 'ok' as const,
      decision: 'no_matching_meeting',
      mission_ids: [],
      next_wake_at: head.wake.wakeAt,
    })),
  };
  let active = true;
  const dependencies = {
    store,
    current: () => active,
    admitted: async () => active,
    withTasks: <T>(_binding: CosBinding, operation: (value: NativeMandateTasks) => T) => operation(tasks),
  };
  return {
    db,
    tasks,
    head,
    store,
    dependencies,
    pause: () => {
      active = false;
    },
  };
}
it('S08-T08/T09 source changes evaluate once without waking a model; unchanged future clock remains quiet across restart', async () => {
  const f = fixture();
  const pump = new MandatePump(f.dependencies);
  expect((await pump.drain(binding)).status).toBe('ok');
  expect(f.store.evaluate).toHaveBeenCalledTimes(1);
  expect(countDueMessages(f.db)).toBe(0);
  expect((await new MandatePump(f.dependencies).drain(binding)).status).toBe('ok');
  expect(f.store.evaluate).toHaveBeenCalledTimes(1);
  f.head.sourceDigest = digest('new selected source revision');
  await pump.drain(binding);
  expect(f.store.evaluate).toHaveBeenCalledTimes(2);
  expect(countDueMessages(f.db)).toBe(0);
});
it('S08-PG01 native repair cannot bypass a failed PostgreSQL grant or create model work', async () => {
  const f = fixture();
  f.store.bindNative.mockResolvedValue({ status: 'denied' } as never);
  await new MandatePump(f.dependencies).drain(binding);
  expect(f.store.evaluate).not.toHaveBeenCalled();
  expect(countDueMessages(f.db)).toBe(0);
});
it('S08-PG02 a local emergency pause wins over awaited inventory and persists on reconnect', async () => {
  const f = fixture();
  f.store.headsForHost.mockImplementation(async () => {
    f.pause();
    return { status: 'ok', heads: [f.head], next_after: null };
  });
  await new MandatePump(f.dependencies).drain(binding);
  await new MandatePump(f.dependencies).drain(binding);
  expect(f.store.bindNative).not.toHaveBeenCalled();
  expect(f.store.evaluate).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT count(*) AS n FROM messages_in').get()).toEqual({ n: 0 });
});
