import { expect, it } from 'vitest';
import fs from 'node:fs';
import { validMissionReview, checkMissionReview } from './mission-review.js';
const review = {
  mission_id: 'mission',
  submission_id: '11111111-1111-4111-8111-111111111111',
  result_digest: 'a'.repeat(64),
  expected_version: 4,
  decision: 'accept',
  criteria: [{ id: 'cost', verdict: 'satisfied' }],
};
it('keeps coordinator review validation identical in the worker', () => {
  expect(fs.readFileSync('container/agent-runner/src/mcp-tools/generated/mission-review.ts', 'utf8')).toBe(
    fs.readFileSync('src/modules/chief-of-staff/contracts/mission-review.ts', 'utf8'),
  );
});
it('S05-T08 accepts only bounded coordinator judgements over a pinned result and mission version', () => {
  expect(validMissionReview(review)).toBe(true);
  for (const patch of [
    { owner_id: 'forged' },
    { decision: 'complete' },
    { expected_version: 0 },
    { result_digest: 'bad' },
    { criteria: [{ id: 'cost', verdict: 'satisfied', text: 'replacement answer' }] },
    {
      criteria: [
        { id: 'cost', verdict: 'satisfied' },
        { id: 'cost', verdict: 'not_met' },
      ],
    },
  ])
    expect(validMissionReview({ ...review, ...patch })).toBe(false);
});
it('S05-T08 partial, blocked or incomplete research cannot be promoted to comprehensive completion', () => {
  const checks = {
    status: 'review_required' as const,
    outcome: 'answer' as const,
    criteria: [{ id: 'cost', coverage: 'claimed' as const }],
  };
  expect(checkMissionReview(review, checks)).toBe('completed');
  expect(checkMissionReview(review, { ...checks, outcome: 'partial' })).toBeNull();
  expect(checkMissionReview(review, { ...checks, outcome: 'blocked' })).toBeNull();
  expect(checkMissionReview(review, { ...checks, criteria: [{ id: 'cost', coverage: 'missing' }] })).toBeNull();
  expect(checkMissionReview({ ...review, criteria: [{ id: 'different', verdict: 'satisfied' }] }, checks)).toBeNull();
  expect(
    checkMissionReview({ ...review, decision: 'partial', criteria: [{ id: 'cost', verdict: 'partial' }] }, checks),
  ).toBe('partial');
  expect(
    checkMissionReview(
      { ...review, decision: 'reject', criteria: [{ id: 'cost', verdict: 'not_met' }] },
      { ...checks, outcome: 'blocked', criteria: [{ id: 'cost', coverage: 'missing' }] },
    ),
  ).toBe('blocked');
});
