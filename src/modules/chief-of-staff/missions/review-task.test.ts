import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { INBOUND_SCHEMA } from '../../../db/schema.js';
import { countDueMessages } from '../../../db/session-db.js';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { NativeMissionReviewTasks } from './review-task.js';
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(INBOUND_SCHEMA);
  const binding: CosBinding = {
    scopeId: 'scope',
    ownerId: 'owner',
    agentGroupId: 'main-group',
    sessionId: 'main',
    messagingGroupId: 'mg',
    provider: 'codex',
    instanceId: 'fixture',
    channelId: 'private',
    botId: 'bot',
  };
  const identity = {
    missionId: 'mission',
    submissionId: randomUUID(),
    attemptId: randomUUID(),
    generation: 1,
    sessionId: 'main',
    contextGeneration: randomUUID(),
  };
  const task = {
    identity,
    inputId: 'cos-mission-review-' + digest({ scope: binding.scopeId, identity }),
    issuedAt: '2026-01-01T00:00:00.000Z',
  };
  return { db, binding, task, tasks: new NativeMissionReviewTasks(db) };
}
it('S05-T05/T11 stages one paused review task in the existing main inbox and keeps its retry identity', async () => {
  const f = fixture();
  expect(f.tasks.stage(f.binding, f.task)).toBe(f.task.inputId);
  expect(countDueMessages(f.db)).toBe(0);
  expect(new NativeMissionReviewTasks(f.db).stage(f.binding, f.task)).toBe(f.task.inputId);
  expect(f.db.prepare('SELECT count(*) AS n FROM messages_in').get()).toEqual({ n: 1 });
  expect(
    await f.tasks.activate(
      f.binding,
      f.task,
      async () => true,
      () => true,
    ),
  ).toBe(true);
  expect(countDueMessages(f.db)).toBe(1);
  const row = f.db.prepare('SELECT * FROM messages_in').get() as any;
  expect(row).toMatchObject({
    kind: 'task',
    platform_id: 'mattermost:fixture:private',
    thread_id: null,
    recurrence: null,
  });
  expect(JSON.parse(row.content)).toMatchObject({
    cosMissionReview: { missionId: f.task.identity.missionId, submissionId: f.task.identity.submissionId },
  });
  f.db.prepare("UPDATE messages_in SET status='completed'").run();
  expect(
    await f.tasks.activate(
      f.binding,
      f.task,
      async () => true,
      () => true,
    ),
  ).toBe(false);
  expect(f.tasks.retire(f.binding, f.task)).toBe(true);
  expect(
    await f.tasks.activate(
      f.binding,
      f.task,
      async () => true,
      () => true,
    ),
  ).toBe(false);
});
it('S05-T07 remote denial and owner preemption after an await keep the review task paused', async () => {
  const f = fixture();
  f.tasks.stage(f.binding, f.task);
  expect(
    await f.tasks.activate(
      f.binding,
      f.task,
      async () => false,
      () => true,
    ),
  ).toBe(false);
  expect(
    await f.tasks.activate(
      f.binding,
      f.task,
      async () => true,
      () => false,
    ),
  ).toBe(false);
  expect(countDueMessages(f.db)).toBe(0);
});
it('S05-T03 refuses changed identities or task bytes and never repurposes a foreign inbox row', () => {
  const f = fixture();
  expect(f.tasks.stage(f.binding, { ...f.task, identity: { ...f.task.identity, sessionId: 'specialist' } })).toBeNull();
  f.tasks.stage(f.binding, f.task);
  f.db.prepare("UPDATE messages_in SET content='tampered'").run();
  expect(f.tasks.stage(f.binding, f.task)).toBeNull();
  expect(f.tasks.retire(f.binding, f.task)).toBe(false);
});
