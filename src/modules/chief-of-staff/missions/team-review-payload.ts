import { COS_PROTOCOL, validResponse } from '../contracts/protocol.js';
import type { TeamReviewSnapshot } from './team-snapshot.js';

/** Bound the actual coordinator envelope before granting review. Preserve every evidence byte or deny the bundle. */
export function teamReviewPayload(current: TeamReviewSnapshot, review: unknown = null) {
  const result = {
    mission: { id: current.root.id, state: current.root.state, version: current.root.version },
    submission: { id: current.anchor.id, digest: current.resultDigest },
    result: current.brief,
    criteria: current.order.body.request.acceptance_criteria,
    review,
  };
  // Every admitted RPC request ID is a UUID of this fixed encoded length.
  const requestId = '11111111-1111-4111-8111-111111111111';
  return validResponse({ protocol: COS_PROTOCOL, request_id: requestId, status: 'ok', result }, requestId)
    ? result
    : null;
}
