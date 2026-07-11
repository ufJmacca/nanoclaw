import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import {
  classifyMattermostReceiptRetention,
  getMattermostReceiptRetentionFloor,
  MATTERMOST_COMPLETED_RECEIPT_RETENTION_LIMIT,
  pruneMattermostCompletedPostReceipts,
} from './mattermost-receipt-retention.js';

function insertReceipt(input: {
  instanceKey: string;
  channelId: string;
  postId: string;
  createAt: number;
  status?: 'processing' | 'completed';
}): void {
  const status = input.status ?? 'completed';
  getDb()
    .prepare(
      `INSERT INTO mattermost_post_receipts (
         instance_key, post_id, channel_id, create_at, payload_digest,
         status, claimed_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.instanceKey,
      input.postId,
      input.channelId,
      input.createAt,
      `digest-${input.postId}`,
      status,
      '2026-07-11T00:00:00.000Z',
      status === 'completed' ? '2026-07-11T00:00:01.000Z' : null,
    );
}

beforeEach(() => {
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
});

describe('Mattermost receipt retention', () => {
  it('classifies only posts strictly below an unknown-channel floor as retired', () => {
    const db = getDb();
    const key = { instanceKey: 'primary', channelId: 'unknown-channel-a' };

    expect(getMattermostReceiptRetentionFloor(db, key)).toBeNull();
    expect(classifyMattermostReceiptRetention(db, { ...key, createAt: 99 })).toBe('current');
    db.prepare(
      `INSERT INTO mattermost_receipt_retention_floors (
         instance_key, channel_id, reject_before_create_at, updated_at
       ) VALUES (?, ?, ?, ?)`,
    ).run(key.instanceKey, key.channelId, 100, '2026-07-11T00:00:00.000Z');

    expect(getMattermostReceiptRetentionFloor(db, key)).toBe(100);
    expect(classifyMattermostReceiptRetention(db, { ...key, createAt: 99 })).toBe('retired');
    expect(classifyMattermostReceiptRetention(db, { ...key, createAt: 100 })).toBe('current');
    expect(classifyMattermostReceiptRetention(db, { ...key, createAt: 101 })).toBe('current');
    expect(
      classifyMattermostReceiptRetention(db, {
        instanceKey: 'secondary',
        channelId: key.channelId,
        createAt: 99,
      }),
    ).toBe('current');
    expect(
      classifyMattermostReceiptRetention(db, {
        instanceKey: key.instanceKey,
        channelId: 'unknown-channel-b',
        createAt: 99,
      }),
    ).toBe('current');
  });

  it('retains 10000 completed receipts plus the full boundary timestamp cohort', () => {
    const db = getDb();
    const key = { instanceKey: 'primary', channelId: 'unknown-channel-a' };
    db.transaction(() => {
      for (let index = 0; index < MATTERMOST_COMPLETED_RECEIPT_RETENTION_LIMIT - 1; index += 1) {
        insertReceipt({
          ...key,
          postId: `newer-${String(index).padStart(5, '0')}`,
          createAt: 1_000 + index,
        });
      }
      for (const postId of ['boundary-z', 'boundary-a', 'boundary-m']) {
        insertReceipt({ ...key, postId, createAt: 100 });
      }
      insertReceipt({ ...key, postId: 'older-99', createAt: 99 });
      insertReceipt({ ...key, postId: 'older-98', createAt: 98 });
      insertReceipt({ instanceKey: 'primary', channelId: 'unknown-channel-b', postId: 'foreign-b', createAt: 1 });
      insertReceipt({ instanceKey: 'secondary', channelId: key.channelId, postId: 'foreign-instance', createAt: 1 });
    })();

    expect(pruneMattermostCompletedPostReceipts(db, key, '2026-07-11T01:00:00.000Z')).toEqual({
      rejectBeforeCreateAt: 100,
      floorAdvanced: true,
      deletedCompleted: 2,
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count, MIN(create_at) AS oldest
             FROM mattermost_post_receipts
            WHERE instance_key = ? AND channel_id = ? AND status = 'completed'`,
        )
        .get(key.instanceKey, key.channelId),
    ).toEqual({ count: MATTERMOST_COMPLETED_RECEIPT_RETENTION_LIMIT + 2, oldest: 100 });
    expect(
      db
        .prepare(
          `SELECT post_id
             FROM mattermost_post_receipts
            WHERE instance_key = ? AND channel_id = ? AND create_at = 100
            ORDER BY post_id`,
        )
        .all(key.instanceKey, key.channelId),
    ).toEqual([{ post_id: 'boundary-a' }, { post_id: 'boundary-m' }, { post_id: 'boundary-z' }]);
    expect(classifyMattermostReceiptRetention(db, { ...key, createAt: 99 })).toBe('retired');
    expect(classifyMattermostReceiptRetention(db, { ...key, createAt: 100 })).toBe('current');
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM mattermost_post_receipts WHERE post_id LIKE 'foreign-%'").get(),
    ).toEqual({ count: 2 });
  });

  it('clamps the floor at the oldest processing receipt and never deletes processing work', () => {
    const db = getDb();
    const key = { instanceKey: 'primary', channelId: 'pending-channel-a' };
    db.transaction(() => {
      for (let index = 0; index < MATTERMOST_COMPLETED_RECEIPT_RETENTION_LIMIT - 1; index += 1) {
        insertReceipt({
          ...key,
          postId: `processing-newer-${String(index).padStart(5, '0')}`,
          createAt: 1_000 + index,
        });
      }
      insertReceipt({ ...key, postId: 'boundary-100-z', createAt: 100 });
      insertReceipt({ ...key, postId: 'boundary-100-a', createAt: 100 });
      insertReceipt({ ...key, postId: 'completed-60', createAt: 60 });
      insertReceipt({ ...key, postId: 'processing-50', createAt: 50, status: 'processing' });
      insertReceipt({ ...key, postId: 'completed-49', createAt: 49 });
    })();

    expect(pruneMattermostCompletedPostReceipts(db, key, '2026-07-11T01:00:00.000Z')).toEqual({
      rejectBeforeCreateAt: 50,
      floorAdvanced: true,
      deletedCompleted: 1,
    });
    expect(
      db
        .prepare(
          `SELECT post_id, status
             FROM mattermost_post_receipts
            WHERE instance_key = ? AND channel_id = ? AND create_at <= 60
            ORDER BY create_at DESC`,
        )
        .all(key.instanceKey, key.channelId),
    ).toEqual([
      { post_id: 'completed-60', status: 'completed' },
      { post_id: 'processing-50', status: 'processing' },
    ]);
    expect(classifyMattermostReceiptRetention(db, { ...key, createAt: 49 })).toBe('retired');
    expect(classifyMattermostReceiptRetention(db, { ...key, createAt: 50 })).toBe('current');
  });

  it('rolls back the floor when completed receipt deletion fails', () => {
    const db = getDb();
    const key = { instanceKey: 'primary', channelId: 'rollback-channel-a' };
    db.transaction(() => {
      for (let index = 0; index < MATTERMOST_COMPLETED_RECEIPT_RETENTION_LIMIT - 1; index += 1) {
        insertReceipt({
          ...key,
          postId: `rollback-newer-${String(index).padStart(5, '0')}`,
          createAt: 1_000 + index,
        });
      }
      insertReceipt({ ...key, postId: 'rollback-boundary-z', createAt: 100 });
      insertReceipt({ ...key, postId: 'rollback-boundary-a', createAt: 100 });
      insertReceipt({ ...key, postId: 'rollback-older', createAt: 99 });
    })();
    db.exec(`
      CREATE TRIGGER fail_mattermost_receipt_prune
      BEFORE DELETE ON mattermost_post_receipts
      WHEN OLD.instance_key = 'primary' AND OLD.channel_id = 'rollback-channel-a'
      BEGIN
        SELECT RAISE(ABORT, 'injected receipt prune failure');
      END;
    `);

    expect(() => pruneMattermostCompletedPostReceipts(db, key, '2026-07-11T01:00:00.000Z')).toThrow(
      'injected receipt prune failure',
    );
    expect(getMattermostReceiptRetentionFloor(db, key)).toBeNull();
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM mattermost_post_receipts
            WHERE instance_key = ? AND channel_id = ?`,
        )
        .get(key.instanceKey, key.channelId),
    ).toEqual({ count: MATTERMOST_COMPLETED_RECEIPT_RETENTION_LIMIT + 2 });
    expect(db.prepare("SELECT 1 FROM mattermost_post_receipts WHERE post_id = 'rollback-older'").get()).toEqual({
      '1': 1,
    });
  });
});
