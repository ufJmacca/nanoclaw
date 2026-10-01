import { afterEach, expect, it, vi } from 'vitest';
import { initTestDb, closeDb } from '../../../db/connection.js';
import { installCosBoundary, type CosBinding } from '../../../cos-boundary.js';
import type { Session } from '../../../types.js';
import type { Result } from '../domain/contracts.js';
import {
  installScheduledOrigin,
  readScheduledLease,
  scheduledContext,
  interruptScheduledOrigin,
} from './scheduled-origin.js';
import { BriefReconciliation } from './brief-reconciliation.js';

afterEach(closeDb);
function fixture() {
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
  db.exec('UPDATE cos_identity_boundaries SET paused=0');
  const lease = {
    runId: 'a'.repeat(64),
    generation: 1,
    hostId: 'host',
    deadlineAt: new Date(Date.now() + 120000).toISOString(),
  };
  expect(installScheduledOrigin(db, binding, session, lease)).toBe(true);
  const run = {
    id: lease.runId,
    generation: 1,
    lease_owner: 'host',
    state: 'prepared',
    schedule_id: 'schedule',
    schedule_version: 1,
    intended_at: new Date().toISOString(),
  };
  const notification = { state: 'queued', attempt_id: 'attempt' };
  const runs = {
    inspect: vi.fn(async (): Promise<Result> => ({ status: 'ok', run: { ...run }, notification: { ...notification } })),
    authorize: vi.fn(async (): Promise<Result> => ({ status: 'ok' })),
    cancel: vi.fn(async (): Promise<Result> => {
      run.state = 'cancelled';
      return { status: 'ok', state: 'cancelled' };
    }),
    finishDelivery: vi.fn(async (): Promise<Result> => {
      run.state = 'uncertain';
      return { status: 'ok', state: 'uncertain' };
    }),
  };
  const local = () => {
    const c = scheduledContext(session, db);
    return c ? { ...c, provider: 'codex', generation: 'native-generation' } : null;
  };
  const deliver = vi.fn(async (): Promise<Result> => {
    run.state = 'delivered';
    return { status: 'ok', state: 'delivered' };
  });
  const admitted = vi.fn(async () => true),
    running = vi.fn(() => false),
    stop = vi.fn(),
    retire = vi.fn(() => true),
    taskState = vi.fn(() => 'pending' as string | null);
  const reconciliation = new BriefReconciliation({
    db,
    runs,
    local,
    admitted,
    running,
    stop,
    retire,
    taskState,
    deliver,
  });
  return {
    db,
    binding,
    lease,
    run,
    notification,
    runs,
    deliver,
    admitted,
    running,
    stop,
    retire,
    taskState,
    reconciliation,
  };
}
it('S04 reconciles an orphaned delivery as uncertain without resending after restart', async () => {
  const f = fixture();
  f.notification.state = 'delivering';
  await f.reconciliation.drain(f.binding);
  expect(f.runs.finishDelivery).toHaveBeenCalledWith(expect.anything(), f.lease.runId, 1, 'attempt', {
    state: 'uncertain',
  });
  expect(f.deliver).not.toHaveBeenCalled();
  expect(f.retire).toHaveBeenCalled();
  expect(readScheduledLease(f.db, f.binding)).toBeNull();
});
it('S04 owner preemption cancels durable work before retiring the task and clearing the fence', async () => {
  const f = fixture();
  interruptScheduledOrigin(f.db, f.binding);
  f.running.mockReturnValue(true);
  await f.reconciliation.drain(f.binding);
  expect(f.runs.cancel).toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledWith('session');
  expect(readScheduledLease(f.db, f.binding)).toEqual(f.lease);
  expect(f.deliver).not.toHaveBeenCalled();
  f.running.mockReturnValue(false);
  await f.reconciliation.drain(f.binding);
  expect(readScheduledLease(f.db, f.binding)).toBeNull();
});
it('S04 database uncertainty preserves the local fence and stops the old worker', async () => {
  const f = fixture();
  f.runs.inspect.mockResolvedValue({ status: 'unavailable' });
  await f.reconciliation.drain(f.binding);
  expect(f.stop).toHaveBeenCalledWith('session');
  expect(f.retire).not.toHaveBeenCalled();
  expect(f.deliver).not.toHaveBeenCalled();
  expect(readScheduledLease(f.db, f.binding)).toEqual(f.lease);
});
it('S04 serializes overlapping pumps so an active send is not mistaken for a crashed sender', async () => {
  const f = fixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.deliver.mockImplementation(async () => {
    f.notification.state = 'delivering';
    await pending;
    f.run.state = 'delivered';
    return { status: 'ok', state: 'delivered' };
  });
  const first = f.reconciliation.drain(f.binding);
  await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledOnce());
  await f.reconciliation.drain(f.binding);
  expect(f.runs.finishDelivery).not.toHaveBeenCalled();
  release();
  await first;
  await f.reconciliation.drain(f.binding);
  expect(f.deliver).toHaveBeenCalledOnce();
  expect(readScheduledLease(f.db, f.binding)).toBeNull();
});
it('S04 unresolved task ownership and cancellation acknowledgements keep the fence', async () => {
  const f = fixture();
  f.admitted.mockResolvedValue(false);
  f.runs.cancel.mockResolvedValue({ status: 'pending' });
  await f.reconciliation.drain(f.binding);
  expect(f.retire).not.toHaveBeenCalled();
  expect(readScheduledLease(f.db, f.binding)).toEqual(f.lease);
  f.run.state = 'cancelled';
  f.retire.mockReturnValue(false);
  await f.reconciliation.drain(f.binding);
  expect(readScheduledLease(f.db, f.binding)).toEqual(f.lease);
});
it('S04 a completed native turn without a checked brief does not invent successful delivery', async () => {
  const f = fixture();
  f.run.state = 'dispatched';
  f.taskState.mockReturnValue('completed');
  await f.reconciliation.drain(f.binding);
  expect(f.runs.cancel).toHaveBeenCalled();
  expect(f.deliver).not.toHaveBeenCalled();
  expect(readScheduledLease(f.db, f.binding)).toBeNull();
});
