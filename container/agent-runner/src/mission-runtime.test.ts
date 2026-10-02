import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { digest } from './mcp-tools/generated/cos-protocol.js';
import { RESEARCH_TEMPLATE } from './mcp-tools/generated/research-template.js';
import { TEAM_TEMPLATES } from './mcp-tools/generated/team-templates.js';
import { loadMissionRuntime } from './mission-runtime.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-runtime-'));
  roots.push(root);
  const context = { format: 'cos-mission-context/v1', sources: [] };
  const body = {
    format: 'cos-research-work-order/v1',
    missionId: 'mission-one',
    provider: { profile: RESEARCH_TEMPLATE.providerProfile, model: 'fixture' },
    template: { digest: digest(RESEARCH_TEMPLATE) },
    contextDigest: digest(context),
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
  };
  const config = {
    provider: 'codex',
    model: 'fixture',
    runtime: 'codex-subscription/v1',
    profile: 'research',
    contextGeneration: '11111111-1111-4111-8111-111111111111',
    agentGroupId: 'child',
    assistantName: 'CoS Research',
    groupName: 'CoS Research',
    maxMessagesPerPrompt: 1,
    mcpServers: {},
    mission: {
      missionId: 'mission-one',
      attemptId: '11111111-1111-4111-8111-111111111111',
      inputId: 'input',
      generation: 1,
      workOrderDigest: digest(body),
      contextDigest: digest(context),
      templateDigest: digest(RESEARCH_TEMPLATE),
    },
  };
  for (const [name, value] of Object.entries({
    'context.json': context,
    'work-order.json': body,
    'template.json': RESEARCH_TEMPLATE,
  }))
    fs.writeFileSync(path.join(root, name), JSON.stringify(value), { mode: 0o400 });
  return { root, config, body, context };
}
test('S05 worker verifies host-pinned artifact digests and uses only the baked reviewed template instructions', () => {
  const f = fixture(),
    loaded = loadMissionRuntime(f.root, f.config);
  expect(loaded.instructions).toBe(RESEARCH_TEMPLATE.instructions);
  expect(loaded.deadlineAt).toBe(f.body.deadlineAt);
  expect(loaded.config).toEqual(f.config);
});
test('S05 worker refuses foreign profile/configuration, changed context, and template substitution', () => {
  for (const patch of [
    { profile: 'coordinator' },
    { mcpServers: { foreign: {} } },
    { contextGeneration: 'main' },
    { mission: { ...fixture().config.mission, attemptId: 'foreign' } },
    { model: 'other' },
  ]) {
    const f = fixture();
    expect(() => loadMissionRuntime(f.root, { ...f.config, ...patch })).toThrow();
  }
  for (const file of ['context.json', 'work-order.json', 'template.json']) {
    const f = fixture(),
      target = path.join(f.root, file);
    fs.chmodSync(target, 0o600);
    fs.writeFileSync(target, '{}');
    fs.chmodSync(target, 0o400);
    expect(() => loadMissionRuntime(f.root, f.config)).toThrow();
  }
});
test('S05 worker rejects writable, hard-linked or symlinked admitted files', () => {
  for (const kind of ['writable', 'link', 'symlink']) {
    const f = fixture(),
      target = path.join(f.root, 'context.json');
    if (kind === 'writable') fs.chmodSync(target, 0o600);
    else if (kind === 'link') fs.linkSync(target, path.join(f.root, 'other'));
    else {
      fs.unlinkSync(target);
      fs.symlinkSync(path.join(f.root, 'work-order.json'), target);
    }
    expect(() => loadMissionRuntime(f.root, f.config)).toThrow();
  }
});
function teamFixture(template: (typeof TEAM_TEMPLATES)[keyof typeof TEAM_TEMPLATES]) {
  const f = fixture();
  const context = { format: 'cos-team-child-context/v1', sources: [], artifacts: [] };
  const body = {
    ...f.body,
    format: 'cos-team-child-work-order/v1',
    resultSchema: template.resultSchema,
    template: { id: template.id, version: 1, digest: digest(template) },
    contextDigest: digest(context),
    team: {
      teamId: 'team-' + 'a'.repeat(64),
      generation: 1,
      stepId: 'step',
      step: {
        step_id: 'step',
        template_id: template.id,
        template_version: 1,
        result_schema: template.resultSchema,
        depends_on: [],
        input_artifact_refs: [],
      },
      partialPolicy: 'block',
      dependencyRequirements: [],
    },
  };
  for (const [name, value] of Object.entries({
    'context.json': context,
    'work-order.json': body,
    'template.json': template,
  })) {
    fs.chmodSync(path.join(f.root, name), 0o600);
    fs.writeFileSync(path.join(f.root, name), JSON.stringify(value));
    fs.chmodSync(path.join(f.root, name), 0o400);
  }
  const config = {
    ...f.config,
    mission: {
      ...f.config.mission,
      workOrderDigest: digest(body),
      contextDigest: digest(context),
      templateDigest: digest(template),
    },
  };
  return { ...f, body, context, config };
}
test('S06 all four team roles start with their exact baked template and pinned schema, without a main context', () => {
  for (const template of Object.values(TEAM_TEMPLATES)) {
    const f = teamFixture(template),
      loaded = loadMissionRuntime(f.root, f.config);
    expect(loaded.instructions).toBe(template.instructions);
    expect(loaded.resultSchema).toBe(template.resultSchema);
  }
});
test('S06 team startup rejects rehashed role/schema substitution and undeclared history or artifacts', () => {
  for (const kind of ['schema', 'role', 'history', 'artifact', 'wrong-context']) {
    const f = teamFixture(TEAM_TEMPLATES['team-reviewer']);
    if (kind === 'schema') f.body.resultSchema = 'cos-research-result/v1';
    if (kind === 'role') f.body.team.step.template_id = 'team-writer';
    if (kind === 'history') Object.assign(f.context, { history: 'main canary' });
    if (kind === 'artifact')
      (f.context.artifacts as unknown[]).push({ step_id: 'private-worker', result: 'private canary' });
    if (kind === 'wrong-context') f.context.format = 'cos-mission-context/v1';
    f.body.contextDigest = digest(f.context);
    f.config.mission.contextDigest = digest(f.context);
    f.config.mission.workOrderDigest = digest(f.body);
    for (const [name, value] of Object.entries({ 'context.json': f.context, 'work-order.json': f.body })) {
      fs.chmodSync(path.join(f.root, name), 0o600);
      fs.writeFileSync(path.join(f.root, name), JSON.stringify(value));
      fs.chmodSync(path.join(f.root, name), 0o400);
    }
    expect(() => loadMissionRuntime(f.root, f.config)).toThrow();
  }
});

test('S06 rework startup rejects rehashed foreign targets, repeated revision and hidden history', () => {
  for (const kind of ['valid', 'foreign-target', 'repeated', 'history', 'limits']) {
    const f = teamFixture(TEAM_TEMPLATES['team-writer']);
    Object.assign(f.body.team, { revision: kind === 'repeated' ? 2 : 1 });
    Object.assign(f.body.team.step, {
      max_rework_count: 1,
      acceptance_criteria: [{ id: 'tradeoff', description: 'Retain both perspectives.' }],
    });
    const rework = {
      kind: 'requested_revision',
      review_mission_id: 'mission-' + 'b'.repeat(64),
      review_submission_id: '22222222-2222-4222-8222-222222222222',
      review_digest: 'c'.repeat(64),
      target_step_id: kind === 'foreign-target' ? 'foreign' : 'step',
      criterion_ids: ['tradeoff'],
      instructions: 'Clarify uncertainty.',
    };
    if (kind === 'history') Object.assign(rework, { history: 'private canary' });
    if (kind === 'limits') Object.assign(rework, { max_turns: 99 });
    Object.assign(f.context, { rework });
    f.body.contextDigest = digest(f.context);
    f.config.mission.contextDigest = digest(f.context);
    f.config.mission.workOrderDigest = digest(f.body);
    for (const [name, value] of Object.entries({ 'context.json': f.context, 'work-order.json': f.body })) {
      fs.chmodSync(path.join(f.root, name), 0o600);
      fs.writeFileSync(path.join(f.root, name), JSON.stringify(value));
      fs.chmodSync(path.join(f.root, name), 0o400);
    }
    if (kind === 'valid') expect(() => loadMissionRuntime(f.root, f.config)).not.toThrow();
    else expect(() => loadMissionRuntime(f.root, f.config)).toThrow();
  }
});
