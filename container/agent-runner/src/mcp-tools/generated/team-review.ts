/** Canonical specialist review. Findings are untrusted, advisory opinions, never approval or execution grants. */
export type TeamReview = {
  format: 'cos-team-review/v1';
  evidence_validity: Array<{
    step_id: string;
    claim_id: string;
    verdict: 'supported' | 'unsupported' | 'uncertain';
    reason: string;
  }>;
  factual_gaps: string[];
  contradictions: Array<{ step_ids: string[]; description: string }>;
  unmet_criteria: string[];
  recommended_revisions: Array<{ step_id: string; criterion_ids: string[]; instructions: string }>;
  confidence: 'low' | 'medium' | 'high';
};
const identifier = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' };
const ids = (minItems: number, maxItems: number) => ({
  type: 'array',
  minItems,
  maxItems,
  uniqueItems: true,
  items: identifier,
});
export const teamReviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'evidence_validity',
    'factual_gaps',
    'contradictions',
    'unmet_criteria',
    'recommended_revisions',
    'confidence',
  ],
  properties: {
    format: { type: 'string', enum: ['cos-team-review/v1'] },
    evidence_validity: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['step_id', 'claim_id', 'verdict', 'reason'],
        properties: {
          step_id: identifier,
          claim_id: identifier,
          verdict: { type: 'string', enum: ['supported', 'unsupported', 'uncertain'] },
          reason: { type: 'string', minLength: 1, maxLength: 300 },
        },
      },
    },
    factual_gaps: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 1000 } },
    contradictions: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['step_ids', 'description'],
        properties: { step_ids: ids(2, 5), description: { type: 'string', minLength: 1, maxLength: 1000 } },
      },
    },
    unmet_criteria: ids(0, 8),
    recommended_revisions: {
      type: 'array',
      maxItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['step_id', 'criterion_ids', 'instructions'],
        properties: {
          step_id: identifier,
          criterion_ids: ids(1, 8),
          instructions: { type: 'string', minLength: 1, maxLength: 1000 },
        },
      },
    },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' &&
  v.trim().length > 0 &&
  v.length <= max &&
  Buffer.from(v).toString('utf8') === v &&
  [...v].every((c) => {
    const n = c.codePointAt(0)!;
    return (n >= 32 || n === 10 || n === 9) && (n < 127 || n > 159);
  });
const identifiers = (v: unknown, min: number, max: number): v is string[] =>
  Array.isArray(v) && v.length >= min && v.length <= max && v.every(id) && new Set(v).size === v.length;
/** Syntax only. Host checks exact input claim/criterion references and approved rework credits separately. */
export function validTeamReview(v: unknown, maxBytes = 16384): v is TeamReview {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 512 ||
    maxBytes > 16384 ||
    !object(v) ||
    !exact(v, [
      'format',
      'evidence_validity',
      'factual_gaps',
      'contradictions',
      'unmet_criteria',
      'recommended_revisions',
      'confidence',
    ]) ||
    v.format !== 'cos-team-review/v1' ||
    !['low', 'medium', 'high'].includes(String(v.confidence)) ||
    !Array.isArray(v.evidence_validity) ||
    v.evidence_validity.length > 40 ||
    !Array.isArray(v.factual_gaps) ||
    v.factual_gaps.length > 8 ||
    !v.factual_gaps.every((t) => text(t, 1000)) ||
    !Array.isArray(v.contradictions) ||
    v.contradictions.length > 8 ||
    !identifiers(v.unmet_criteria, 0, 8) ||
    !Array.isArray(v.recommended_revisions) ||
    v.recommended_revisions.length > 1
  )
    return false;
  const evidence = new Set<string>();
  for (const e of v.evidence_validity) {
    if (
      !object(e) ||
      !exact(e, ['step_id', 'claim_id', 'verdict', 'reason']) ||
      !id(e.step_id) ||
      !id(e.claim_id) ||
      !['supported', 'unsupported', 'uncertain'].includes(String(e.verdict)) ||
      !text(e.reason, 300) ||
      evidence.has(e.step_id + ':' + e.claim_id)
    )
      return false;
    evidence.add(e.step_id + ':' + e.claim_id);
  }
  return (
    v.contradictions.every(
      (c) =>
        object(c) &&
        exact(c, ['step_ids', 'description']) &&
        identifiers(c.step_ids, 2, 5) &&
        text(c.description, 1000),
    ) &&
    v.recommended_revisions.every(
      (r) =>
        object(r) &&
        exact(r, ['step_id', 'criterion_ids', 'instructions']) &&
        id(r.step_id) &&
        identifiers(r.criterion_ids, 1, 8) &&
        text(r.instructions, 1000),
    ) &&
    Buffer.byteLength(JSON.stringify(v), 'utf8') <= maxBytes
  );
}
