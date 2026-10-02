import { validMissionWorkerResult, type MissionWorkerResult } from './mission-worker-protocol.js';
import { TEAM_TEMPLATES, type TeamTemplateId } from './team-templates.js';

/** Verified submitted evidence, including superseded opinions; never private working histories. */
export type TeamBriefOutput = {
  step_id: string;
  template_id: TeamTemplateId;
  required: boolean;
} & (
  | {
      state: 'submitted';
      mission_id: string;
      submission_id: string;
      artifact_id: string;
      result_digest: string;
      result: MissionWorkerResult;
    }
  | {
      state: 'failed';
      reason: string;
    }
);
export type TeamBrief = {
  format: 'cos-team-brief/v1';
  team_id: string;
  generation: number;
  work_order_digest: string;
  question: string;
  deadline_at: string;
  partial_policy: 'block' | 'allow_labelled';
  acceptance_criteria: Array<{ id: string; description: string }>;
  review_status: 'specialist_opinions_advisory_coordinator_review_required';
  outputs: TeamBriefOutput[];
  superseded_outputs: TeamBriefOutput[];
  limitations: string[];
};

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' &&
  v.trim().length > 0 &&
  v.length <= max &&
  Buffer.from(v).toString('utf8') === v &&
  [...v].every((c) => {
    const n = c.codePointAt(0)!;
    return (n >= 32 || n === 10 || n === 9) && (n < 127 || n > 159);
  });
function validOutput(v: unknown): v is TeamBriefOutput {
  if (
    !object(v) ||
    !id(v.step_id) ||
    !id(v.template_id) ||
    !Object.hasOwn(TEAM_TEMPLATES, v.template_id) ||
    typeof v.required !== 'boolean'
  )
    return false;
  if (v.state === 'failed')
    return (
      exact(v, ['step_id', 'template_id', 'required', 'state', 'reason']) &&
      ['worker_failed', 'budget_exhausted', 'deadline', 'missing_coverage'].includes(String(v.reason))
    );
  return (
    v.state === 'submitted' &&
    exact(v, [
      'step_id',
      'template_id',
      'required',
      'state',
      'mission_id',
      'submission_id',
      'artifact_id',
      'result_digest',
      'result',
    ]) &&
    id(v.mission_id) &&
    uuid(v.submission_id) &&
    typeof v.artifact_id === 'string' &&
    /^[a-f0-9]{64}-[a-f0-9]{64}$/.test(v.artifact_id) &&
    hash(v.result_digest) &&
    validMissionWorkerResult(v.result) &&
    v.result.format === TEAM_TEMPLATES[v.template_id as TeamTemplateId].resultSchema
  );
}
/** Syntax only. Publication still requires current source permission, immutable artifacts and recorded coordinator review. */
export function validTeamBrief(v: unknown): v is TeamBrief {
  if (
    !object(v) ||
    !exact(v, [
      'format',
      'team_id',
      'generation',
      'work_order_digest',
      'question',
      'deadline_at',
      'partial_policy',
      'acceptance_criteria',
      'review_status',
      'outputs',
      'superseded_outputs',
      'limitations',
    ]) ||
    v.format !== 'cos-team-brief/v1' ||
    !id(v.team_id) ||
    !v.team_id.startsWith('team-') ||
    !Number.isSafeInteger(v.generation) ||
    Number(v.generation) < 1 ||
    !hash(v.work_order_digest) ||
    !text(v.question, 4000) ||
    typeof v.deadline_at !== 'string' ||
    !Number.isFinite(Date.parse(v.deadline_at)) ||
    !['block', 'allow_labelled'].includes(String(v.partial_policy)) ||
    v.review_status !== 'specialist_opinions_advisory_coordinator_review_required' ||
    !Array.isArray(v.acceptance_criteria) ||
    v.acceptance_criteria.length < 1 ||
    v.acceptance_criteria.length > 8 ||
    !v.acceptance_criteria.every(
      (c) => object(c) && exact(c, ['id', 'description']) && id(c.id) && text(c.description, 1000),
    ) ||
    !Array.isArray(v.outputs) ||
    v.outputs.length < 4 ||
    v.outputs.length > 6 ||
    !v.outputs.every(validOutput) ||
    !Array.isArray(v.superseded_outputs) ||
    v.superseded_outputs.length > 12 ||
    !v.superseded_outputs.every((o) => validOutput(o) && o.state === 'submitted') ||
    !Array.isArray(v.limitations) ||
    v.limitations.length > 8 ||
    !v.limitations.every((s) => text(s, 1000))
  )
    return false;
  const b = v as TeamBrief;
  if (
    new Set(b.outputs.map((o) => o.step_id)).size !== b.outputs.length ||
    new Set(b.acceptance_criteria.map((c) => c.id)).size !== b.acceptance_criteria.length
  )
    return false;
  for (const template of ['team-writer', 'team-reviewer']) {
    const outputs = b.outputs.filter((o) => o.template_id === template);
    if (outputs.length !== 1 || !outputs[0].required) return false;
  }
  if (
    !b.outputs.some((o) => o.template_id === 'team-technical-analyst') ||
    !b.outputs.some((o) => o.template_id === 'team-operational-analyst')
  )
    return false;
  if (
    b.superseded_outputs.some(
      (o) =>
        !b.outputs.some(
          (current) =>
            current.step_id === o.step_id && current.template_id === o.template_id && current.required === o.required,
        ),
    )
  )
    return false;
  const submitted = [...b.outputs, ...b.superseded_outputs].filter((o) => o.state === 'submitted');
  return (
    new Set(submitted.map((o) => o.submission_id)).size === submitted.length &&
    Buffer.byteLength(JSON.stringify(v), 'utf8') <= 65536
  );
}
