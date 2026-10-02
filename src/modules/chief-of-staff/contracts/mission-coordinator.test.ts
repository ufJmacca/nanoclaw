import fs from 'node:fs';
import { expect, it } from 'vitest';
import { COS_PROTOCOL, validRequest } from './protocol.js';
import { MISSION_DEFAULT_LIMITS } from './mission-protocol.js';
const request = {
  question: 'Compare admitted alternatives.',
  goal_id: null,
  project_id: null,
  sources: [{ source_id: 'note', revision_id: 'revision' }],
  acceptance_criteria: [{ id: 'tradeoff', description: 'Compare cost and capacity.' }],
  limits: { ...MISSION_DEFAULT_LIMITS },
};
const wire = (method: string, params: unknown) => ({
  protocol: COS_PROTOCOL,
  request_id: '11111111-1111-4111-8111-111111111111',
  method,
  params,
});
it('S05 coordinator accepts bounded proposals and exact mission inspection/cancellation only', () => {
  expect(validRequest(wire('cos_mission_request', { request }))).toBe(true);
  for (const method of ['cos_mission_get', 'cos_mission_cancel']) {
    expect(validRequest(wire(method, { mission_id: 'mission' }))).toBe(true);
    for (const params of [
      {},
      { mission_id: 'mission', scope_id: 'other' },
      { mission_id: 'mission', generation: 2 },
      { mission_id: '../path' },
    ])
      expect(validRequest(wire(method, params))).toBe(false);
  }
  for (const params of [
    { request, approved: true },
    { request: { ...request, template_id: 'privileged' } },
    { request: { ...request, limits: { ...request.limits, max_concurrent_workers: 2 } } },
  ])
    expect(validRequest(wire('cos_mission_request', params))).toBe(false);
  expect(validRequest(wire('cos_result_submit', { result: {} }))).toBe(false);
});
it('keeps canonical mission request validation identical in coordinator workers', () => {
  expect(fs.readFileSync('container/agent-runner/src/mcp-tools/generated/mission-protocol.ts', 'utf8')).toBe(
    fs.readFileSync('src/modules/chief-of-staff/contracts/mission-protocol.ts', 'utf8'),
  );
});
it('S05 coordinator review pins a submission, result digest, mission version and criterion judgements', () => {
  const submission_id = '11111111-1111-4111-8111-111111111111';
  expect(validRequest(wire('cos_mission_result_get', { mission_id: 'mission', submission_id }))).toBe(true);
  expect(
    validRequest(wire('cos_mission_result_get', { mission_id: 'mission', submission_id, artifact_id: 'forged' })),
  ).toBe(false);
  const review = {
    mission_id: 'mission',
    submission_id,
    result_digest: 'a'.repeat(64),
    expected_version: 3,
    decision: 'accept',
    criteria: [{ id: 'cost', verdict: 'satisfied' }],
  };
  expect(validRequest(wire('cos_mission_review', { review }))).toBe(true);
  expect(validRequest(wire('cos_mission_review', { review: { ...review, completed: true } }))).toBe(false);
});
