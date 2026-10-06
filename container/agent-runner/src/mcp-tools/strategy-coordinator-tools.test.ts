import { expect, test } from 'bun:test';
import { strategyCoordinatorRequest, strategyCoordinatorTools } from './strategy-coordinator-tools.js';
import type { CosRequest } from './generated/cos-protocol.js';
const request_id = '11111111-1111-4111-8111-111111111111',
  review_id = 'review-' + 'a'.repeat(64);
const inputs = {
  cos_review_charter_propose: {
    request_id,
    change: {
      kind: 'review_charter',
      expected_version: 0,
      reason: 'Review a selected initiative',
      definition: {
        title: 'Useful results',
        initiative_ids: ['project'],
        source_ids: [],
        starts_at: '2026-10-01T00:00:00Z',
        ends_at: '2026-11-01T00:00:00Z',
        cadence: 'manual',
        resource_constraints: 'Six hours',
        evidence_limits: 'Missing external work',
        exploration_minutes_per_week: 60,
        measures: [
          { id: 'result', initiative_id: 'project', outcome: 'Useful result', test: 'Owner can use the result' },
        ],
        assumptions: [],
      },
    },
  },
  cos_strategy_observation_propose: {
    request_id,
    change: {
      kind: 'strategy_observation',
      charter_version: 1,
      initiative_id: 'project',
      target: { kind: 'outcome', id: 'result' },
      basis: 'self_reported',
      signal: 'supported',
      statement: 'Owner reports a useful result',
      observed_at: '2026-10-06T00:00:00Z',
      evidence: [],
      reason: 'Retain the owner report',
    },
  },
  cos_strategy_direction_propose: {
    request_id,
    request: {
      review_id,
      revision: 1,
      option_id: 'continue',
      expected_record_version: 2,
      expected_direction_version: 0,
      reason: 'Run a small experiment',
    },
  },
  cos_review_request: { request_id, request: { charter_version: 1, previous_review_id: null } },
  cos_review_submit: {
    request_id,
    review_id,
    revision: 1,
    draft: {
      findings: [
        {
          kind: 'assumption',
          domain: 'outcome',
          initiative_id: 'project',
          statement: 'The result is unknown',
          evidence: [],
          uncertainty: 'Outside work is not connected',
        },
      ],
      options: [
        {
          id: 'continue',
          initiative_id: 'project',
          direction: 'continue',
          title: 'Continue unchanged',
          trade_off: 'Keep current investment',
          opportunity_cost: 'Less exploration',
          next_action: 'Observe the result',
        },
      ],
      recommended_option_id: 'continue',
      rationale: 'Measure before changing direction',
      confidence: 'low',
      uncertainty: 'No result yet',
      evidence_would_change: 'An observed outcome',
      forecast_until: '2026-11-01T00:00:00Z',
    },
  },
  cos_review_get: { review_id, revision: 1, historical: true },
};
test('S10 both catalogs share canonical wire shapes and preserve original request IDs on retries', async () => {
  const calls: CosRequest[] = [],
    tools = strategyCoordinatorTools(async (request) => {
      calls.push(request);
      return { protocol: 'cos-rpc/v1', request_id: request.request_id, status: 'pending' };
    });
  for (const [name, args] of Object.entries(inputs)) {
    const tool = tools.find(({ tool }) => tool.name === name)!;
    const result = await tool.handler(args);
    expect(JSON.stringify(result)).toContain('pending');
    expect(calls.at(-1)?.method).toBe(name);
    if (name !== 'cos_review_get') expect(calls.at(-1)?.request_id).toBe(request_id);
    expect(calls.at(-1)?.params).not.toHaveProperty('request_id');
    expect(strategyCoordinatorRequest(name, args)?.params).toEqual(calls.at(-1)?.params);
  }
});
test('S10 semantic limits and caller authority are rejected before either runner invokes host RPC', () => {
  for (const [name, args] of Object.entries(inputs)) {
    expect(strategyCoordinatorRequest(name, { ...args, owner_id: 'forged' })).toBeNull();
    if (name !== 'cos_review_get') {
      const { request_id: _request, ...without } = args as Record<string, unknown>;
      expect(strategyCoordinatorRequest(name, without)).toBeNull();
    }
  }
  expect(
    strategyCoordinatorRequest('cos_strategy_observation_propose', {
      request_id,
      change: { ...inputs.cos_strategy_observation_propose.change, basis: 'evidence_backed' },
    }),
  ).toBeNull();
  expect(
    strategyCoordinatorRequest('cos_review_charter_propose', {
      request_id,
      change: {
        ...inputs.cos_review_charter_propose.change,
        definition: { ...inputs.cos_review_charter_propose.change.definition, cadence: 'daily' },
      },
    }),
  ).toBeNull();
  for (const tool of ['cos_review_approve', 'cos_review_schedule', 'cos_strategy_apply'])
    expect(strategyCoordinatorRequest(tool, {})).toBeNull();
});
