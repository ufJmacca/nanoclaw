import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { initTestDb, closeDb } from '../../../db/connection.js';
import { INBOUND_SCHEMA } from '../../../db/schema.js';
import { installCosBoundary, type CosBinding } from '../../../cos-boundary.js';
import type { Session } from '../../../types.js';
import type { Result } from '../domain/contracts.js';
import { NativeBriefTasks } from './native-tasks.js';
import { readScheduledLease, scheduledContext } from './scheduled-origin.js';
import { BriefDispatch } from './brief-dispatch.js';

const inputs: Database.Database[] = [];
afterEach(() => {
  for (const db of inputs.splice(0)) db.close();
  closeDb();
});
function fixture() {
  const db = initTestDb(),
    inbound = new Database(':memory:');
  inputs.push(inbound);
  inbound.exec(INBOUND_SCHEMA);
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
  db.exec("UPDATE cos_identity_boundaries SET paused=0,ingress_id='owner-before'");
  const run = {
    id: 'a'.repeat(64),
    schedule_id: 'schedule',
    schedule_version: 1,
    intended_at: new Date().toISOString(),
    state: 'queued',
    limits: { refresh_seconds: 0 },
    generation: 0,
    lease_owner: '',
    deadline_at: new Date(Date.now() + 120000).toISOString(),
  };
  const runs = {
    reserveDue: vi.fn(async (): Promise<Result> => ({ status: 'ok', run: { ...run } })),
    claim: vi.fn(async (_c, _r, host): Promise<Result> => {
      run.state = 'dispatched';
      run.generation = 1;
      run.lease_owner = host;
      return { status: 'ok', generation: 1, deadline_at: run.deadline_at };
    }),
    authorize: vi.fn(async (): Promise<Result> => ({ status: 'ok' })),
    cancel: vi.fn(async (): Promise<Result> => {
      run.state = 'cancelled';
      return { status: 'ok', state: 'cancelled' };
    }),
  };
  const tasks = new NativeBriefTasks(inbound),
    admitted = vi.fn(async () => true),
    running = vi.fn(() => false),
    wake = vi.fn(async () => {});
  const prepare = vi.fn(async () => true);
  const dependencies = {
    db,
    runs,
    session: () => session,
    admitted,
    running,
    wake,
    prepare,
    withTasks: async <T>(_session: Session, operation: (tasks: NativeBriefTasks) => Promise<T>) => operation(tasks),
  };
  return {
    db,
    inbound,
    binding,
    session,
    run,
    runs,
    tasks,
    admitted,
    running,
    wake,
    prepare,
    dependencies,
    dispatch: new BriefDispatch(dependencies),
  };
}
it('S04 reserves one run, stages a native task and reuses its lease and retry state after restart', async () => {
  const f = fixture();
  expect((await f.dispatch.drain(f.binding)).status).toBe('ok');
  expect(f.tasks.state(f.binding, f.run)).toBe('pending');
  expect(scheduledContext(f.session, f.db)?.origin).toEqual({ kind: 'schedule', runId: f.run.id, generation: 1 });
  const lease = readScheduledLease(f.db, f.binding);
  f.inbound.exec('UPDATE messages_in SET tries=2');
  await new BriefDispatch(f.dependencies).drain(f.binding);
  expect(readScheduledLease(f.db, f.binding)).toEqual(lease);
  expect(f.inbound.prepare('SELECT tries FROM messages_in').all()).toEqual([{ tries: 2 }]);
  expect(f.db.prepare('SELECT ingress_id FROM cos_identity_boundaries').get()).toEqual({ ingress_id: 'owner-before' });
});
it.each(['container', 'owner-message', 'admission'])('S04 defers to %s before reserving a run', async (kind) => {
  const f = fixture();
  if (kind === 'container') f.running.mockReturnValue(true);
  if (kind === 'admission') f.admitted.mockResolvedValue(false);
  if (kind === 'owner-message')
    f.inbound
      .prepare(
        "INSERT INTO messages_in(id,seq,kind,timestamp,content,trigger,status) VALUES('owner',1,'chat',?,'owner text',1,'pending')",
      )
      .run(new Date().toISOString());
  await f.dispatch.drain(f.binding);
  expect(f.runs.reserveDue).not.toHaveBeenCalled();
  expect(f.wake).not.toHaveBeenCalled();
  expect(readScheduledLease(f.db, f.binding)).toBeNull();
});
it.each(['claim', 'prepare', 'authorize'])('S04 owner ingress during %s prevents a scheduled wake', async (phase) => {
  const f = fixture();
  const change = () => f.db.exec("UPDATE cos_identity_boundaries SET ingress_id='new-owner'");
  if (phase === 'claim')
    f.runs.claim.mockImplementation(async (_c, _r, host) => {
      change();
      return { status: 'ok', generation: 1, deadline_at: f.run.deadline_at, lease_owner: host };
    });
  if (phase === 'prepare')
    f.prepare.mockImplementation(async () => {
      change();
      return true;
    });
  if (phase === 'authorize')
    f.runs.authorize.mockImplementation(async () => {
      change();
      return { status: 'ok' };
    });
  await f.dispatch.drain(f.binding);
  expect(f.wake).not.toHaveBeenCalled();
  expect(f.tasks.state(f.binding, f.run)).not.toBe('pending');
  expect(f.runs.cancel).toHaveBeenCalled();
});
it('S04 unknown claim acknowledgement creates no runnable native task or new local authority', async () => {
  const f = fixture();
  f.runs.claim.mockResolvedValue({ status: 'pending' });
  expect((await f.dispatch.drain(f.binding)).status).toBe('pending');
  expect(f.tasks.state(f.binding, f.run)).toBeNull();
  expect(readScheduledLease(f.db, f.binding)).toBeNull();
  expect(f.wake).not.toHaveBeenCalled();
});
it('S04 preparation failure and terminal native tasks cannot be bypassed by wake retries', async () => {
  const f = fixture();
  f.prepare.mockResolvedValue(false);
  await f.dispatch.drain(f.binding);
  expect(f.wake).not.toHaveBeenCalled();
  expect(f.runs.cancel).toHaveBeenCalled();
  f.prepare.mockResolvedValue(true);
  f.run.state = 'queued';
  f.tasks.stage(f.binding, f.run);
  f.tasks.cancel(f.binding, f.run);
  await f.dispatch.drain(f.binding);
  expect(f.wake).not.toHaveBeenCalled();
  expect(f.tasks.state(f.binding, f.run)).toBe('completed');
});
