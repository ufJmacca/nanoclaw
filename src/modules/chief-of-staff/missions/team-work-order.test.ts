import { describe, expect, it } from 'vitest';
import { digest } from '../domain/contracts.js';
import { TEAM_TEMPLATES } from '../contracts/team-templates.js';
import { TEAM_DEFAULT_LIMITS, type TeamRequest } from '../contracts/team-protocol.js';
import { MISSION_DEFAULT_LIMITS } from '../contracts/mission-protocol.js';
import type { TeamWorkOrderBody } from './team-proposal-store.js';
import { sealTeamChildWorkOrder, validateTeamChildWorkOrder } from './team-work-order.js';
const source = {
  source_id: 'options',
  revision_id: 'v1',
  source_version: 1,
  revision_digest: digest('source'),
  title: 'Fixture options',
  status: 'current' as const,
  chunks: [{ ordinal: 0, start_line: 1, end_line: 1, text: 'A costs less. B has more capacity.' }],
};
const criterion = { id: 'tradeoff', description: 'Compare cost and capacity.' };
const step = (step_id: string, template_id: keyof typeof TEAM_TEMPLATES, depends_on: string[] = []) => ({
  step_id,
  template_id,
  template_version: 1 as const,
  depends_on,
  input_artifact_refs: depends_on.map((step_id) => ({ step_id, result_schema: 'cos-research-result/v1' })),
  sources: [{ source_id: source.source_id, revision_id: source.revision_id }],
  required: true,
  acceptance_criteria: [criterion],
  result_schema: TEAM_TEMPLATES[template_id].resultSchema as 'cos-research-result/v1' | 'cos-team-review/v1',
  max_rework_count: 0 as 0 | 1,
  limits: { ...MISSION_DEFAULT_LIMITS },
});
function input(stepId = 'technical') {
  const request: TeamRequest = {
    question: 'Compare A and B.',
    goal_id: null,
    project_id: null,
    sources: [{ source_id: source.source_id, revision_id: source.revision_id }],
    acceptance_criteria: [criterion],
    limits: { ...TEAM_DEFAULT_LIMITS },
    partial_policy: 'block',
    steps: [
      step('technical', 'team-technical-analyst'),
      step('operations', 'team-operational-analyst'),
      step('synthesis', 'team-writer', ['technical', 'operations']),
      step('review', 'team-reviewer', ['synthesis']),
    ],
  };
  const context = { format: 'cos-mission-context/v1', sources: [structuredClone(source)] };
  const body: TeamWorkOrderBody = {
    format: 'cos-team-work-order/v1',
    teamId: 'team-' + digest('team'),
    request,
    origin: {
      scopeId: 'scope',
      ownerId: 'owner',
      agentGroupId: 'coordinator',
      sessionId: 'coordinator-session',
      ingressId: 'ingress',
      bindingDigest: digest('binding'),
      delegationDigest: digest('delegation'),
      contextGeneration: '11111111-1111-4111-8111-111111111111',
    },
    related: { goal: null, project: null },
    templates: Object.values(TEAM_TEMPLATES).map((t) => ({ id: t.id, version: t.version, digest: digest(t) })),
    provider: { profile: 'codex-subscription/research-v1', model: 'fixture-codex', policyDigest: digest('policy') },
    issuedAt: '2026-10-02T00:00:00.000Z',
    deadlineAt: '2026-10-02T00:10:00.000Z',
    contextDigest: digest(context),
    authorityDigest: digest('fixture team authority'),
  };
  return {
    missionId: 'mission-' + digest(stepId),
    stepId,
    rootGeneration: 1,
    approved: { body, digest: digest(body), context },
    artifacts: [] as unknown[],
  };
}
const artifact = (step_id: string) => ({
  step_id,
  state: 'submitted',
  mission_id: 'mission-' + digest(step_id),
  submission_id: '22222222-2222-4222-8222-222222222222',
  artifact_id: 'artifact-' + step_id,
  result: {
    format: 'cos-research-result/v1',
    outcome: 'answer',
    claims: [
      {
        id: 'capacity',
        kind: 'inference',
        text: 'B offers more capacity.',
        citations: [{ source_id: 'options', revision_id: 'v1', ordinal: 0, start_line: 1, end_line: 1 }],
      },
    ],
    criteria: [{ id: 'tradeoff', claim_ids: ['capacity'] }],
    limitations: ['Only admitted notes are covered.'],
  },
  result_digest: '',
});
function submitted(id: string) {
  const a = artifact(id);
  a.result_digest = digest(a.result);
  return a;
}
describe('S06-T01/T03/T05 child work order isolation', () => {
  it('pins an independent reviewed analyst template and fresh specialist mission without main history', () => {
    const order = sealTeamChildWorkOrder(input());
    expect(order.body.template.digest).toBe(digest(TEAM_TEMPLATES['team-technical-analyst']));
    expect(order.body.team.stepId).toBe('technical');
    expect(order.context.artifacts).toEqual([]);
    expect(validateTeamChildWorkOrder(order)).toBe(true);
    expect(Object.isFrozen(order.body)).toBe(true);
    expect(JSON.stringify(order)).not.toContain('main_history');
  });
  it('seals an independent copy without freezing or retaining the caller graph', () => {
    const i = input(),
      order = sealTeamChildWorkOrder(i);
    expect(Object.isFrozen(i.approved.body.request.steps[0])).toBe(false);
    i.approved.body.request.steps[0].acceptance_criteria[0] = { ...criterion, description: 'Changed caller graph' };
    expect(order.body.team.step.acceptance_criteria[0].description).toBe('Compare cost and capacity.');
  });
  it('gives the writer exactly its declared submitted dependency results, never private worker history', () => {
    const i = input('synthesis');
    i.artifacts = [submitted('operations'), submitted('technical')];
    const order = sealTeamChildWorkOrder(i);
    expect(order.context.artifacts.map((a) => a.step_id)).toEqual(['operations', 'technical']);
    expect(order.context.sources).toEqual([source]);
    expect(validateTeamChildWorkOrder(order)).toBe(true);
  });
  it.each(['history', 'credentials', 'provider_state', 'workspace', 'source_roots', 'tools'])(
    'rejects artifact %s fields even when dependency content is otherwise valid',
    (key) => {
      const i = input('synthesis');
      i.artifacts = [{ ...submitted('technical'), [key]: 'private' }, submitted('operations')];
      expect(() => sealTeamChildWorkOrder(i)).toThrow('team_child_order_denied');
    },
  );
  it.each([
    (i: ReturnType<typeof input>) => {
      i.stepId = 'unapproved';
    },
    (i: ReturnType<typeof input>) => {
      i.rootGeneration = 0;
    },
    (i: ReturnType<typeof input>) => {
      i.artifacts = [submitted('operations')];
    },
    (i: ReturnType<typeof input>) => {
      i.approved.body.request.steps[0].template_version = 2 as 1;
      i.approved.digest = digest(i.approved.body);
    },
    (i: ReturnType<typeof input>) => {
      i.approved.body.templates[0].digest = digest('changed');
      i.approved.digest = digest(i.approved.body);
    },
    (i: ReturnType<typeof input>) => {
      i.approved.context.sources[0].chunks[0].text = 'tampered';
    },
  ])('rejects unapproved identities, templates, context or inputs (%#)', (change) => {
    const i = input();
    change(i);
    expect(() => sealTeamChildWorkOrder(i)).toThrow('team_child_order_denied');
  });
  it('keeps the original root deadline and shares step turn/tool credits across bounded rework', () => {
    const i = input('synthesis');
    i.approved.body.request.steps[2].max_rework_count = 1;
    i.approved.body.request.limits.max_attempts = 9;
    i.approved.digest = digest(i.approved.body);
    i.artifacts = [submitted('technical'), submitted('operations')];
    const order = sealTeamChildWorkOrder(i);
    expect(order.body.issuedAt).toBe(i.approved.body.issuedAt);
    expect(order.body.deadlineAt).toBe(i.approved.body.deadlineAt);
    expect(order.body.request.limits.max_attempts).toBe(3);
    expect(order.body.request.limits.max_turns).toBe(4);
    expect(order.body.request.limits.max_tool_calls).toBe(24);
  });
  it('requires explicit labelled partial authority before admitting a required failure record', () => {
    const i = input('synthesis');
    i.artifacts = [
      submitted('technical'),
      { step_id: 'operations', state: 'failed', required: true, reason: 'worker_failed' },
    ];
    expect(() => sealTeamChildWorkOrder(i)).toThrow('team_child_order_denied');
    i.approved.body.request.partial_policy = 'allow_labelled';
    i.approved.digest = digest(i.approved.body);
    expect(sealTeamChildWorkOrder(i).context.artifacts[0]).toEqual(i.artifacts[1]);
  });
  it('cannot start synthesis with omitted or duplicated dependency artifacts', () => {
    const i = input('synthesis');
    i.artifacts = [submitted('technical')];
    expect(() => sealTeamChildWorkOrder(i)).toThrow('team_child_order_denied');
    i.artifacts = [submitted('technical'), submitted('technical')];
    expect(() => sealTeamChildWorkOrder(i)).toThrow('team_child_order_denied');
  });
  it('rejects forged submitted result digests and result schemas', () => {
    const i = input('synthesis');
    i.artifacts = [{ ...submitted('technical'), result_digest: digest('forged') }, submitted('operations')];
    expect(() => sealTeamChildWorkOrder(i)).toThrow('team_child_order_denied');
  });
  it('rejects rehashed extra child-context and step fields at native integrity validation', () => {
    const order = sealTeamChildWorkOrder(input());
    for (const target of ['body', 'context', 'step'] as const) {
      const forged = JSON.parse(JSON.stringify(order)) as typeof order;
      const record = target === 'step' ? forged.body.team.step : forged[target];
      (record as unknown as Record<string, unknown>).worker_history = 'unrelated private context';
      forged.body.contextDigest = digest(forged.context);
      forged.digest = digest(forged.body);
      expect(validateTeamChildWorkOrder(forged)).toBe(false);
    }
  });
});
