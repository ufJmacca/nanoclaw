import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validTeamReview, teamReviewSchema } from './team-review.js';
import { validMissionWorkerRequest } from './mission-worker-protocol.js';

export const reviewFixture = () => ({
  format: 'cos-team-review/v1',
  evidence_validity: [
    {
      step_id: 'synthesis',
      claim_id: 'claim',
      verdict: 'uncertain',
      reason: 'The source supports the comparison, but costs are incomplete.',
    },
  ],
  factual_gaps: ['No independently measured operating cost.'],
  contradictions: [{ step_ids: ['technical', 'operations'], description: 'The analysts favour different options.' }],
  unmet_criteria: ['tradeoff'],
  recommended_revisions: [
    {
      step_id: 'synthesis',
      criterion_ids: ['tradeoff'],
      instructions: 'Show the differing recommendations and qualify costs.',
    },
  ],
  confidence: 'low',
});
describe('S06-T05/T08 bounded advisory review contract', () => {
  it('retains evidence uncertainty, disagreement, gaps, revisions and confidence without approval authority', () => {
    expect(validTeamReview(reviewFixture())).toBe(true);
    expect(teamReviewSchema.additionalProperties).toBe(false);
    for (const name of ['team-review.ts', 'team-templates.ts', 'team-inputs.ts', 'team-rework.ts'])
      expect(fs.readFileSync('container/agent-runner/src/mcp-tools/generated/' + name, 'utf8')).toBe(
        fs.readFileSync('src/modules/chief-of-staff/contracts/' + name, 'utf8'),
      );
  });
  it('rejects authority, foreign context and unknown fields at every nested level', () => {
    for (const patch of [
      { approved: true },
      { outcome: 'completed' },
      { credentials: {} },
      { history: [] },
      { confidence: 'certain' },
    ])
      expect(validTeamReview({ ...reviewFixture(), ...patch })).toBe(false);
    const r = reviewFixture();
    expect(validTeamReview({ ...r, evidence_validity: [{ ...r.evidence_validity[0], citations: [] }] })).toBe(false);
    expect(validTeamReview({ ...r, contradictions: [{ ...r.contradictions[0], private_context: 'sibling' }] })).toBe(
      false,
    );
    expect(validTeamReview({ ...r, recommended_revisions: [{ ...r.recommended_revisions[0], max_turns: 100 }] })).toBe(
      false,
    );
  });
  it('bounds bytes, duplicate evidence, revisions and malformed disagreement', () => {
    const r = reviewFixture();
    for (const patch of [
      { evidence_validity: [r.evidence_validity[0], r.evidence_validity[0]] },
      { contradictions: [{ step_ids: ['technical', 'technical'], description: 'fake' }] },
      { contradictions: [{ step_ids: ['technical'], description: 'not a disagreement' }] },
      { recommended_revisions: [r.recommended_revisions[0], r.recommended_revisions[0]] },
      { factual_gaps: ['x'.repeat(1001)] },
      { factual_gaps: ['bad\u0000text'] },
      { unmet_criteria: ['tradeoff', 'tradeoff'] },
    ])
      expect(validTeamReview({ ...r, ...patch })).toBe(false);
    expect(validTeamReview(r, 512)).toBe(false);
    for (const bound of [0, 16385, Infinity, NaN]) expect(validTeamReview(r, bound)).toBe(false);
  });
  it('uses the existing specialist-only submission transport; host template checks remain mandatory', () => {
    expect(
      validMissionWorkerRequest({
        protocol: 'cos-mission-rpc/v1',
        request_id: '11111111-1111-4111-8111-111111111111',
        method: 'cos_result_submit',
        params: { result: reviewFixture() },
      }),
    ).toBe(true);
  });
});
