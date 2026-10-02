/** Coordinator judgement over immutable submitted evidence, never authority supplied by a specialist. */
export type MissionReview = {
  mission_id: string;
  submission_id: string;
  result_digest: string;
  expected_version: number;
  decision: 'accept' | 'partial' | 'reject';
  criteria: Array<{ id: string; verdict: 'satisfied' | 'partial' | 'not_met' }>;
};
export const missionReviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mission_id', 'submission_id', 'result_digest', 'expected_version', 'decision', 'criteria'],
  properties: {
    mission_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' },
    submission_id: { type: 'string', format: 'uuid' },
    result_digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    expected_version: { type: 'integer', minimum: 1 },
    decision: { type: 'string', enum: ['accept', 'partial', 'reject'] },
    criteria: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'verdict'],
        properties: {
          id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' },
          verdict: { type: 'string', enum: ['satisfied', 'partial', 'not_met'] },
        },
      },
    },
  },
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, fields: string[]) =>
  Object.keys(v).length === fields.length && fields.every((k) => Object.hasOwn(v, k));
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
export function validMissionReview(v: unknown): v is MissionReview {
  return (
    object(v) &&
    exact(v, ['mission_id', 'submission_id', 'result_digest', 'expected_version', 'decision', 'criteria']) &&
    id(v.mission_id) &&
    typeof v.submission_id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.submission_id) &&
    typeof v.result_digest === 'string' &&
    /^[a-f0-9]{64}$/.test(v.result_digest) &&
    Number.isSafeInteger(v.expected_version) &&
    Number(v.expected_version) > 0 &&
    ['accept', 'partial', 'reject'].includes(String(v.decision)) &&
    Array.isArray(v.criteria) &&
    v.criteria.length >= 1 &&
    v.criteria.length <= 8 &&
    v.criteria.every(
      (c) =>
        object(c) &&
        exact(c, ['id', 'verdict']) &&
        id(c.id) &&
        ['satisfied', 'partial', 'not_met'].includes(String(c.verdict)),
    ) &&
    new Set(v.criteria.map((c) => c.id)).size === v.criteria.length
  );
}
type Checks = {
  status: 'review_required';
  outcome: 'answer' | 'partial' | 'blocked';
  criteria: Array<{ id: string; coverage: 'claimed' | 'missing' }>;
};
/** Deterministic coverage gates do not prove the model's semantic judgement. */
export function checkMissionReview(review: unknown, checks: Checks): 'completed' | 'partial' | 'blocked' | null {
  if (!validMissionReview(review) || review.criteria.length !== checks.criteria.length) return null;
  const coverage = new Map(checks.criteria.map((c) => [c.id, c.coverage]));
  if (review.criteria.some((c) => !coverage.has(c.id) || (coverage.get(c.id) === 'missing' && c.verdict !== 'not_met')))
    return null;
  if (review.decision === 'accept')
    return checks.outcome === 'answer' && review.criteria.every((c) => c.verdict === 'satisfied') ? 'completed' : null;
  if (review.decision === 'partial')
    return checks.outcome !== 'blocked' && review.criteria.some((c) => c.verdict !== 'not_met') ? 'partial' : null;
  return review.criteria.some((c) => c.verdict !== 'satisfied') ? 'blocked' : null;
}
