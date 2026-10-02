import { digest } from '../domain/contracts.js';
import { validMissionResult, type MissionResult } from '../contracts/mission-result.js';
import type { ResearchWorkOrder } from './work-order.js';

export type ResearchResultChecks =
  | { status: 'invalid'; reason: 'integrity' | 'schema' | 'criteria' | 'citation' | 'quote' }
  | {
      status: 'review_required';
      resultDigest: string;
      workOrderDigest: string;
      contextDigest: string;
      outcome: MissionResult['outcome'];
      criteria: Array<{ id: string; coverage: 'claimed' | 'missing' }>;
    };
/**
 * Pure structural checks against an already admitted snapshot. Caller must independently
 * recheck current authority/source access and record coordinator review before completion.
 * A referenced inference is not proven true, nor does coverage prove a criterion is satisfied.
 */
export function checkResearchResult(order: ResearchWorkOrder, result: unknown): ResearchResultChecks {
  if (digest(order.body) !== order.digest || digest(order.context) !== order.body.contextDigest)
    return { status: 'invalid', reason: 'integrity' };
  if (!validMissionResult(result, order.body.request.limits.result_bytes))
    return { status: 'invalid', reason: 'schema' };
  const criteria = new Map(result.criteria.map((c) => [c.id, c]));
  if (
    criteria.size !== order.body.request.acceptance_criteria.length ||
    order.body.request.acceptance_criteria.some((c) => !criteria.has(c.id))
  )
    return { status: 'invalid', reason: 'criteria' };
  for (const claim of result.claims) {
    for (const reference of claim.citations) {
      const source = order.context.sources.find(
        (s) => s.source_id === reference.source_id && s.revision_id === reference.revision_id,
      );
      const chunk = source?.chunks.find((c) => c.ordinal === reference.ordinal);
      if (!chunk || reference.start_line < chunk.start_line || reference.end_line > chunk.end_line)
        return { status: 'invalid', reason: 'citation' };
      const excerpt = chunk.text
        .split('\n')
        .slice(reference.start_line - chunk.start_line, reference.end_line - chunk.start_line + 1)
        .join('\n');
      if (claim.kind === 'quote' && !excerpt.includes(claim.text)) return { status: 'invalid', reason: 'quote' };
    }
  }
  return {
    status: 'review_required',
    resultDigest: digest(result),
    workOrderDigest: order.digest,
    contextDigest: order.body.contextDigest,
    outcome: result.outcome,
    criteria: order.body.request.acceptance_criteria.map((c) => ({
      id: c.id,
      coverage: criteria.get(c.id)!.claim_ids.length ? 'claimed' : 'missing',
    })),
  };
}
