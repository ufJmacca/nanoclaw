import { getDb } from '../../../db/connection.js';

const PRISTINE_PENDING_BOUNDARY_SQL = `
  NOT EXISTS (
    SELECT 1 FROM mattermost_subscriptions ms
     WHERE (ms.instance_key = pending_mattermost_channel_approvals.instance_key
            AND ms.channel_id = pending_mattermost_channel_approvals.channel_id)
        OR ms.messaging_group_id = pending_mattermost_channel_approvals.messaging_group_id
  )
  AND EXISTS (
    SELECT 1 FROM messaging_groups mg
     WHERE mg.id = pending_mattermost_channel_approvals.messaging_group_id
       AND mg.channel_type = 'mattermost'
       AND mg.platform_id = 'mattermost:' || pending_mattermost_channel_approvals.instance_key || ':' || pending_mattermost_channel_approvals.channel_id
       AND mg.is_group = 1
       AND mg.unknown_sender_policy = 'request_approval'
       AND mg.denied_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM messaging_group_agents mga WHERE mga.messaging_group_id = mg.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM sessions s WHERE s.messaging_group_id = mg.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM agent_destinations ad
          WHERE ad.target_type = 'channel' AND ad.target_id = mg.id
       )
  )`;

export interface PendingMattermostChannelApproval {
  approval_id: string;
  instance_key: string;
  channel_id: string;
  messaging_group_id: string;
  requester_user_id: string;
  approver_user_id: string;
  original_message: string;
  status: 'pending' | 'processing' | 'completed' | 'rejected';
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  replayed_at: string | null;
  title: string;
  options_json: string;
}

export type MattermostApprovalRecoveryQuarantineReason =
  | 'invalid_stored_event'
  | 'event_identity_mismatch'
  | 'non_pristine_placeholder'
  | 'orphan_workspace_identity'
  | 'invalid_subscription_topology'
  | 'unsafe_subscription_filesystem'
  | 'invalid_session_topology'
  | 'message_identity_collision'
  | 'bot_membership_absent';

export function createPendingMattermostChannelApproval(row: PendingMattermostChannelApproval): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO pending_mattermost_channel_approvals (
         approval_id, instance_key, channel_id, messaging_group_id,
         requester_user_id, approver_user_id, original_message, status,
         created_at, title, options_json
       ) SELECT
         @approval_id, @instance_key, @channel_id, @messaging_group_id,
         @requester_user_id, @approver_user_id, @original_message, @status,
         @created_at, @title, @options_json
       WHERE EXISTS (
         SELECT 1
           FROM messaging_groups mg
          WHERE mg.id = @messaging_group_id
            AND mg.channel_type = 'mattermost'
            AND mg.platform_id = 'mattermost:' || @instance_key || ':' || @channel_id
            AND mg.is_group = 1
            AND mg.unknown_sender_policy = 'request_approval'
            AND mg.denied_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM messaging_group_agents mga
               WHERE mga.messaging_group_id = mg.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM sessions s WHERE s.messaging_group_id = mg.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM agent_destinations ad
               WHERE ad.target_type = 'channel' AND ad.target_id = mg.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM mattermost_subscriptions ms
               WHERE (ms.instance_key = @instance_key AND ms.channel_id = @channel_id)
                  OR ms.messaging_group_id = mg.id
            )
       )`,
    )
    .run(row);
  return result.changes === 1;
}

export function hasPendingMattermostChannelApproval(instanceKey: string, channelId: string): boolean {
  return (
    getDb()
      .prepare(
        `SELECT 1
           FROM pending_mattermost_channel_approvals
          WHERE instance_key = ? AND channel_id = ?`,
      )
      .get(instanceKey, channelId) !== undefined
  );
}

export function getPendingMattermostChannelApproval(approvalId: string): PendingMattermostChannelApproval | undefined {
  return getDb().prepare('SELECT * FROM pending_mattermost_channel_approvals WHERE approval_id = ?').get(approvalId) as
    | PendingMattermostChannelApproval
    | undefined;
}

export function listProcessingMattermostChannelApprovals(instanceKey?: string): PendingMattermostChannelApproval[] {
  const instancePredicate = instanceKey === undefined ? '' : 'AND pending.instance_key = ?';
  return getDb()
    .prepare(
      `SELECT pending.*
         FROM pending_mattermost_channel_approvals pending
         LEFT JOIN mattermost_approval_recovery_quarantine quarantine
           ON quarantine.approval_id = pending.approval_id
        WHERE pending.status = 'processing'
          AND quarantine.approval_id IS NULL
          ${instancePredicate}
        ORDER BY pending.created_at, pending.approval_id`,
    )
    .all(...(instanceKey === undefined ? [] : [instanceKey])) as PendingMattermostChannelApproval[];
}

export function listUnfinishedMattermostChannelApprovals(instanceKey: string): PendingMattermostChannelApproval[] {
  return getDb()
    .prepare(
      `SELECT *
         FROM pending_mattermost_channel_approvals
        WHERE instance_key = ? AND status IN ('pending', 'processing')
        ORDER BY created_at, approval_id`,
    )
    .all(instanceKey) as PendingMattermostChannelApproval[];
}

export function quarantineProcessingMattermostChannelApproval(
  approvalId: string,
  reason: MattermostApprovalRecoveryQuarantineReason,
  quarantinedAt: string,
): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO mattermost_approval_recovery_quarantine (
         approval_id, reason, quarantined_at
       )
       SELECT approval_id, ?, ?
         FROM pending_mattermost_channel_approvals
        WHERE approval_id = ? AND status = 'processing'`,
    )
    .run(reason, quarantinedAt, approvalId);
  return result.changes === 1;
}

export function claimPendingMattermostChannelApproval(
  approvalId: string,
): PendingMattermostChannelApproval | undefined {
  return getDb()
    .prepare(
      `UPDATE pending_mattermost_channel_approvals
          SET status = 'processing'
        WHERE approval_id = ? AND status = 'pending'
      RETURNING *`,
    )
    .get(approvalId) as PendingMattermostChannelApproval | undefined;
}

export function completeMattermostChannelApprovalReplay(approvalId: string, replayedAt: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE pending_mattermost_channel_approvals
          SET status = 'completed', replayed_at = ?
        WHERE approval_id = ? AND status = 'processing'
          AND NOT EXISTS (
            SELECT 1 FROM mattermost_approval_recovery_quarantine quarantine
             WHERE quarantine.approval_id = pending_mattermost_channel_approvals.approval_id
          )`,
    )
    .run(replayedAt, approvalId);
  return result.changes === 1;
}

export function releasePendingMattermostChannelApproval(approvalId: string): void {
  getDb()
    .prepare(
      `UPDATE pending_mattermost_channel_approvals
          SET status = 'pending'
        WHERE approval_id = ? AND status = 'processing'
          AND NOT EXISTS (
            SELECT 1 FROM mattermost_approval_recovery_quarantine quarantine
             WHERE quarantine.approval_id = pending_mattermost_channel_approvals.approval_id
          )
          AND ${PRISTINE_PENDING_BOUNDARY_SQL}`,
    )
    .run(approvalId);
}

export function deletePendingMattermostChannelApproval(approvalId: string): void {
  getDb()
    .prepare("DELETE FROM pending_mattermost_channel_approvals WHERE approval_id = ? AND status = 'pending'")
    .run(approvalId);
}

export function rejectPendingMattermostChannelApproval(
  approvalId: string,
  decidedBy: string,
  decidedAt: string,
): PendingMattermostChannelApproval | undefined {
  return getDb()
    .transaction(() => {
      const row = getDb()
        .prepare(
          `UPDATE pending_mattermost_channel_approvals
              SET status = 'rejected', decided_by = ?, decided_at = ?
            WHERE approval_id = ? AND status = 'pending'
              AND ${PRISTINE_PENDING_BOUNDARY_SQL}
          RETURNING *`,
        )
        .get(decidedBy, decidedAt, approvalId) as PendingMattermostChannelApproval | undefined;
      if (!row) return undefined;
      getDb()
        .prepare(
          `UPDATE messaging_groups
              SET denied_at = ?
            WHERE id = ? AND channel_type = 'mattermost'`,
        )
        .run(decidedAt, row.messaging_group_id);
      return row;
    })
    .immediate();
}
