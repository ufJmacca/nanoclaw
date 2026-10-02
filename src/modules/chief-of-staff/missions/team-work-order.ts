import { canonical, digest } from '../domain/contracts.js';
import { validTeamRequest, TEAM_STEP_KEYS, type TeamStep } from '../contracts/team-protocol.js';
import { TEAM_TEMPLATES } from '../contracts/team-templates.js';
import { validateTeamInputs } from '../contracts/team-inputs.js';
import { validTeamRework, validTeamReworkForStep, type TeamRework } from '../contracts/team-rework.js';
export type { TeamInputArtifact } from '../contracts/team-inputs.js';
import type { TeamWorkOrderBody } from './team-proposal-store.js';
import { RESEARCH_TEMPLATE, sealResearchWorkOrder, type MissionSourceSnapshot } from './work-order.js';
import { MISSION_WORKER_PROTOCOL, validMissionWorkerResponse } from '../contracts/mission-worker-protocol.js';

type TeamLineage = {
  teamId: string;
  generation: number;
  stepId: string;
  workOrderDigest: string;
  step: TeamStep;
  partialPolicy: 'block' | 'allow_labelled';
  dependencyRequirements: Array<{ step_id: string; required: boolean; result_schema: string }>;
  revision?: number;
};
type Input = {
  missionId: string;
  stepId: string;
  rootGeneration: number;
  approved: { body: TeamWorkOrderBody; digest: string; context: { format: string; sources: MissionSourceSnapshot[] } };
  artifacts: unknown[];
  revision?: number;
  rework?: TeamRework;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const child of Object.values(v)) freeze(child);
    Object.freeze(v);
  }
  return v;
}
const stepRequest = (question: string, goal_id: string | null, project_id: string | null, step: TeamStep) => ({
  question,
  goal_id,
  project_id,
  sources: step.sources,
  acceptance_criteria: step.acceptance_criteria,
  limits: { ...step.limits, max_attempts: step.limits.max_attempts + step.max_rework_count },
});
function fitsNativePayload(body: unknown, context: unknown, template: unknown): boolean {
  const requestId = '11111111-1111-4111-8111-111111111111';
  return (
    Buffer.byteLength(JSON.stringify(body)) <= 24576 &&
    Buffer.byteLength(JSON.stringify(context)) <= 65536 &&
    Buffer.byteLength(JSON.stringify(template)) <= 8192 &&
    validMissionWorkerResponse(
      {
        protocol: MISSION_WORKER_PROTOCOL,
        request_id: requestId,
        status: 'ok',
        result: { work_order: body, context, template },
      },
      requestId,
    )
  );
}
/** Pure materialisation only. The host must capture the exact currently approved parent before every dispatch/call. */
export function sealTeamChildWorkOrder(input: unknown) {
  const denied = () => Error('team_child_order_denied');
  if (
    !object(input) ||
    !exact(input, [
      'missionId',
      'stepId',
      'rootGeneration',
      'approved',
      'artifacts',
      ...(Object.hasOwn(input, 'revision') ? ['revision', 'rework'] : []),
    ]) ||
    !object(input.approved) ||
    !exact(input.approved, ['body', 'digest', 'context']) ||
    !object(input.approved.body) ||
    !object(input.approved.context) ||
    !hash(input.approved.digest) ||
    !Number.isSafeInteger(input.rootGeneration) ||
    Number(input.rootGeneration) < 1 ||
    !Array.isArray(input.artifacts)
  )
    throw denied();
  const i = input as unknown as Input,
    b = i.approved.body;
  if (
    !validTeamRequest(b.request) ||
    b.format !== 'cos-team-work-order/v1' ||
    !/^team-[a-f0-9]{64}$/.test(b.teamId) ||
    digest(b) !== i.approved.digest ||
    digest(i.approved.context) !== b.contextDigest ||
    i.approved.context.format !== 'cos-mission-context/v1'
  )
    throw denied();
  const step = b.request.steps.find((s) => s.step_id === i.stepId);
  if (!step) throw denied();
  if (
    i.revision !== undefined &&
    (!Number.isSafeInteger(i.revision) ||
      i.revision < 1 ||
      i.revision > 2 ||
      !validTeamReworkForStep(i.rework, step, i.revision) ||
      !b.request.steps.some((s) => s.step_id === i.rework!.target_step_id) ||
      (i.rework.kind === 'requested_revision' &&
        (i.rework.target_step_id !== step.step_id ||
          step.max_rework_count !== 1 ||
          i.rework.criterion_ids.some((c) => !step.acceptance_criteria.some((a) => a.id === c)))))
  )
    throw denied();
  const template = TEAM_TEMPLATES[step.template_id];
  if (
    !Array.isArray(b.templates) ||
    b.templates.some(
      (t) =>
        !Object.hasOwn(TEAM_TEMPLATES, t.id) ||
        t.version !== 1 ||
        t.digest !== digest(TEAM_TEMPLATES[t.id as keyof typeof TEAM_TEMPLATES]),
    ) ||
    !b.templates.some((t) => t.id === template.id && t.version === template.version && t.digest === digest(template))
  )
    throw denied();
  const lineage: TeamLineage = {
    teamId: b.teamId,
    generation: i.rootGeneration,
    stepId: i.stepId,
    workOrderDigest: i.approved.digest,
    step,
    partialPolicy: b.request.partial_policy,
    dependencyRequirements: step.depends_on
      .map((id) => {
        const dependency = b.request.steps.find((s) => s.step_id === id)!;
        return { step_id: id, required: dependency.required, result_schema: dependency.result_schema };
      })
      .sort((a, b) => a.step_id.localeCompare(b.step_id)),
    ...(i.revision !== undefined ? { revision: i.revision } : {}),
  };
  const artifacts = validateTeamInputs(lineage, i.artifacts, digest);
  if (!artifacts) throw denied();
  try {
    const base = sealResearchWorkOrder({
      missionId: i.missionId,
      request: stepRequest(b.request.question, b.request.goal_id, b.request.project_id, step),
      origin: b.origin,
      related: b.related,
      sources: i.approved.context.sources.filter((s) =>
        step.sources.some((r) => r.source_id === s.source_id && r.revision_id === s.revision_id),
      ),
      provider: b.provider,
      reviewedTemplateDigest: digest(RESEARCH_TEMPLATE),
      issuedAt: b.issuedAt,
    });
    // S05's structural source/identity validation grants no template authority. This child uses only its exact parent-reviewed role.
    if (Date.parse(base.body.deadlineAt) > Date.parse(b.deadlineAt)) throw denied();
    const context: {
      format: string;
      sources: MissionSourceSnapshot[];
      artifacts: typeof artifacts;
      rework?: TeamRework;
    } = {
      format: 'cos-team-child-context/v1',
      sources: base.context.sources,
      artifacts,
      ...(i.rework ? { rework: i.rework } : {}),
    };
    if (Buffer.byteLength(canonical(context), 'utf8') > step.limits.context_bytes) throw denied();
    const body = {
      ...base.body,
      format: 'cos-team-child-work-order/v1',
      template: { id: template.id, version: template.version, digest: digest(template) },
      resultSchema: template.resultSchema,
      contextDigest: digest(context),
      team: lineage,
    };
    const value = { body, context, digest: digest(body) };
    if (!fitsNativePayload(body, context, template)) throw denied();
    return freeze(JSON.parse(JSON.stringify(value)) as typeof value);
  } catch {
    throw denied();
  }
}
export type TeamChildWorkOrder = ReturnType<typeof sealTeamChildWorkOrder>;
/** Structural integrity for native allocation; parent approval/access are separately rechecked through the host store. */
export function validateTeamChildWorkOrder(value: unknown): value is TeamChildWorkOrder {
  if (
    !object(value) ||
    !exact(value, ['body', 'context', 'digest']) ||
    !object(value.body) ||
    !object(value.context) ||
    !hash(value.digest)
  )
    return false;
  const b = value.body,
    c = value.context;
  if (
    !exact(b, [
      'format',
      'missionId',
      'origin',
      'request',
      'related',
      'template',
      'provider',
      'issuedAt',
      'deadlineAt',
      'resultSchema',
      'contextDigest',
      'team',
    ]) ||
    b.format !== 'cos-team-child-work-order/v1' ||
    !exact(c, ['format', 'sources', 'artifacts', ...(Object.hasOwn(c, 'rework') ? ['rework'] : [])]) ||
    c.format !== 'cos-team-child-context/v1' ||
    !Array.isArray(c.sources) ||
    !Array.isArray(c.artifacts) ||
    !object(b.team) ||
    !object(b.request) ||
    !object(b.template) ||
    !exact(b.team, [
      'teamId',
      'generation',
      'stepId',
      'workOrderDigest',
      'step',
      'partialPolicy',
      'dependencyRequirements',
      ...(Object.hasOwn(b.team, 'revision') ? ['revision'] : []),
    ]) ||
    typeof b.team.teamId !== 'string' ||
    !/^team-[a-f0-9]{64}$/.test(b.team.teamId) ||
    !identifier(b.team.stepId) ||
    !hash(b.team.workOrderDigest) ||
    !Number.isSafeInteger(b.team.generation) ||
    Number(b.team.generation) < 1 ||
    (Object.hasOwn(b.team, 'revision')
      ? !Number.isSafeInteger(b.team.revision) ||
        Number(b.team.revision) < 1 ||
        Number(b.team.revision) > 2 ||
        !validTeamRework(c.rework)
      : Object.hasOwn(c, 'rework')) ||
    !object(b.team.step) ||
    !Array.isArray(b.team.dependencyRequirements) ||
    !['block', 'allow_labelled'].includes(String(b.team.partialPolicy))
  )
    return false;
  try {
    const lineage = b.team as unknown as TeamLineage,
      step = lineage.step;
    if (
      !exact(step as unknown as Record<string, unknown>, TEAM_STEP_KEYS) ||
      typeof step.required !== 'boolean' ||
      step.step_id !== lineage.stepId ||
      !Object.hasOwn(TEAM_TEMPLATES, step.template_id) ||
      step.template_version !== 1 ||
      !Array.isArray(step.depends_on) ||
      step.depends_on.length > 5 ||
      !Array.isArray(step.input_artifact_refs) ||
      step.input_artifact_refs.length !== step.depends_on.length ||
      ![0, 1].includes(step.max_rework_count) ||
      (Object.hasOwn(c, 'rework') && !validTeamReworkForStep(c.rework, step, b.team.revision)) ||
      (validTeamRework(c.rework) &&
        c.rework.kind === 'requested_revision' &&
        (c.rework.target_step_id !== step.step_id ||
          step.max_rework_count !== 1 ||
          c.rework.criterion_ids.some((id) => !step.acceptance_criteria.some((a) => a.id === id)))) ||
      !lineage.dependencyRequirements.every(
        (r) =>
          object(r) &&
          exact(r, ['step_id', 'required', 'result_schema']) &&
          typeof r.required === 'boolean' &&
          step.input_artifact_refs.some((ref) => ref.step_id === r.step_id && ref.result_schema === r.result_schema),
      ) ||
      new Set(lineage.dependencyRequirements.map((r) => r.step_id)).size !== step.depends_on.length
    )
      return false;
    const template = TEAM_TEMPLATES[step.template_id],
      artifacts = validateTeamInputs(lineage, c.artifacts, digest);
    if (
      !artifacts ||
      digest(artifacts) !== digest(c.artifacts) ||
      digest(b.template) !== digest({ id: template.id, version: template.version, digest: digest(template) }) ||
      step.result_schema !== template.resultSchema ||
      b.resultSchema !== template.resultSchema ||
      digest(b.request) !==
        digest(
          stepRequest(
            String(b.request.question),
            b.request.goal_id as string | null,
            b.request.project_id as string | null,
            step,
          ),
        )
    )
      return false;
    const base = sealResearchWorkOrder({
      missionId: b.missionId,
      request: b.request,
      origin: b.origin,
      related: b.related,
      sources: c.sources,
      provider: b.provider,
      reviewedTemplateDigest: digest(RESEARCH_TEMPLATE),
      issuedAt: b.issuedAt,
    });
    const expected = {
      ...base.body,
      format: 'cos-team-child-work-order/v1',
      template: b.template,
      resultSchema: template.resultSchema,
      contextDigest: digest(c),
      team: b.team,
    };
    return (
      Buffer.byteLength(canonical(c), 'utf8') <= step.limits.context_bytes &&
      fitsNativePayload(b, c, template) &&
      digest(expected) === value.digest &&
      digest(b) === value.digest
    );
  } catch {
    return false;
  }
}
