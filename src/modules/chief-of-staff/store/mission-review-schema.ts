import { createHash } from 'node:crypto';
export const MISSION_REVIEW_SCHEMA = `
ALTER TABLE cos.outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE cos.outbox ADD CONSTRAINT outbox_kind_check
  CHECK(kind IN ('approval_preview','proposal_apply','rpc_response','knowledge_invalidate','knowledge_purge','mission_review_notification'));
`;
export const MISSION_REVIEW_CHECKSUM = createHash('sha256').update(MISSION_REVIEW_SCHEMA).digest('hex');
