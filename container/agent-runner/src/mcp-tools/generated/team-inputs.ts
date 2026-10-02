/** Canonical dependency artifact boundary, shared by the host sealer and confined worker startup. */
import { validMissionResult, type MissionResult } from './mission-result.js';
export type TeamInputArtifact =
  | {
      step_id: string;
      state: 'submitted';
      mission_id: string;
      submission_id: string;
      artifact_id: string;
      result_digest: string;
      result: MissionResult;
    }
  | {
      step_id: string;
      state: 'failed';
      required: boolean;
      reason: 'worker_failed' | 'budget_exhausted' | 'missing_coverage';
    };
type Lineage = {
  step: { depends_on: string[] };
  partialPolicy: 'block' | 'allow_labelled';
  dependencyRequirements: Array<{ step_id: string; required: boolean; result_schema: string }>;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
/** Integrity only. A referenced submitted result is never permission to read its source or private context. */
export function validateTeamInputs(
  raw: unknown,
  values: unknown,
  digest: (v: unknown) => string,
): TeamInputArtifact[] | null {
  if (
    !object(raw) ||
    !object(raw.step) ||
    !Array.isArray(raw.step.depends_on) ||
    raw.step.depends_on.length > 5 ||
    !raw.step.depends_on.every(id) ||
    new Set(raw.step.depends_on).size !== raw.step.depends_on.length ||
    !['block', 'allow_labelled'].includes(String(raw.partialPolicy)) ||
    !Array.isArray(raw.dependencyRequirements) ||
    !Array.isArray(values) ||
    values.length !== raw.step.depends_on.length ||
    raw.dependencyRequirements.length !== values.length ||
    !raw.dependencyRequirements.every(
      (r) =>
        object(r) &&
        exact(r, ['step_id', 'required', 'result_schema']) &&
        id(r.step_id) &&
        typeof r.required === 'boolean' &&
        r.result_schema === 'cos-research-result/v1' &&
        (raw.step as { depends_on: string[] }).depends_on.includes(r.step_id),
    ) ||
    new Set(raw.dependencyRequirements.map((r) => r.step_id)).size !== values.length
  )
    return null;
  const lineage = raw as unknown as Lineage,
    seen = new Set<string>(),
    artifacts: TeamInputArtifact[] = [];
  for (const v of values) {
    if (!object(v) || !id(v.step_id) || !lineage.step.depends_on.includes(v.step_id) || seen.has(v.step_id))
      return null;
    const requirement = lineage.dependencyRequirements.find((r) => r.step_id === v.step_id)!;
    if (v.state === 'submitted') {
      if (
        !exact(v, ['step_id', 'state', 'mission_id', 'submission_id', 'artifact_id', 'result_digest', 'result']) ||
        typeof v.mission_id !== 'string' ||
        !/^mission-[a-f0-9]{64}$/.test(v.mission_id) ||
        typeof v.submission_id !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v.submission_id) ||
        typeof v.artifact_id !== 'string' ||
        !/^[a-f0-9]{64}-[a-f0-9]{64}$/.test(v.artifact_id) ||
        !v.artifact_id.endsWith('-' + v.result_digest) ||
        !hash(v.result_digest) ||
        !validMissionResult(v.result) ||
        digest(v.result) !== v.result_digest
      )
        return null;
    } else if (v.state === 'failed') {
      if (
        !exact(v, ['step_id', 'state', 'required', 'reason']) ||
        v.required !== requirement.required ||
        !['worker_failed', 'budget_exhausted', 'missing_coverage'].includes(String(v.reason)) ||
        (requirement.required && lineage.partialPolicy !== 'allow_labelled')
      )
        return null;
    } else return null;
    seen.add(v.step_id);
    artifacts.push(v as TeamInputArtifact);
  }
  return artifacts.sort((a, b) => a.step_id.localeCompare(b.step_id));
}
