import { createHash } from 'node:crypto';
/** SQL CHECK treats NULL as allowed: require an explicit predecessor after revision one.
 * A new migration preserves the already tested v17 checksum and history. No rows are reset. */
export const STRATEGY_CHAIN_SCHEMA = `
ALTER TABLE cos.strategy_review_snapshots ADD CONSTRAINT strategy_review_predecessor_required
  CHECK((revision=1 AND previous_revision IS NULL)
    OR (revision>1 AND previous_revision IS NOT NULL AND previous_revision=revision-1));
`;
export const STRATEGY_CHAIN_CHECKSUM = createHash('sha256').update(STRATEGY_CHAIN_SCHEMA).digest('hex');
