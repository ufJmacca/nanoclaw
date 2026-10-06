import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { closeDb, getDb, initReadOnlyDb, initOwnerControlDb } from './connection.js';
const roots: string[] = [];
afterEach(() => {
  closeDb();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('S11 owner deny connection cannot create native state and opens no new ordinary schema', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-owner-deny-'));
  roots.push(root);
  const absent = path.join(root, 'absent.db');
  expect(() => initOwnerControlDb(absent)).toThrow();
  expect(fs.existsSync(absent)).toBe(false);
  const file = path.join(root, 'native.db'),
    seed = new Database(file);
  seed.exec("CREATE TABLE ordinary_messages(id TEXT);INSERT INTO ordinary_messages VALUES('protected-message')");
  seed.close();
  const db = initOwnerControlDb(file);
  expect(getDb()).toBe(db);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([
    { name: 'ordinary_messages' },
  ]);
  expect(db.prepare('SELECT id FROM ordinary_messages').all()).toEqual([{ id: 'protected-message' }]);
  expect(() => initOwnerControlDb(file)).toThrow('native_database_already_open');
});
it('S11 owner inspection uses native identity readers without creating, migrating or mutating SQLite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-owner-readonly-'));
  roots.push(root);
  const file = path.join(root, 'native.db');
  const seed = new Database(file);
  seed.exec("CREATE TABLE ordinary_messages(id TEXT);INSERT INTO ordinary_messages VALUES('protected-message')");
  seed.close();
  const before = fs.readFileSync(file);
  const db = initReadOnlyDb(file);
  expect(getDb()).toBe(db);
  expect(db.prepare('SELECT id FROM ordinary_messages').all()).toEqual([{ id: 'protected-message' }]);
  expect(() => db.exec('DELETE FROM ordinary_messages')).toThrow();
  expect(() => initReadOnlyDb(file)).toThrow('native_database_already_open');
  closeDb();
  expect(fs.readFileSync(file)).toEqual(before);
  const absent = path.join(root, 'absent.db');
  expect(() => initReadOnlyDb(absent)).toThrow();
  expect(fs.existsSync(absent)).toBe(false);
});
