import fs from 'node:fs';
import { expect, it } from 'vitest';
import { validMissionRuntimeBinding, validMissionRuntimeConfig } from './mission-runtime.js';
const binding = {
  missionId: 'mission-one',
  attemptId: '11111111-1111-4111-8111-111111111111',
  inputId: 'input',
  generation: 1,
  workOrderDigest: 'a'.repeat(64),
  contextDigest: 'b'.repeat(64),
  templateDigest: 'c'.repeat(64),
};
it('S05 specialist launch contract and fixed template have identical baked host/worker copies', () => {
  for (const name of ['mission-runtime.ts', 'research-template.ts'])
    expect(fs.readFileSync('container/agent-runner/src/mcp-tools/generated/' + name, 'utf8')).toBe(
      fs.readFileSync('src/modules/chief-of-staff/contracts/' + name, 'utf8'),
    );
});
it('S05 specialist launch binding refuses forged privileges and requires one exact attempt generation', () => {
  expect(validMissionRuntimeBinding(binding)).toBe(true);
  for (const patch of [
    { owner: true },
    { inputId: '../input' },
    { generation: 0 },
    { attemptId: 'main' },
    { workOrderDigest: 'bad' },
  ])
    expect(validMissionRuntimeBinding({ ...binding, ...patch })).toBe(false);
  const config = {
    provider: 'codex',
    model: 'fixture',
    runtime: 'codex-subscription/v1',
    profile: 'research',
    contextGeneration: binding.attemptId,
    agentGroupId: 'child',
    assistantName: 'CoS Research',
    groupName: 'CoS Research',
    maxMessagesPerPrompt: 1,
    mcpServers: {},
    mission: binding,
  };
  expect(validMissionRuntimeConfig(config)).toBe(true);
  for (const patch of [
    { env: {} },
    { provider: 'claude' },
    { runtime: 'ordinary' },
    { contextGeneration: 'main' },
    { profile: 'coordinator' },
    { maxMessagesPerPrompt: 10 },
    { mcpServers: { generic: {} } },
  ])
    expect(validMissionRuntimeConfig({ ...config, ...patch })).toBe(false);
});
