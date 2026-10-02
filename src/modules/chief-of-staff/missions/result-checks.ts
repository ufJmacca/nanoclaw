import { digest } from '../domain/contracts.js';
import { validMissionResult, type MissionResult } from '../contracts/mission-result.js';
import type { ResearchWorkOrder } from './work-order.js';
import { validTeamReview } from '../contracts/team-review.js';
import { validateTeamChildWorkOrder } from './team-work-order.js';

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
  const citationFailure = checkResearchCitations(order, result);
  if (citationFailure) return { status: 'invalid', reason: citationFailure };
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
function checkResearchCitations(order: ResearchWorkOrder, result: MissionResult): 'citation' | 'quote' | null {
  for (const claim of result.claims) {
    for (const reference of claim.citations) {
      const source = order.context.sources.find(
        (s) => s.source_id === reference.source_id && s.revision_id === reference.revision_id,
      );
      const chunk = source?.chunks.find((c) => c.ordinal === reference.ordinal);
      if (!chunk || reference.start_line < chunk.start_line || reference.end_line > chunk.end_line) return 'citation';
      const excerpt = chunk.text
        .split('\n')
        .slice(reference.start_line - chunk.start_line, reference.end_line - chunk.start_line + 1)
        .join('\n');
      if (claim.kind === 'quote' && !excerpt.includes(claim.text)) return 'quote';
    }
  }
  return null;
}
/** Exact reviewed template chooses the result schema. A quality opinion cannot pass deterministic evidence gates. */
export function checkWorkerResult(order: ResearchWorkOrder, result: unknown) {
  if (order.body.format !== 'cos-team-child-work-order/v1') return checkResearchResult(order, result);
  const invalid = (reason: string) => ({ status: 'invalid' as const, reason });
  if (!validateTeamChildWorkOrder(order)) return invalid('integrity');
  if (order.body.resultSchema !== 'cos-team-review/v1') return checkResearchResult(order, result);
  if (order.body.template.id !== 'team-reviewer' || !validTeamReview(result, order.body.request.limits.result_bytes))
    return invalid('schema');
  const inputs = order.context.artifacts;
  const claims = new Set<string>();
  for (const input of inputs) {
    if (input.state !== 'submitted') continue;
    const failure = checkResearchCitations(order, input.result);
    if (failure) return invalid(failure);
    for (const claim of input.result.claims) claims.add(input.step_id + ':' + claim.id);
  }
  if (
    result.evidence_validity.length !== claims.size ||
    result.evidence_validity.some((e) => !claims.has(e.step_id + ':' + e.claim_id))
  )
    return invalid('evidence');
  const criteria = new Set(order.body.request.acceptance_criteria.map((c) => c.id));
  if (
    result.unmet_criteria.some((c) => !criteria.has(c)) ||
    result.contradictions.some((c) => c.step_ids.some((s) => !inputs.some((i) => i.step_id === s))) ||
    result.recommended_revisions.some(
      (r) =>
        !inputs.some((i) => i.step_id === r.step_id && i.state === 'submitted') ||
        r.criterion_ids.some((c) => !criteria.has(c)),
    )
  )
    return invalid('references');
  return {
    status: 'advisory_review' as const,
    resultDigest: digest(result),
    workOrderDigest: order.digest,
    contextDigest: order.body.contextDigest,
  };
}
