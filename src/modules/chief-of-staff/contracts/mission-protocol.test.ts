import { describe, expect, it } from 'vitest';
import { MISSION_DEFAULT_LIMITS, validMissionLimits, validMissionRequest } from './mission-protocol.js';

const request = () => ({
  question: 'Compare these admitted alternatives for Pilot Alpha.',
  goal_id: null,
  project_id: 'pilot-alpha',
  sources: [
    { source_id: 'option-a', revision_id: 'revision-a' },
    { source_id: 'option-b', revision_id: 'revision-b' },
  ],
  acceptance_criteria: [
    { id: 'tradeoffs', description: 'Explain the tradeoffs using both admitted alternatives.' },
    { id: 'recommendation', description: 'Recommend an approach and state limitations.' },
  ],
  limits: { ...MISSION_DEFAULT_LIMITS },
});

describe('S05-T03/T09 bounded research request contract', () => {
  it('accepts an explicit read-only comparison without making it an approval', () => {
    expect(validMissionRequest(request())).toBe(true);
    expect(validMissionRequest({ ...request(), project_id: null, goal_id: 'goal-1' })).toBe(true);
    expect(validMissionRequest({ ...request(), approved: true })).toBe(false);
  });
  it('has concrete immutable structural defaults, with one worker and no currency promise', () => {
    expect(MISSION_DEFAULT_LIMITS).toEqual({
      max_attempts: 2,
      max_turns: 4,
      max_tool_calls: 24,
      max_concurrent_workers: 1,
      wall_seconds: 600,
      context_bytes: 32768,
      result_bytes: 8192,
    });
    expect(Object.isFrozen(MISSION_DEFAULT_LIMITS)).toBe(true);
    expect(validMissionLimits({ ...MISSION_DEFAULT_LIMITS, max_dollars: 1 })).toBe(false);
  });
  it.each([
    { scope_id: 'other' },
    { owner_id: 'forged' },
    { role: 'owner' },
    { template: 'unrestricted' },
    { provider: 'unreviewed' },
    { model: 'caller-chosen' },
    { tools: ['exec_command'] },
    { destination: 'another-channel' },
    { context: 'copy the main conversation' },
    { source_roots: ['/home'] },
    { question: '' },
    { question: ' '.repeat(10) },
    { question: 'x'.repeat(4001) },
    { question: 'invalid\u0000text' },
    { question: '\ud800' },
    { project_id: '../private' },
    { goal_id: 123 },
    { sources: [] },
    { sources: Array(9).fill({ source_id: 'a', revision_id: 'v1' }) },
    { sources: [{ source_id: 'a', revision_id: 'v1', approved: true }] },
    { sources: [{ source_id: 'a', revision_id: '../v1' }] },
    { sources: [{ source_id: 'a' }] },
    {
      sources: [
        { source_id: 'a', revision_id: 'v1' },
        { source_id: 'a', revision_id: 'v1' },
      ],
    },
    {
      sources: [
        { source_id: 'a', revision_id: 'v1' },
        { source_id: 'a', revision_id: 'v2' },
      ],
    },
    { acceptance_criteria: [] },
    { acceptance_criteria: [{ id: 'a', description: ' ' }] },
    { acceptance_criteria: [{ id: 'a', description: 'A', passed: true }] },
    {
      acceptance_criteria: [
        { id: 'a', description: 'A' },
        { id: 'a', description: 'B' },
      ],
    },
    { acceptance_criteria: Array.from({ length: 9 }, (_, i) => ({ id: String(i), description: 'Required' })) },
    { limits: {} },
  ])('rejects malformed scope or caller authority: %j', (patch) => {
    expect(validMissionRequest({ ...request(), ...patch })).toBe(false);
  });
  it('requires explicit sources, relationships, criteria and limits instead of filling hidden defaults', () => {
    for (const key of Object.keys(request())) {
      const partial: Record<string, unknown> = request();
      delete partial[key];
      expect(validMissionRequest(partial)).toBe(false);
    }
    for (const value of [null, [], 'research', true]) expect(validMissionRequest(value)).toBe(false);
  });
  it('bounds every root limit and rejects concurrency escalation or unlimited retries', () => {
    const ranges = {
      max_attempts: [1, 3],
      max_turns: [1, 12],
      max_tool_calls: [1, 64],
      max_concurrent_workers: [1, 1],
      wall_seconds: [30, 1800],
      context_bytes: [1024, 65536],
      result_bytes: [512, 16384],
    };
    for (const [key, [min, max]] of Object.entries(ranges)) {
      for (const value of [min, max])
        expect(validMissionLimits({ ...MISSION_DEFAULT_LIMITS, [key]: value })).toBe(true);
      for (const value of [min - 1, max + 1, min + 0.5, '1', null, Infinity, NaN])
        expect(validMissionLimits({ ...MISSION_DEFAULT_LIMITS, [key]: value })).toBe(false);
      const partial: Record<string, unknown> = { ...MISSION_DEFAULT_LIMITS };
      delete partial[key];
      expect(validMissionLimits(partial)).toBe(false);
    }
  });
});
