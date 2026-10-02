/** Selected advisory instructions only. No worker history, additional authority or new limits. */
export type TeamRework = {
  kind: 'requested_revision' | 'dependency_replay';
  review_mission_id: string;
  review_submission_id: string;
  review_digest: string;
  target_step_id: string;
  criterion_ids: string[];
  instructions: string;
};
export function validTeamRework(value: unknown): value is TeamRework {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = [
    'kind',
    'review_mission_id',
    'review_submission_id',
    'review_digest',
    'target_step_id',
    'criterion_ids',
    'instructions',
  ];
  const id = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(s);
  return (
    Object.keys(v).length === keys.length &&
    keys.every((k) => Object.hasOwn(v, k)) &&
    ['requested_revision', 'dependency_replay'].includes(String(v.kind)) &&
    typeof v.review_mission_id === 'string' &&
    /^mission-[a-f0-9]{64}$/.test(v.review_mission_id) &&
    typeof v.review_submission_id === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v.review_submission_id) &&
    typeof v.review_digest === 'string' &&
    /^[a-f0-9]{64}$/.test(v.review_digest) &&
    id(v.target_step_id) &&
    Array.isArray(v.criterion_ids) &&
    v.criterion_ids.length >= 1 &&
    v.criterion_ids.length <= 8 &&
    v.criterion_ids.every(id) &&
    new Set(v.criterion_ids).size === v.criterion_ids.length &&
    typeof v.instructions === 'string' &&
    v.instructions.trim().length > 0 &&
    v.instructions.length <= 1000 &&
    Buffer.from(v.instructions).toString('utf8') === v.instructions &&
    [...v.instructions].every((c) => {
      const n = c.codePointAt(0)!;
      return (n >= 32 || n === 10 || n === 9) && (n < 127 || n > 159);
    })
  );
}
/** Recipient role and its approved rework count remain binding after content is rehashed. */
export function validTeamReworkForStep(value: unknown, step: unknown, revision: unknown): value is TeamRework {
  if (
    !validTeamRework(value) ||
    !step ||
    typeof step !== 'object' ||
    Array.isArray(step) ||
    !Number.isSafeInteger(revision) ||
    Number(revision) < 1 ||
    Number(revision) > 2
  )
    return false;
  const s = step as Record<string, unknown>;
  if (s.template_id === 'team-reviewer') {
    const limits = s.limits as { max_attempts?: number } | undefined;
    return value.kind === 'dependency_replay' && Number(revision) < Number(limits?.max_attempts);
  }
  if (s.max_rework_count !== 1 || revision !== 1) return false;
  return (
    value.kind === 'dependency_replay' ||
    (value.target_step_id === s.step_id &&
      Array.isArray(s.acceptance_criteria) &&
      value.criterion_ids.every((id) => (s.acceptance_criteria as Array<{ id: string }>).some((c) => c.id === id)))
  );
}
