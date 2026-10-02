import { describe, expect, it } from 'vitest';
import { MISSION_DEFAULT_LIMITS, validMissionRequest } from './mission-protocol.js';
import { TEAM_DEFAULT_LIMITS, teamOrder, validTeamRequest } from './team-protocol.js';

const source = { source_id: 'options', revision_id: 'v1' };
const criterion = { id: 'recommendation', description: 'Compare technical and operational tradeoffs.' };
const step = (step_id: string, template_id: string, depends_on: string[] = []) => ({
  step_id,
  template_id,
  template_version: 1,
  depends_on,
  input_artifact_refs: depends_on.map((id) => ({ step_id: id, result_schema: 'cos-research-result/v1' })),
  sources: [source],
  required: true,
  acceptance_criteria: [criterion],
  result_schema: template_id === 'team-reviewer' ? 'cos-team-review/v1' : 'cos-research-result/v1',
  max_rework_count: 0,
  limits: { ...MISSION_DEFAULT_LIMITS },
});
const request = () => ({
  question: 'Compare these options using independent technical and operational analysis.',
  goal_id: null,
  project_id: null,
  sources: [source],
  acceptance_criteria: [criterion],
  limits: { ...TEAM_DEFAULT_LIMITS },
  partial_policy: 'block',
  steps: [
    step('technical', 'team-technical-analyst'),
    step('operations', 'team-operational-analyst'),
    step('synthesis', 'team-writer', ['technical', 'operations']),
    step('review', 'team-reviewer', ['synthesis']),
  ],
});

describe('S06-T01/T03 approved bounded team graph contract', () => {
  it('accepts independent analyses followed by one synthesis and review without granting approval', () => {
    expect(validTeamRequest(request())).toBe(true);
    expect(Object.isFrozen(TEAM_DEFAULT_LIMITS)).toBe(true);
    expect(validTeamRequest({ ...request(), approved: true })).toBe(false);
  });
  it('derives deterministic dependency order independent of proposed array order', () => {
    const r = request();
    r.steps.reverse();
    expect(teamOrder(r)).toEqual(['operations', 'technical', 'synthesis', 'review']);
    expect(teamOrder(request())).toEqual(teamOrder(r));
  });
  it.each(['scope_id', 'owner_id', 'provider', 'tools', 'context', 'deadline', 'max_dollars', 'destination'])(
    'rejects caller-supplied %s',
    (key) => expect(validTeamRequest({ ...request(), [key]: 'forged' })).toBe(false),
  );
  it.each([
    (r: ReturnType<typeof request>) => {
      r.steps[0].depends_on = ['review'];
    },
    (r: ReturnType<typeof request>) => {
      r.steps[0].depends_on = ['unknown'];
    },
    (r: ReturnType<typeof request>) => {
      r.steps[2].depends_on.push('technical');
    },
    (r: ReturnType<typeof request>) => {
      r.steps[1].step_id = 'technical';
    },
    (r: ReturnType<typeof request>) => {
      r.steps.push(...r.steps);
    },
    (r: ReturnType<typeof request>) => {
      r.steps[0].template_id = 'shell-agent';
    },
    (r: ReturnType<typeof request>) => {
      r.steps[0].template_version = 2;
    },
    (r: ReturnType<typeof request>) => {
      r.steps[0].sources = [{ ...source, revision_id: 'unapproved' }];
    },
    (r: ReturnType<typeof request>) => {
      r.steps[0].result_schema = 'arbitrary';
    },
    (r: ReturnType<typeof request>) => {
      r.steps[2].input_artifact_refs.push({ step_id: 'review', result_schema: 'cos-team-review/v1' });
    },
    (r: ReturnType<typeof request>) => {
      r.steps[2].input_artifact_refs = [];
    },
    (r: ReturnType<typeof request>) => {
      r.steps[3].required = false;
    },
    (r: ReturnType<typeof request>) => {
      r.steps[2].depends_on = ['technical'];
      r.steps[2].input_artifact_refs = r.steps[2].input_artifact_refs.slice(0, 1);
    },
    (r: ReturnType<typeof request>) => {
      r.steps[3].depends_on = ['technical'];
      r.steps[3].input_artifact_refs = [{ step_id: 'technical', result_schema: 'cos-research-result/v1' }];
    },
    (r: ReturnType<typeof request>) => {
      r.steps[0].max_rework_count = 2;
    },
  ])('rejects graph expansion, invalid joins and unsupported templates (%#)', (change) => {
    const r = request();
    change(r);
    expect(validTeamRequest(r)).toBe(false);
  });
  it.each(['max_attempts', 'max_turns', 'max_tool_calls'] as const)(
    'reserves every step and rework within root %s',
    (key) => {
      const r = request();
      r.limits[key] = 1;
      expect(validTeamRequest(r)).toBe(false);
    },
  );
  it('counts bounded rework in attempts and never grants fresh turn/tool credits', () => {
    const r = request();
    r.steps[2].max_rework_count = 1;
    r.limits.max_attempts = 9;
    expect(validTeamRequest(r)).toBe(true);
    r.limits.max_attempts = 8;
    expect(validTeamRequest(r)).toBe(false);
  });
  it('requires explicit partial policy and preserves optional failure visibility', () => {
    const r = request();
    r.partial_policy = 'allow_labelled';
    r.steps[1].required = false;
    expect(validTeamRequest(r)).toBe(true);
    expect(validTeamRequest({ ...r, partial_policy: 'ignore_failures' })).toBe(false);
  });
  it('reserves coordinator capacity by limiting teams to at most two workers', () => {
    expect(validTeamRequest({ ...request(), limits: { ...TEAM_DEFAULT_LIMITS, max_concurrent_workers: 3 } })).toBe(
      false,
    );
  });
  it('rejects oversized or malformed root input before traversing graphs', () => {
    expect(validTeamRequest(null)).toBe(false);
    expect(validTeamRequest({ ...request(), steps: {} })).toBe(false);
    expect(validTeamRequest({ ...request(), question: '\ud800' })).toBe(false);
  });
});

it('S06-T10 preserves the unchanged S05 single-worker default', () => {
  const r = request();
  const { steps: _steps, partial_policy: _policy, ...single } = r;
  expect(validMissionRequest({ ...single, limits: { ...MISSION_DEFAULT_LIMITS } })).toBe(true);
  expect(validTeamRequest({ ...single, limits: { ...MISSION_DEFAULT_LIMITS } })).toBe(false);
  expect(MISSION_DEFAULT_LIMITS.max_concurrent_workers).toBe(1);
});
