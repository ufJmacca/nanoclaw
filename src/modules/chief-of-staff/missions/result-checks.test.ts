import { describe, expect, it } from 'vitest';
import { digest } from '../domain/contracts.js';
import { MISSION_DEFAULT_LIMITS } from '../contracts/mission-protocol.js';
import type { MissionResult } from '../contracts/mission-result.js';
import { RESEARCH_TEMPLATE, sealResearchWorkOrder } from './work-order.js';
import { checkResearchResult } from './result-checks.js';

function fixture() {
  const order = sealResearchWorkOrder({
    missionId: 'mission-one',
    request: {
      question: 'Compare admitted options.',
      goal_id: null,
      project_id: null,
      sources: [{ source_id: 'note', revision_id: 'revision' }],
      acceptance_criteria: [{ id: 'tradeoffs', description: 'Compare the options.' }],
      limits: { ...MISSION_DEFAULT_LIMITS },
    },
    origin: {
      scopeId: 'scope',
      ownerId: 'owner',
      sessionId: 'coordinator',
      agentGroupId: 'group',
      ingressId: 'event',
      bindingDigest: 'a'.repeat(64),
      contextGeneration: 'context',
    },
    related: { goal: null, project: null },
    sources: [
      {
        source_id: 'note',
        revision_id: 'revision',
        source_version: 1,
        revision_digest: 'b'.repeat(64),
        title: 'Options',
        status: 'current',
        chunks: [
          { ordinal: 0, start_line: 1, end_line: 2, text: 'Option A is smaller.\nOption B is faster.' },
          { ordinal: 1, start_line: 3, end_line: 3, text: 'Costs are unknown.' },
        ],
      },
    ],
    provider: { profile: RESEARCH_TEMPLATE.providerProfile, model: 'fixture', policyDigest: 'c'.repeat(64) },
    reviewedTemplateDigest: digest(RESEARCH_TEMPLATE),
    issuedAt: '2026-10-02T00:00:00.000Z',
  });
  const result: MissionResult = {
    format: 'cos-research-result/v1',
    outcome: 'answer',
    claims: [
      {
        id: 'claim',
        kind: 'quote',
        text: 'Option B is faster.',
        citations: [{ source_id: 'note', revision_id: 'revision', ordinal: 0, start_line: 2, end_line: 2 }],
      },
    ],
    criteria: [{ id: 'tradeoffs', claim_ids: ['claim'] }],
    limitations: ['Only admitted notes were checked.'],
  };
  return { order, result };
}
describe('S05-T08 result evidence checks do not confer completion', () => {
  it('requires review even when every structural evidence check passes', () => {
    const { order, result } = fixture();
    expect(checkResearchResult(order, result)).toEqual({
      status: 'review_required',
      resultDigest: digest(result),
      workOrderDigest: order.digest,
      contextDigest: order.body.contextDigest,
      outcome: 'answer',
      criteria: [{ id: 'tradeoffs', coverage: 'claimed' }],
    });
  });
  it('refuses another source, revision, chunk or line range, including a real quote on the wrong line', () => {
    for (const patch of [
      { source_id: 'sibling-canary' },
      { revision_id: 'old' },
      { ordinal: 2 },
      { ordinal: 1 },
      { start_line: 1, end_line: 1 },
      { end_line: 3 },
    ]) {
      const { order, result } = fixture();
      Object.assign(result.claims[0].citations[0], patch);
      expect(checkResearchResult(order, result).status).toBe('invalid');
    }
    const { order, result } = fixture();
    result.claims[0].text = 'Option B is FREE.';
    expect(checkResearchResult(order, result).status).toBe('invalid');
  });
  it('labels inference for review without claiming the host proved semantic support', () => {
    const { order, result } = fixture();
    result.claims[0].kind = 'inference';
    result.claims[0].text = 'Prefer B if speed matters more than footprint.';
    expect(checkResearchResult(order, result).status).toBe('review_required');
  });
  it('requires every exact requested criterion, even for partial or blocked results', () => {
    const { order, result } = fixture();
    result.criteria[0].id = 'invented';
    expect(checkResearchResult(order, result).status).toBe('invalid');
    result.outcome = 'blocked';
    result.claims = [];
    result.criteria = [{ id: 'tradeoffs', claim_ids: [] }];
    expect(checkResearchResult(order, result)).toMatchObject({
      status: 'review_required',
      outcome: 'blocked',
      criteria: [{ id: 'tradeoffs', coverage: 'missing' }],
    });
    result.criteria.push({ id: 'invented', claim_ids: [] });
    expect(checkResearchResult(order, result).status).toBe('invalid');
  });
  it('detects altered context and work-order artifacts and enforces the approved result byte cap', () => {
    const { order, result } = fixture();
    const changed = structuredClone(order);
    changed.context.sources[0].chunks[0].text = 'another-canary';
    expect(checkResearchResult(changed, result).status).toBe('invalid');
    const changedOrder = structuredClone(order);
    changedOrder.body.request.question = 'Substituted';
    expect(checkResearchResult(changedOrder, result).status).toBe('invalid');
    const small = structuredClone(order);
    small.body.request.limits.result_bytes = 512;
    small.digest = digest(small.body);
    result.limitations = ['界'.repeat(300)];
    expect(checkResearchResult(small, result).status).toBe('invalid');
  });
});
