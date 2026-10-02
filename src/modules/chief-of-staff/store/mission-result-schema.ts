import { createHash } from 'node:crypto';

// Specialist output is purgeable evidence awaiting review, never a coordinator answer.
export const MISSION_RESULT_SCHEMA = `
ALTER TABLE cos.artifacts DROP CONSTRAINT artifacts_kind_check;
ALTER TABLE cos.artifacts ADD CONSTRAINT artifacts_kind_check
  CHECK(kind IN ('source','answer','summary','mission_result'));
`;
export const MISSION_RESULT_CHECKSUM = createHash('sha256').update(MISSION_RESULT_SCHEMA).digest('hex');
