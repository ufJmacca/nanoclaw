import type Database from 'better-sqlite3';

export const MATTERMOST_COMPLETED_RECEIPT_RETENTION_LIMIT = 50 * 200;

export type MattermostReceiptRetentionClassification = 'current' | 'retired';

export interface MattermostReceiptRetentionKey {
  instanceKey: string;
  channelId: string;
}

export interface MattermostReceiptRetentionCandidate extends MattermostReceiptRetentionKey {
  createAt: number;
}

export interface MattermostReceiptPruneResult {
  rejectBeforeCreateAt: number | null;
  floorAdvanced: boolean;
  deletedCompleted: number;
}

export function getMattermostReceiptRetentionFloor(
  db: Database.Database,
  key: MattermostReceiptRetentionKey,
): number | null {
  const row = db
    .prepare(
      `SELECT reject_before_create_at
         FROM mattermost_receipt_retention_floors
        WHERE instance_key = ? AND channel_id = ?`,
    )
    .get(key.instanceKey, key.channelId) as { reject_before_create_at: number } | undefined;
  return row?.reject_before_create_at ?? null;
}

export function classifyMattermostReceiptRetention(
  db: Database.Database,
  candidate: MattermostReceiptRetentionCandidate,
): MattermostReceiptRetentionClassification {
  const floor = getMattermostReceiptRetentionFloor(db, candidate);
  return floor !== null && candidate.createAt < floor ? 'retired' : 'current';
}

export function pruneMattermostCompletedPostReceipts(
  db: Database.Database,
  key: MattermostReceiptRetentionKey,
  updatedAt = new Date().toISOString(),
): MattermostReceiptPruneResult {
  return db
    .transaction(() => {
      const boundaryRows = db
        .prepare(
          `SELECT create_at
             FROM mattermost_post_receipts
            WHERE instance_key = ? AND channel_id = ? AND status = 'completed'
            ORDER BY create_at DESC, post_id DESC
            LIMIT 2 OFFSET ?`,
        )
        .all(key.instanceKey, key.channelId, MATTERMOST_COMPLETED_RECEIPT_RETENTION_LIMIT - 1) as Array<{
        create_at: number;
      }>;
      const currentFloor = getMattermostReceiptRetentionFloor(db, key);
      let candidateFloor = boundaryRows.length === 2 ? boundaryRows[0]?.create_at : undefined;
      if (candidateFloor !== undefined) {
        const processing = db
          .prepare(
            `SELECT MIN(create_at) AS oldest
               FROM mattermost_post_receipts
              WHERE instance_key = ? AND channel_id = ? AND status = 'processing'`,
          )
          .get(key.instanceKey, key.channelId) as { oldest: number | null };
        if (processing.oldest !== null) candidateFloor = Math.min(candidateFloor, processing.oldest);
      }
      let floorAdvanced = false;
      if (candidateFloor !== undefined && (currentFloor === null || candidateFloor > currentFloor)) {
        const advanced = db
          .prepare(
            `INSERT INTO mattermost_receipt_retention_floors (
               instance_key, channel_id, reject_before_create_at, updated_at
             ) VALUES (?, ?, ?, ?)
             ON CONFLICT(instance_key, channel_id) DO UPDATE SET
               reject_before_create_at = excluded.reject_before_create_at,
               updated_at = excluded.updated_at
             WHERE excluded.reject_before_create_at >
                   mattermost_receipt_retention_floors.reject_before_create_at`,
          )
          .run(key.instanceKey, key.channelId, candidateFloor, updatedAt);
        floorAdvanced = advanced.changes === 1;
      }
      const rejectBeforeCreateAt = getMattermostReceiptRetentionFloor(db, key);
      const deletedCompleted =
        rejectBeforeCreateAt === null
          ? 0
          : db
              .prepare(
                `DELETE FROM mattermost_post_receipts
                  WHERE instance_key = ? AND channel_id = ?
                    AND status = 'completed' AND create_at < ?`,
              )
              .run(key.instanceKey, key.channelId, rejectBeforeCreateAt).changes;
      return { rejectBeforeCreateAt, floorAdvanced, deletedCompleted };
    })
    .immediate();
}
