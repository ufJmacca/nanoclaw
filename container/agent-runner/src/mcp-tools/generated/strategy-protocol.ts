/** Bounded review input. Scope, snapshots, permissions and approval remain host-owned. */
export type ReviewSourceReference = { kind: 'source'; evidence_id: string };
export type ReviewReference =
  | ReviewSourceReference
  | { kind: 'record'; record_id: string; version: number }
  | { kind: 'work'; work_id: string; version: number }
  | { kind: 'observation'; observation_id: string }
  | { kind: 'mission_result'; submission_id: string; digest: string };
export type ReviewMeasure = {
  id: string;
  initiative_id: string;
  outcome: string;
  test: string;
};
export type ReviewAssumption = { id: string; initiative_id: string; statement: string };
export type ReviewCharterDefinition = {
  title: string;
  initiative_ids: string[];
  source_ids: string[];
  starts_at: string;
  ends_at: string;
  cadence: 'manual';
  resource_constraints: string;
  evidence_limits: string;
  exploration_minutes_per_week: number;
  measures: ReviewMeasure[];
  assumptions: ReviewAssumption[];
};
export type ReviewCharterChange = {
  kind: 'review_charter';
  expected_version: number;
  reason: string;
  definition: ReviewCharterDefinition;
};
export type StrategyObservationChange = {
  kind: 'strategy_observation';
  charter_version: number;
  initiative_id: string;
  target: { kind: 'outcome' | 'assumption' | 'attention_cost' | 'actual_effort'; id: string };
  basis: 'evidence_backed' | 'self_reported' | 'unknown';
  signal: 'supported' | 'challenged' | 'unknown';
  statement: string;
  observed_at: string;
  evidence: ReviewSourceReference[];
  reason: string;
};
export type ReviewRequest = { charter_version: number; previous_review_id: string | null };
export type DirectionRequest = {
  review_id: string;
  revision: number;
  option_id: string;
  expected_record_version: number;
  expected_direction_version: number;
  reason: string;
};
/** Host-derived from a verified private review. The agent wire accepts only DirectionRequest. */
export type StrategyDirectionChange = {
  kind: 'strategy_direction';
  request: DirectionRequest;
  option: ReviewOption;
  charter_version: number;
  snapshot_digest: string;
  draft_digest: string;
  result_artifact_id: string;
  result_artifact_digest: string;
};
export type ReviewFinding = {
  kind: 'fact' | 'self_report' | 'assumption' | 'recommendation';
  domain: 'activity' | 'outcome' | 'calendar_allocation' | 'actual_effort' | 'attention_cost' | 'other';
  initiative_id: string;
  statement: string;
  evidence: ReviewReference[];
  uncertainty: string;
};
export type ReviewOption = {
  id: string;
  initiative_id: string;
  direction: 'continue' | 'change' | 'pause' | 'stop';
  title: string;
  trade_off: string;
  opportunity_cost: string;
  next_action: string;
};
export type ReviewDraft = {
  findings: ReviewFinding[];
  options: ReviewOption[];
  recommended_option_id: string;
  rationale: string;
  confidence: 'low' | 'medium' | 'high';
  uncertainty: string;
  evidence_would_change: string;
  forecast_until: string;
};

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
export function validDirectionRequest(value: unknown): value is DirectionRequest {
  return (
    object(value) &&
    exact(value, [
      'review_id',
      'revision',
      'option_id',
      'expected_record_version',
      'expected_direction_version',
      'reason',
    ]) &&
    reviewId(value.review_id) &&
    reviewInteger(value.revision) &&
    reviewIdentifier(value.option_id) &&
    reviewInteger(value.expected_record_version) &&
    reviewInteger(value.expected_direction_version, 0) &&
    reviewText(value.reason, 500)
  );
}
export function validStrategyDirectionChange(value: unknown): value is StrategyDirectionChange {
  return (
    object(value) &&
    exact(value, [
      'kind',
      'request',
      'option',
      'charter_version',
      'snapshot_digest',
      'draft_digest',
      'result_artifact_id',
      'result_artifact_digest',
    ]) &&
    value.kind === 'strategy_direction' &&
    validDirectionRequest(value.request) &&
    validReviewOption(value.option) &&
    value.option.id === value.request.option_id &&
    reviewInteger(value.charter_version) &&
    reviewDigest(value.snapshot_digest) &&
    reviewDigest(value.draft_digest) &&
    typeof value.result_artifact_id === 'string' &&
    /^[a-f0-9]{64}-[a-f0-9]{64}$/.test(value.result_artifact_id) &&
    reviewDigest(value.result_artifact_digest)
  );
}
export const reviewInteger = (value: unknown, minimum = 1, maximum = 2147483646): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
export const reviewText = (value: unknown, maximum: number, empty = false): value is string =>
  typeof value === 'string' &&
  (empty || value.trim().length > 0) &&
  value.length <= maximum &&
  Buffer.from(value).toString('utf8') === value &&
  [...value].every((character) => {
    const code = character.codePointAt(0)!;
    return code >= 32 && (code < 127 || code > 159);
  });
export const reviewIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export const reviewUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const reviewId = (value: unknown): value is string =>
  typeof value === 'string' && /^review-[a-f0-9]{64}$/.test(value);
export const reviewDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const reviewInstant = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  [new Date(value).toISOString(), new Date(value).toISOString().replace('.000Z', 'Z')].includes(value);
const list = (
  value: unknown,
  minimum: number,
  maximum: number,
  valid: (item: unknown) => boolean,
): value is unknown[] =>
  Array.isArray(value) && value.length >= minimum && value.length <= maximum && value.every(valid);
const identifiers = (value: unknown, minimum: number, maximum: number): value is string[] =>
  list(value, minimum, maximum, reviewIdentifier) && new Set(value).size === value.length;
const uniqueIds = (value: Array<{ id: string }>) => new Set(value.map((item) => item.id)).size === value.length;
const validMeasure = (value: unknown): value is ReviewMeasure =>
  object(value) &&
  exact(value, ['id', 'initiative_id', 'outcome', 'test']) &&
  reviewIdentifier(value.id) &&
  reviewIdentifier(value.initiative_id) &&
  reviewText(value.outcome, 500) &&
  reviewText(value.test, 500);
const validAssumption = (value: unknown): value is ReviewAssumption =>
  object(value) &&
  exact(value, ['id', 'initiative_id', 'statement']) &&
  reviewIdentifier(value.id) &&
  reviewIdentifier(value.initiative_id) &&
  reviewText(value.statement, 500);
export function validReviewCharterDefinition(value: unknown): value is ReviewCharterDefinition {
  if (
    !object(value) ||
    !exact(value, [
      'title',
      'initiative_ids',
      'source_ids',
      'starts_at',
      'ends_at',
      'cadence',
      'resource_constraints',
      'evidence_limits',
      'exploration_minutes_per_week',
      'measures',
      'assumptions',
    ]) ||
    !reviewText(value.title, 200) ||
    !identifiers(value.initiative_ids, 1, 10) ||
    !identifiers(value.source_ids, 0, 6) ||
    !reviewInstant(value.starts_at) ||
    !reviewInstant(value.ends_at) ||
    Date.parse(value.starts_at) >= Date.parse(value.ends_at) ||
    Date.parse(value.ends_at) - Date.parse(value.starts_at) > 366 * 86400000 ||
    value.cadence !== 'manual' ||
    !reviewText(value.resource_constraints, 500) ||
    !reviewText(value.evidence_limits, 500) ||
    !reviewInteger(value.exploration_minutes_per_week, 0, 10080) ||
    !list(value.measures, 1, 10, validMeasure) ||
    !list(value.assumptions, 0, 10, validAssumption)
  )
    return false;
  const measures = value.measures as ReviewMeasure[],
    assumptions = value.assumptions as ReviewAssumption[];
  return (
    uniqueIds(measures) &&
    uniqueIds(assumptions) &&
    Buffer.byteLength(JSON.stringify(value)) <= 16384 &&
    [...measures, ...assumptions].every((item) => (value.initiative_ids as string[]).includes(item.initiative_id)) &&
    value.initiative_ids.every((id) => measures.some((measure) => measure.initiative_id === id))
  );
}
export function validReviewCharterChange(value: unknown): value is ReviewCharterChange {
  return (
    object(value) &&
    exact(value, ['kind', 'expected_version', 'reason', 'definition']) &&
    value.kind === 'review_charter' &&
    reviewInteger(value.expected_version, 0) &&
    reviewText(value.reason, 500) &&
    validReviewCharterDefinition(value.definition) &&
    Buffer.byteLength(JSON.stringify(value)) <= 18432
  );
}
export function validReviewSourceReference(value: unknown): value is ReviewSourceReference {
  return (
    object(value) && exact(value, ['kind', 'evidence_id']) && value.kind === 'source' && reviewUuid(value.evidence_id)
  );
}
export function validReviewReference(value: unknown): value is ReviewReference {
  if (!object(value)) return false;
  if (value.kind === 'source') return validReviewSourceReference(value);
  if (value.kind === 'record')
    return (
      exact(value, ['kind', 'record_id', 'version']) &&
      reviewIdentifier(value.record_id) &&
      reviewInteger(value.version)
    );
  if (value.kind === 'work')
    return (
      exact(value, ['kind', 'work_id', 'version']) && reviewIdentifier(value.work_id) && reviewInteger(value.version)
    );
  if (value.kind === 'observation') return exact(value, ['kind', 'observation_id']) && reviewUuid(value.observation_id);
  return (
    value.kind === 'mission_result' &&
    exact(value, ['kind', 'submission_id', 'digest']) &&
    reviewUuid(value.submission_id) &&
    reviewDigest(value.digest)
  );
}
export function validStrategyObservationChange(value: unknown): value is StrategyObservationChange {
  return (
    object(value) &&
    exact(value, [
      'kind',
      'charter_version',
      'initiative_id',
      'target',
      'basis',
      'signal',
      'statement',
      'observed_at',
      'evidence',
      'reason',
    ]) &&
    value.kind === 'strategy_observation' &&
    reviewInteger(value.charter_version) &&
    reviewIdentifier(value.initiative_id) &&
    object(value.target) &&
    exact(value.target, ['kind', 'id']) &&
    reviewIdentifier(value.target.id) &&
    ['outcome', 'assumption', 'attention_cost', 'actual_effort'].includes(String(value.target.kind)) &&
    ['evidence_backed', 'self_reported', 'unknown'].includes(String(value.basis)) &&
    ['supported', 'challenged', 'unknown'].includes(String(value.signal)) &&
    (value.basis !== 'unknown' || value.signal === 'unknown') &&
    reviewText(value.statement, 500) &&
    reviewInstant(value.observed_at) &&
    reviewText(value.reason, 500) &&
    list(value.evidence, value.basis === 'evidence_backed' ? 1 : 0, 6, validReviewSourceReference) &&
    new Set((value.evidence as ReviewSourceReference[]).map((ref) => ref.evidence_id)).size === value.evidence.length
  );
}
export function validReviewRequest(value: unknown): value is ReviewRequest {
  return (
    object(value) &&
    exact(value, ['charter_version', 'previous_review_id']) &&
    reviewInteger(value.charter_version) &&
    (value.previous_review_id === null || reviewId(value.previous_review_id))
  );
}
function validFinding(value: unknown): value is ReviewFinding {
  return (
    object(value) &&
    exact(value, ['kind', 'domain', 'initiative_id', 'statement', 'evidence', 'uncertainty']) &&
    ['fact', 'self_report', 'assumption', 'recommendation'].includes(String(value.kind)) &&
    ['activity', 'outcome', 'calendar_allocation', 'actual_effort', 'attention_cost', 'other'].includes(
      String(value.domain),
    ) &&
    reviewIdentifier(value.initiative_id) &&
    reviewText(value.statement, 500) &&
    reviewText(value.uncertainty, 500, true) &&
    list(value.evidence, ['fact', 'self_report'].includes(String(value.kind)) ? 1 : 0, 6, validReviewReference) &&
    (value.evidence.length > 0 || String(value.uncertainty).trim().length > 0)
  );
}
export function validReviewOption(value: unknown): value is ReviewOption {
  return (
    object(value) &&
    exact(value, ['id', 'initiative_id', 'direction', 'title', 'trade_off', 'opportunity_cost', 'next_action']) &&
    reviewIdentifier(value.id) &&
    reviewIdentifier(value.initiative_id) &&
    ['continue', 'change', 'pause', 'stop'].includes(String(value.direction)) &&
    reviewText(value.title, 200) &&
    reviewText(value.trade_off, 500) &&
    reviewText(value.opportunity_cost, 500) &&
    reviewText(value.next_action, 500)
  );
}
export function validReviewDraft(value: unknown): value is ReviewDraft {
  if (
    !object(value) ||
    !exact(value, [
      'findings',
      'options',
      'recommended_option_id',
      'rationale',
      'confidence',
      'uncertainty',
      'evidence_would_change',
      'forecast_until',
    ]) ||
    !list(value.findings, 1, 12, validFinding) ||
    !list(value.options, 1, 20, validReviewOption) ||
    !reviewIdentifier(value.recommended_option_id) ||
    !reviewText(value.rationale, 500) ||
    !['low', 'medium', 'high'].includes(String(value.confidence)) ||
    !reviewText(value.uncertainty, 500) ||
    !reviewText(value.evidence_would_change, 500) ||
    !reviewInstant(value.forecast_until)
  )
    return false;
  const options = value.options as ReviewOption[];
  return (
    uniqueIds(options) &&
    options.some((option) => option.id === value.recommended_option_id) &&
    Buffer.byteLength(JSON.stringify(value)) <= 12288
  );
}

// Image-owned coordinator catalogs use the canonical bounded wire shape. Host validators also enforce
// cross-field selection, evidence, snapshot integrity, current authority and encoded byte limits.
const idSchema = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' };
const uuidSchema = { type: 'string', format: 'uuid' };
const reviewIdSchema = { type: 'string', pattern: '^review-[a-f0-9]{64}$' };
const integerSchema = (minimum = 1, maximum = 2147483646) => ({ type: 'integer', minimum, maximum });
const textSchema = (maximum: number, minimum = 1) => ({ type: 'string', minLength: minimum, maxLength: maximum });
const instantSchema = {
  type: 'string',
  format: 'date-time',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$',
};
const enumSchema = (...values: string[]) => ({ type: 'string', enum: values });
const objectSchema = (properties: Record<string, object>) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
const arraySchema = (items: object, minimum: number, maximum: number) => ({
  type: 'array',
  items,
  minItems: minimum,
  maxItems: maximum,
});
const sourceReferenceSchema = objectSchema({ kind: { const: 'source' }, evidence_id: uuidSchema });
export const reviewCharterChangeSchema = objectSchema({
  kind: { const: 'review_charter' },
  expected_version: integerSchema(0),
  reason: textSchema(500),
  definition: objectSchema({
    title: textSchema(200),
    initiative_ids: { ...arraySchema(idSchema, 1, 10), uniqueItems: true },
    source_ids: { ...arraySchema(idSchema, 0, 6), uniqueItems: true },
    starts_at: instantSchema,
    ends_at: instantSchema,
    cadence: { const: 'manual' },
    resource_constraints: textSchema(500),
    evidence_limits: textSchema(500),
    exploration_minutes_per_week: integerSchema(0, 10080),
    measures: arraySchema(
      objectSchema({ id: idSchema, initiative_id: idSchema, outcome: textSchema(500), test: textSchema(500) }),
      1,
      10,
    ),
    assumptions: arraySchema(
      objectSchema({ id: idSchema, initiative_id: idSchema, statement: textSchema(500) }),
      0,
      10,
    ),
  }),
});
export const strategyObservationChangeSchema = objectSchema({
  kind: { const: 'strategy_observation' },
  charter_version: integerSchema(),
  initiative_id: idSchema,
  target: objectSchema({ kind: enumSchema('outcome', 'assumption', 'attention_cost', 'actual_effort'), id: idSchema }),
  basis: enumSchema('evidence_backed', 'self_reported', 'unknown'),
  signal: enumSchema('supported', 'challenged', 'unknown'),
  statement: textSchema(500),
  observed_at: instantSchema,
  evidence: { ...arraySchema(sourceReferenceSchema, 0, 6), uniqueItems: true },
  reason: textSchema(500),
});
export const reviewRequestSchema = objectSchema({
  charter_version: integerSchema(),
  previous_review_id: { anyOf: [reviewIdSchema, { type: 'null' }] },
});
export const directionRequestSchema = objectSchema({
  review_id: reviewIdSchema,
  revision: integerSchema(),
  option_id: idSchema,
  expected_record_version: integerSchema(),
  expected_direction_version: integerSchema(0),
  reason: textSchema(500),
});
const referenceSchema = {
  oneOf: [
    sourceReferenceSchema,
    objectSchema({ kind: { const: 'record' }, record_id: idSchema, version: integerSchema() }),
    objectSchema({ kind: { const: 'work' }, work_id: idSchema, version: integerSchema() }),
    objectSchema({ kind: { const: 'observation' }, observation_id: uuidSchema }),
    objectSchema({
      kind: { const: 'mission_result' },
      submission_id: uuidSchema,
      digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    }),
  ],
};
export const reviewDraftSchema = objectSchema({
  findings: arraySchema(
    objectSchema({
      kind: enumSchema('fact', 'self_report', 'assumption', 'recommendation'),
      domain: enumSchema('activity', 'outcome', 'calendar_allocation', 'actual_effort', 'attention_cost', 'other'),
      initiative_id: idSchema,
      statement: textSchema(500),
      evidence: arraySchema(referenceSchema, 0, 6),
      uncertainty: textSchema(500, 0),
    }),
    1,
    12,
  ),
  options: arraySchema(
    objectSchema({
      id: idSchema,
      initiative_id: idSchema,
      direction: enumSchema('continue', 'change', 'pause', 'stop'),
      title: textSchema(200),
      trade_off: textSchema(500),
      opportunity_cost: textSchema(500),
      next_action: textSchema(500),
    }),
    1,
    20,
  ),
  recommended_option_id: idSchema,
  rationale: textSchema(500),
  confidence: enumSchema('low', 'medium', 'high'),
  uncertainty: textSchema(500),
  evidence_would_change: textSchema(500),
  forecast_until: instantSchema,
});
