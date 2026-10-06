import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validProposalChange, validRequest } from './protocol.js';

const charter = {
  kind: 'review_charter',
  expected_version: 0,
  reason: 'Review useful outcomes',
  definition: {
    title: 'Private review',
    initiative_ids: ['project-one'],
    source_ids: [],
    starts_at: '2026-10-01T00:00:00Z',
    ends_at: '2026-10-31T00:00:00Z',
    cadence: 'manual',
    resource_constraints: 'Six hours a week',
    evidence_limits: 'Connected sources only',
    exploration_minutes_per_week: 60,
    measures: [{ id: 'result', initiative_id: 'project-one', outcome: 'A useful result', test: 'Observe the result' }],
    assumptions: [],
  },
};
const observation = {
  kind: 'strategy_observation',
  charter_version: 1,
  initiative_id: 'project-one',
  target: { kind: 'outcome', id: 'result' },
  basis: 'unknown',
  signal: 'unknown',
  statement: 'The result is not observed',
  observed_at: '2026-10-06T00:00:00Z',
  evidence: [],
  reason: 'Preserve uncertainty',
};
const reviewDraft = {
  findings: [
    {
      kind: 'assumption',
      domain: 'outcome',
      initiative_id: 'project-one',
      statement: 'Progress is unknown',
      evidence: [],
      uncertainty: 'Only connected sources were reviewed',
    },
  ],
  options: [
    {
      id: 'continue',
      initiative_id: 'project-one',
      direction: 'continue',
      title: 'Continue unchanged',
      trade_off: 'Observe the outcome',
      opportunity_cost: 'Limited attention',
      next_action: 'Check an outcome observation',
    },
  ],
  recommended_option_id: 'continue',
  rationale: 'Preserve uncertainty',
  confidence: 'low',
  uncertainty: 'No outcome is established',
  evidence_would_change: 'A confirmed outcome observation',
  forecast_until: '2026-10-20T00:00:00Z',
};
const request = (method: string, change: unknown) => ({
  protocol: 'cos-rpc/v1',
  request_id: '11111111-1111-4111-8111-111111111111',
  method,
  params: { change },
});
describe('S10 canonical owner review proposal contracts', () => {
  it.each([
    ['cos_review_request', { request: { charter_version: 1, previous_review_id: null } }],
    ['cos_review_submit', { review_id: 'review-' + 'a'.repeat(64), revision: 1, draft: reviewDraft }],
    ['cos_review_get', { review_id: 'review-' + 'a'.repeat(64), revision: 1 }],
  ])('admits bounded %s inputs while refusing caller identity and private version fences', (method, params) => {
    const value = { ...request(String(method), null), params };
    expect(validRequest(value)).toBe(true);
    for (const field of ['scope_id', 'generation', 'provider', 'version_refs', 'approval', 'snapshot', 'origin'])
      expect(validRequest({ ...value, params: { ...params, [field]: 'forged' } })).toBe(false);
    if (method === 'cos_review_submit')
      expect(
        validRequest({ ...value, params: { ...params, draft: { ...reviewDraft, confidence: 'agent_agreement' } } }),
      ).toBe(false);
    if (method === 'cos_review_get') expect(validRequest({ ...value, params: { ...params, revision: 0 } })).toBe(false);
  });
  it('packages the same bounded review validator in the runner', () => {
    expect(fs.readFileSync('container/agent-runner/src/mcp-tools/generated/strategy-protocol.ts', 'utf8')).toBe(
      fs.readFileSync('src/modules/chief-of-staff/contracts/strategy-protocol.ts', 'utf8'),
    );
  });
  it.each([
    ['cos_review_charter_propose', charter],
    ['cos_strategy_observation_propose', observation],
  ])('admits the dedicated %s proposal without a generic change bypass', (method, change) => {
    expect(validProposalChange(change)).toBe(true);
    expect(validRequest(request(String(method), change))).toBe(true);
    expect(validRequest(request('cos_change_propose', change))).toBe(false);
    expect(validRequest(request('cos_work_change_propose', change))).toBe(false);
  });
  it.each([
    { ...charter, approved: true },
    { ...charter, review_dependencies: { records: [] } },
    { ...charter, definition: { ...charter.definition, cadence: 'daily' } },
    { ...charter, definition: { ...charter.definition, scope_id: 'foreign' } },
    { ...observation, basis: 'agent_agreement' },
    { ...observation, basis: 'evidence_backed' },
    { ...observation, signal: 'supported' },
    { ...observation, statement: '\uD800' },
  ])('denies forged approval, dependency authority and outcome claims', (change) => {
    expect(validProposalChange(change)).toBe(false);
  });
  it.each(['scope_id', 'provider', 'generation', 'origin', 'confirmation_token'])(
    'denies caller-supplied %s',
    (field) => {
      const value = request('cos_review_charter_propose', charter);
      expect(validRequest({ ...value, params: { ...value.params, [field]: 'forged' } })).toBe(false);
    },
  );
  it('bounds the encoded charter before an owner preview can exceed remote storage limits', () => {
    const ids = Array.from({ length: 10 }, (_, index) => 'project-' + index);
    const definition = {
      ...charter.definition,
      initiative_ids: ids,
      measures: ids.map((initiative_id, index) => ({
        id: 'measure-' + index,
        initiative_id,
        outcome: '界'.repeat(500),
        test: '界'.repeat(500),
      })),
      assumptions: ids.map((initiative_id, index) => ({
        id: 'assumption-' + index,
        initiative_id,
        statement: '界'.repeat(500),
      })),
    };
    expect(validProposalChange({ ...charter, definition })).toBe(false);
  });
});
