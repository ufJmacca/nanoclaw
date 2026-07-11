import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration018: Migration = {
  version: 18,
  name: 'mattermost-receipt-retention',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE mattermost_receipt_retention_floors (
        instance_key            TEXT NOT NULL,
        channel_id              TEXT NOT NULL,
        reject_before_create_at INTEGER NOT NULL CHECK (reject_before_create_at >= 0),
        updated_at              TEXT NOT NULL,
        PRIMARY KEY (instance_key, channel_id)
      );
    `);
  },
};
