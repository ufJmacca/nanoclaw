import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { INBOUND_SCHEMA } from '../../../db/schema.js';
import { countDueMessages } from '../../../db/session-db.js';
import type { CosBinding } from '../../../cos-boundary.js';
import { NativeMandateTasks } from './mandate-native.js';
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
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
const wake = { mandateId: 'mandate-' + 'a'.repeat(64), revision: 1, wakeAt: '2026-10-04T08:00:00.000Z' };
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(INBOUND_SCHEMA);
  return { db, tasks: new NativeMandateTasks(db) };
}
it('S08-T08/T09 native mandate clocks remain model-free and survive restart without modifying ordinary messages', () => {
  const { db, tasks } = fixture();
  db.prepare(
    "INSERT INTO messages_in(id,seq,timestamp,status,tries,kind,content) VALUES('ordinary',1,'2026-10-04T00:00:00Z','completed',0,'chat','private ordinary message')",
  ).run();
  const original = db.prepare("SELECT * FROM messages_in WHERE id='ordinary'").get();
  const id = tasks.stage(binding, wake);
  expect(id).toMatch(/^cos-mandate-[a-f0-9]{64}$/);
  expect(countDueMessages(db)).toBe(0);
  expect(tasks.due(binding, wake, '2026-10-04T07:59:59Z')).toBe(false);
  expect(tasks.due(binding, wake, '2026-10-04T08:00:00Z')).toBe(true);
  expect(new NativeMandateTasks(db).stage(binding, wake)).toBe(id);
  expect(new NativeMandateTasks(db).current(binding, wake)).toBe(true);
  expect(db.prepare("SELECT * FROM messages_in WHERE id='ordinary'").get()).toEqual(original);
});
it('S08-T08 a terminal, altered or foreign native row cannot repair itself into current authority', () => {
  const { db, tasks } = fixture();
  const id = tasks.stage(binding, wake);
  expect(id).toBeTruthy();
  expect(tasks.current({ ...binding, ownerId: 'foreign' }, wake)).toBe(false);
  db.prepare("UPDATE messages_in SET content='forged executable prompt' WHERE id=?").run(id);
  expect(tasks.current(binding, wake)).toBe(false);
  expect(tasks.stage(binding, wake)).toBeNull();
  const second = { ...wake, wakeAt: '2026-10-05T08:00:00.000Z' };
  expect(tasks.stage(binding, second)).toBeTruthy();
  expect(tasks.retire(binding, second)).toBe(true);
  expect(tasks.stage(binding, second)).toBeNull();
  expect(tasks.due(binding, second, '2026-10-06T08:00:00Z')).toBe(false);
  expect(countDueMessages(db)).toBe(0);
});
