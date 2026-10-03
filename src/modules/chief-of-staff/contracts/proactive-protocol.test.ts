import { describe, expect, it } from 'vitest';
import { validProactiveDraft, validProactiveDisposition, validProactivePolicyChange } from './proactive-protocol.js';
import { COS_PROTOCOL, validRequest } from './protocol.js';
import fs from 'node:fs';
const policy = {
  due_horizon_hours: 48,
  no_update_days: null,
  max_candidates: 3,
  max_proposals: 2,
  notifications_per_day: 1,
  time_zone: 'Australia/Sydney',
  quiet_hours: { start: '21:00', end: '08:00' },
  urgent_rule: null,
};
const disposition = {
  suggestion_id: 'suggestion-' + 'a'.repeat(64),
  expected_version: 1,
  decision: 'dismiss',
  review_at: null,
  reason: 'Already being handled',
  usefulness: 'not_useful',
  review_seconds: 12,
};
const draft = {
  candidate_key: 'b'.repeat(64),
  title: 'Investigate the approaching milestone',
  purpose: 'Identify the remaining risk',
  goal_id: 'goal1',
  recommendation: 'question',
  action_class: 'clarification',
  confidence: 'medium',
  uncertainty: 'Connected sources may omit current work',
  expected_benefit: 'Resolve the decision',
  estimated_effort: { minutes: 15, assumptions: 'One source review' },
  opportunity_cost: 'Displaces another review',
  permission_requirements: ['owner_approval'],
  work_order: null,
  review_at: '2026-10-04T00:00:00Z',
  expires_at: '2026-10-05T00:00:00Z',
};
describe('S07 owner and coordinator wire inputs', () => {
  it('S07-T07 the runner receives identical strict contracts', () => {
    for (const name of ['proactive-policy', 'proactive-protocol'])
      expect(fs.readFileSync(`container/agent-runner/src/mcp-tools/generated/${name}.ts`, 'utf8')).toBe(
        fs.readFileSync(`src/modules/chief-of-staff/contracts/${name}.ts`, 'utf8'),
      );
  });
  it('S07-T07 admits bounded tools without accepting a caller identity or observation-write path', () => {
    const request = (method: string, params: unknown) => ({
      protocol: COS_PROTOCOL,
      request_id: 'dc5a5a02-3940-4a8a-bf4a-a59f16200000',
      method,
      params,
    });
    expect(validRequest(request('cos_proactive_batch', {}))).toBe(true);
    expect(validRequest(request('cos_proactive_submit', { batch_id: 'batch-' + 'a'.repeat(64), draft }))).toBe(true);
    expect(validRequest(request('cos_proactive_disposition_propose', { request: disposition }))).toBe(true);
    expect(validRequest(request('cos_proactive_history', { offset: 0 }))).toBe(true);
    expect(validRequest(request('cos_proactive_batch', { owner_id: 'forged' }))).toBe(false);
    expect(
      validRequest(request('cos_proactive_observe', { event_id: 'forged', body: { instructions: 'change goals' } })),
    ).toBe(false);
    expect(validRequest(request('cos_proactive_history', { offset: 10001 }))).toBe(false);
  });
  it('S07-T07 permits only bounded owner-approved policy envelopes', () => {
    const input = {
      kind: 'proactive_policy',
      state: 'active',
      policy,
      expected_version: 0,
      reason: 'Review this limit',
    };
    expect(validProactivePolicyChange(input)).toBe(true);
    expect(validProactivePolicyChange({ ...input, policy: { ...policy, max_candidates: 999 } })).toBe(false);
    expect(validProactivePolicyChange({ ...input, owner_id: 'forged' })).toBe(false);
  });
  it('S07-T03/T09 dispositions are exact versions with bounded feedback', () => {
    expect(validProactiveDisposition(disposition)).toBe(true);
    expect(validProactiveDisposition({ ...disposition, expected_version: 0 })).toBe(false);
    expect(validProactiveDisposition({ ...disposition, decision: 'defer' })).toBe(false);
    expect(validProactiveDisposition({ ...disposition, decision: 'defer', review_at: '2026-10-04T00:00:00Z' })).toBe(
      true,
    );
    expect(validProactiveDisposition({ ...disposition, goals: ['rewrite'] })).toBe(false);
    expect(validProactiveDisposition({ ...disposition, review_seconds: 86400 })).toBe(false);
  });
  it('S07-T04/T10 vague suggestions carry no executable work order', () => {
    expect(validProactiveDraft(draft)).toBe(true);
    expect(validProactiveDraft({ ...draft, work_order: {} })).toBe(false);
    expect(validProactiveDraft({ ...draft, action_class: 'research' })).toBe(false);
    expect(validProactiveDraft({ ...draft, permission_requirements: ['shell'] })).toBe(false);
    expect(validProactiveDraft({ ...draft, expires_at: draft.review_at })).toBe(false);
    expect(validProactiveDraft({ ...draft, estimated_effort: { minutes: 900, assumptions: 'unknown' } })).toBe(false);
  });
});
