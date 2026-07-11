import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'host-execution-lease',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE host_execution_lease (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        owner_id     TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
        pid          INTEGER NOT NULL CHECK (pid > 0),
        acquired_at  TEXT NOT NULL
      );
    `);
  },
};
