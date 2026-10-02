/** Bounded proposal input. Host admission adds identity, authority and immutable context separately. */
export type MissionLimits = {
  max_attempts: number;
  max_turns: number;
  max_tool_calls: number;
  max_concurrent_workers: 1;
  wall_seconds: number;
  context_bytes: number;
  result_bytes: number;
};
export const MISSION_DEFAULT_LIMITS: Readonly<MissionLimits> = Object.freeze({
  max_attempts: 2,
  max_turns: 4,
  max_tool_calls: 24,
  max_concurrent_workers: 1,
  wall_seconds: 600,
  context_bytes: 32768,
  result_bytes: 8192,
});
export type MissionSource = { source_id: string; revision_id: string };
export type MissionCriterion = { id: string; description: string };
export type MissionRequest = {
  question: string;
  goal_id: string | null;
  project_id: string | null;
  sources: MissionSource[];
  acceptance_criteria: MissionCriterion[];
  limits: MissionLimits;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
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
const ranges = {
  max_attempts: [1, 3],
  max_turns: [1, 12],
  max_tool_calls: [1, 64],
  max_concurrent_workers: [1, 1],
  wall_seconds: [30, 1800],
  context_bytes: [1024, 65536],
  result_bytes: [512, 16384],
} as const;
/** Provider guidance shares the same structural limits as host validation; it grants no authority. */
export const missionRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['question', 'goal_id', 'project_id', 'sources', 'acceptance_criteria', 'limits'],
  properties: {
    question: { type: 'string', minLength: 1, maxLength: 4000 },
    goal_id: { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' }] },
    project_id: { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' }] },
    sources: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source_id', 'revision_id'],
        properties: {
          source_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' },
          revision_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' },
        },
      },
    },
    acceptance_criteria: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'description'],
        properties: {
          id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' },
          description: { type: 'string', minLength: 1, maxLength: 1000 },
        },
      },
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      required: Object.keys(ranges),
      properties: Object.fromEntries(
        Object.entries(ranges).map(([key, [minimum, maximum]]) => [
          key,
          { type: 'integer', minimum, maximum, default: MISSION_DEFAULT_LIMITS[key as keyof MissionLimits] },
        ]),
      ),
    },
  },
};
/** Limits apply to the mission root across all attempts, never separately per retry. */
export function validMissionLimits(v: unknown): v is MissionLimits {
  return (
    object(v) &&
    exact(v, Object.keys(ranges)) &&
    Object.entries(ranges).every(([key, [min, max]]) => {
      const value = v[key];
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
    })
  );
}
/** Validation is not source access, delegation consent, operator template review or execution approval. */
export function validMissionRequest(v: unknown): v is MissionRequest {
  if (
    !object(v) ||
    !exact(v, ['question', 'goal_id', 'project_id', 'sources', 'acceptance_criteria', 'limits']) ||
    !text(v.question, 4000) ||
    (v.goal_id !== null && !id(v.goal_id)) ||
    (v.project_id !== null && !id(v.project_id)) ||
    !validMissionLimits(v.limits) ||
    !Array.isArray(v.sources) ||
    v.sources.length < 1 ||
    v.sources.length > 8 ||
    !v.sources.every(
      (s) => object(s) && exact(s, ['source_id', 'revision_id']) && id(s.source_id) && id(s.revision_id),
    ) ||
    !Array.isArray(v.acceptance_criteria) ||
    v.acceptance_criteria.length < 1 ||
    v.acceptance_criteria.length > 8 ||
    !v.acceptance_criteria.every(
      (c) => object(c) && exact(c, ['id', 'description']) && id(c.id) && text(c.description, 1000),
    )
  )
    return false;
  // One explicit revision per source prevents ambiguity in the first comparison profile.
  return (
    new Set(v.sources.map((s: MissionSource) => s.source_id)).size === v.sources.length &&
    new Set(v.acceptance_criteria.map((c: MissionCriterion) => c.id)).size === v.acceptance_criteria.length
  );
}
