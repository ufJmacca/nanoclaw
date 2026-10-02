import { validMissionRequest, type MissionRequest, type MissionLimits } from './mission-protocol.js';
import { TEAM_TEMPLATES, type TeamTemplateId } from './team-templates.js';

export type TeamLimits = Omit<MissionLimits, 'max_concurrent_workers'> & { max_concurrent_workers: 1 | 2 };
export type TeamStep = {
  step_id: string;
  template_id: TeamTemplateId;
  template_version: 1;
  depends_on: string[];
  input_artifact_refs: Array<{ step_id: string; result_schema: string }>;
  sources: MissionRequest['sources'];
  required: boolean;
  acceptance_criteria: MissionRequest['acceptance_criteria'];
  result_schema: 'cos-research-result/v1' | 'cos-team-review/v1';
  max_rework_count: 0 | 1;
  limits: MissionLimits;
};
export type TeamRequest = Omit<MissionRequest, 'limits'> & {
  limits: TeamLimits;
  partial_policy: 'block' | 'allow_labelled';
  steps: TeamStep[];
};
export const TEAM_DEFAULT_LIMITS: Readonly<TeamLimits> = Object.freeze({
  max_attempts: 8,
  max_turns: 16,
  max_tool_calls: 96,
  max_concurrent_workers: 2,
  wall_seconds: 600,
  context_bytes: 32768,
  result_bytes: 8192,
});
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const integer = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
export const TEAM_STEP_KEYS = Object.freeze([
  'step_id',
  'template_id',
  'template_version',
  'depends_on',
  'input_artifact_refs',
  'sources',
  'required',
  'acceptance_criteria',
  'result_schema',
  'max_rework_count',
  'limits',
]);
const rootKeys = [
  'question',
  'goal_id',
  'project_id',
  'sources',
  'acceptance_criteria',
  'limits',
  'partial_policy',
  'steps',
];

/** Stable Kahn ordering. Only validated bounded arrays reach this function. */
function ordered(steps: TeamStep[]): string[] | null {
  const remaining = new Map(steps.map((s) => [s.step_id, s]));
  const done = new Set<string>(),
    result: string[] = [];
  while (remaining.size) {
    const ready = [...remaining.values()]
      .filter((s) => s.depends_on.every((d) => done.has(d)))
      .map((s) => s.step_id)
      .sort();
    if (!ready.length) return null;
    for (const step of ready) {
      result.push(step);
      done.add(step);
      remaining.delete(step);
    }
  }
  return result;
}
/** Structural admission only. Exact host authority, source snapshots and reviewed digests still need approval. */
export function validTeamRequest(v: unknown): v is TeamRequest {
  if (
    !object(v) ||
    !exact(v, rootKeys) ||
    !object(v.limits) ||
    !Array.isArray(v.steps) ||
    v.steps.length < 4 ||
    v.steps.length > 6 ||
    !['block', 'allow_labelled'].includes(String(v.partial_policy))
  )
    return false;
  const l = v.limits;
  if (
    !exact(l, Object.keys(TEAM_DEFAULT_LIMITS)) ||
    !integer(l.max_attempts, 4, 12) ||
    !integer(l.max_turns, 4, 24) ||
    !integer(l.max_tool_calls, 4, 128) ||
    !integer(l.max_concurrent_workers, 1, 2)
  )
    return false;
  const base = {
    question: v.question,
    goal_id: v.goal_id,
    project_id: v.project_id,
    sources: v.sources,
    acceptance_criteria: v.acceptance_criteria,
  };
  // Reuse the strict S05 source/text/criterion and byte/time validation without widening its single-worker limits.
  if (
    !validMissionRequest({
      ...base,
      limits: { ...l, max_attempts: 1, max_turns: 1, max_tool_calls: 1, max_concurrent_workers: 1 },
    })
  )
    return false;
  const root = v as unknown as TeamRequest;
  const ids = new Set<string>();
  for (const raw of v.steps) {
    if (
      !object(raw) ||
      !exact(raw, TEAM_STEP_KEYS) ||
      !id(raw.step_id) ||
      ids.has(raw.step_id) ||
      typeof raw.template_id !== 'string' ||
      !Object.hasOwn(TEAM_TEMPLATES, raw.template_id) ||
      raw.template_version !== 1 ||
      typeof raw.required !== 'boolean' ||
      !integer(raw.max_rework_count, 0, 1) ||
      !Array.isArray(raw.depends_on) ||
      raw.depends_on.length > 5 ||
      !raw.depends_on.every(id) ||
      new Set(raw.depends_on).size !== raw.depends_on.length ||
      !Array.isArray(raw.input_artifact_refs) ||
      raw.input_artifact_refs.length !== raw.depends_on.length ||
      !validMissionRequest({
        ...base,
        sources: raw.sources,
        acceptance_criteria: raw.acceptance_criteria,
        limits: raw.limits,
      })
    )
      return false;
    const s = raw as unknown as TeamStep,
      t = TEAM_TEMPLATES[s.template_id];
    if (
      s.result_schema !== t.resultSchema ||
      s.limits.max_attempts + s.max_rework_count > 3 ||
      s.sources.some(
        (source) => !root.sources.some((r) => r.source_id === source.source_id && r.revision_id === source.revision_id),
      ) ||
      s.acceptance_criteria.some(
        (c) => !root.acceptance_criteria.some((r) => r.id === c.id && r.description === c.description),
      ) ||
      ['wall_seconds', 'context_bytes', 'result_bytes'].some(
        (k) => s.limits[k as keyof MissionLimits] > root.limits[k as keyof TeamLimits],
      )
    )
      return false;
    const refs = new Set<string>();
    for (const ref of raw.input_artifact_refs) {
      if (
        !object(ref) ||
        !exact(ref, ['step_id', 'result_schema']) ||
        !id(ref.step_id) ||
        !s.depends_on.includes(ref.step_id) ||
        refs.has(ref.step_id)
      )
        return false;
      refs.add(ref.step_id);
    }
    ids.add(s.step_id);
  }
  const steps = root.steps,
    byId = new Map(steps.map((s) => [s.step_id, s]));
  if (
    steps.some(
      (s) =>
        s.depends_on.some((d) => !ids.has(d)) ||
        s.input_artifact_refs.some((r) => r.result_schema !== byId.get(r.step_id)?.result_schema),
    ) ||
    !ordered(steps)
  )
    return false;
  for (const key of ['max_attempts', 'max_turns', 'max_tool_calls'] as const) {
    if (
      steps.reduce((sum, s) => sum + s.limits[key] + (key === 'max_attempts' ? s.max_rework_count : 0), 0) >
      root.limits[key]
    )
      return false;
  }
  const writers = steps.filter((s) => s.template_id === 'team-writer');
  const reviewers = steps.filter((s) => s.template_id === 'team-reviewer');
  const analysts = steps.filter((s) => TEAM_TEMPLATES[s.template_id].role === 'analyst');
  if (
    writers.length !== 1 ||
    reviewers.length !== 1 ||
    !writers[0].required ||
    !reviewers[0].required ||
    !analysts.some((s) => s.template_id === 'team-technical-analyst') ||
    !analysts.some((s) => s.template_id === 'team-operational-analyst') ||
    analysts.some((s) => s.depends_on.length !== 0) ||
    reviewers[0].max_rework_count !== 0
  )
    return false;
  const ancestors = (step: TeamStep): Set<string> => {
    const found = new Set<string>(),
      pending = [...step.depends_on];
    while (pending.length) {
      const next = pending.pop()!;
      if (!found.has(next)) {
        found.add(next);
        pending.push(...byId.get(next)!.depends_on);
      }
    }
    return found;
  };
  const writer = writers[0],
    reviewer = reviewers[0],
    wa = ancestors(writer),
    ra = ancestors(reviewer);
  return (
    analysts.every((s) => wa.has(s.step_id)) &&
    ra.has(writer.step_id) &&
    ra.size === steps.length - 1 &&
    [writer, reviewer].every((s) => s.acceptance_criteria.length === root.acceptance_criteria.length)
  );
}
/** Invalid graphs never produce an execution ordering. */
export function teamOrder(request: unknown): string[] | null {
  return validTeamRequest(request) ? ordered(request.steps) : null;
}
