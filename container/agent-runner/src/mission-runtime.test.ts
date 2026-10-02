import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { digest } from './mcp-tools/generated/cos-protocol.js';
import { RESEARCH_TEMPLATE } from './mcp-tools/generated/research-template.js';
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
