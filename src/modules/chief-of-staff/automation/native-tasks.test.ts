import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { INBOUND_SCHEMA } from '../../../db/schema.js';
import { countDueMessages } from '../../../db/session-db.js';
import { insertTask } from '../../scheduling/db.js';
import type { CosBinding } from '../../../cos-boundary.js';
import { NativeBriefTasks } from './native-tasks.js';
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const binding = {
  scopeId: 'scope',
  ownerId: 'owner',
  sessionId: 'session',
  agentGroupId: 'group',
  messagingGroupId: 'mg',
  instanceId: 'fixture',
  channelId: 'private',
  botId: 'bot',
  provider: 'codex',
} as CosBinding;
const run = {
  id: 'a'.repeat(64),
  schedule_id: 'schedule',
  schedule_version: 2,
  intended_at: '2026-01-01T09:00:00.000Z',
};
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(INBOUND_SCHEMA);
  return { db, tasks: new NativeBriefTasks(db) };
}
it('S04 stages one native task paused and preserves its identity and retry state across restart', async () => {
  const { db, tasks } = fixture();
  const staged = tasks.stage(binding, run);
  expect(staged).toBe(`cos-brief-${run.id}`);
  expect(countDueMessages(db)).toBe(0);
  expect(db.prepare("SELECT count(*) AS n FROM messages_in WHERE status='pending'").get()).toEqual({ n: 0 });
  expect(new NativeBriefTasks(db).stage(binding, run)).toBe(staged);
  expect(db.prepare('SELECT count(*) AS n FROM messages_in').get()).toEqual({ n: 1 });
  expect(
    await tasks.activate(
      binding,
      run,
      async () => false,
      () => true,
    ),
  ).toBe(false);
  expect(countDueMessages(db)).toBe(0);
  expect(
    await tasks.activate(
      binding,
      run,
      async () => true,
      () => true,
    ),
  ).toBe(true);
  expect(countDueMessages(db)).toBe(1);
  db.prepare('UPDATE messages_in SET tries=2').run();
  expect(new NativeBriefTasks(db).stage(binding, run)).toBe(staged);
  expect(db.prepare('SELECT tries,status,recurrence,series_id FROM messages_in').get()).toEqual({
    tries: 2,
    status: 'pending',
    recurrence: null,
    series_id: staged,
  });
  db.prepare("UPDATE messages_in SET status='completed'").run();
  expect(
    await tasks.activate(
      binding,
      run,
      async () => true,
      () => true,
    ),
  ).toBe(false);
  expect(countDueMessages(db)).toBe(0);
});
it('S04 retirement tolerates a pre-staging crash and preserves foreign task collisions', () => {
  const { db, tasks } = fixture();
  expect(tasks.retire(binding, run)).toBe(true);
  expect(tasks.stage(binding, run)).toBeTruthy();
  expect(tasks.retire(binding, run)).toBe(true);
  expect(tasks.state(binding, run)).toBe('completed'); // Native cancellation uses completed; CoS retains its distinct outcome.
  db.prepare("UPDATE messages_in SET content='foreign' WHERE id=?").run(`cos-brief-${run.id}`);
  expect(tasks.retire(binding, run)).toBe(false);
  expect(db.prepare('SELECT content FROM messages_in').get()).toEqual({ content: 'foreign' });
});
it('S04 rejects changed payloads, foreign bindings and unrelated native task collisions', async () => {
  const { db, tasks } = fixture();
  insertTask(db, {
    id: `cos-brief-${run.id}`,
    processAfter: run.intended_at,
    recurrence: null,
    platformId: null,
    channelType: null,
    threadId: null,
    content: '{"prompt":"unrelated"}',
  });
  expect(tasks.stage(binding, run)).toBeNull();
  expect(tasks.cancel(binding, run)).toBe(false);
  expect(countDueMessages(db)).toBe(1);
  const second = { ...run, id: 'b'.repeat(64) };
  expect(tasks.stage(binding, second)).toBeTruthy();
  expect(tasks.stage({ ...binding, ownerId: 'foreign' }, second)).toBeNull();
  expect(tasks.stage(binding, { ...second, schedule_version: 3 })).toBeNull();
  db.prepare('UPDATE messages_in SET content=? WHERE id=?').run('{"prompt":"tampered"}', `cos-brief-${second.id}`);
  const authorize = vi.fn().mockResolvedValue(true);
  expect(await tasks.activate(binding, second, authorize, () => true)).toBe(false);
  expect(authorize).not.toHaveBeenCalled();
  expect(tasks.cancel(binding, second)).toBe(false);
});
it('S04 fences pause or cancellation during admission and cancels only its own task', async () => {
  const { db, tasks } = fixture();
  tasks.stage(binding, run);
  let local = true;
  expect(
    await tasks.activate(
      binding,
      run,
      async () => {
        local = false;
        return true;
      },
      () => local,
    ),
  ).toBe(false);
  expect(countDueMessages(db)).toBe(0);
  expect(
    await tasks.activate(
      binding,
      run,
      async () => {
        throw Error('database unavailable');
      },
      () => true,
    ),
  ).toBe(false);
  expect(
    await tasks.activate(
      binding,
      run,
      async () => {
        tasks.cancel(binding, run);
        return true;
      },
      () => true,
    ),
  ).toBe(false);
  expect(tasks.cancel(binding, run)).toBe(true);
  expect(tasks.state(binding, run)).toBe('completed');
  const next = { ...run, id: 'c'.repeat(64) };
  tasks.stage(binding, next);
  expect(
    await tasks.activate(
      binding,
      next,
      async () => true,
      () => true,
    ),
  ).toBe(true);
  expect(tasks.pause(binding, next)).toBe(true);
  expect(tasks.state(binding, next)).toBe('paused');
  expect(countDueMessages(db)).toBe(0);
});
