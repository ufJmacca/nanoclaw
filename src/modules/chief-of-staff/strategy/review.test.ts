import { expect, it } from 'vitest';
import {
  validReviewCharterChange,
  validStrategyObservationChange,
  validReviewRequest,
  validReviewDraft,
  type ReviewDraft,
} from '../contracts/strategy-protocol.js';
import {
  assembleReview,
  buildReviewSnapshot,
  outcomeStatus,
  renderReview,
  summarizeReview,
  type ReviewInput,
} from './review.js';
const evidence = '11111111-1111-4111-8111-111111111111';
const observed = '22222222-2222-4222-8222-222222222222';
const record = (id: string) => ({
  scope_id: 'private',
  id,
  version: 1,
  kind: 'project' as const,
  title: id,
  description: 'Approved outcome',
  lifecycle: 'active' as const,
});
function input(): ReviewInput {
  return {
    scope_id: 'private',
    review_id: 'review-' + 'a'.repeat(64),
    revision: 1,
    as_of: '2026-10-06T00:00:00Z',
    charter: {
      version: 1,
      definition: {
        title: 'Review useful outcomes',
        initiative_ids: ['busy', 'useful'],
        source_ids: ['selected'],
        starts_at: '2026-10-01T00:00:00Z',
        ends_at: '2026-12-01T00:00:00Z',
        cadence: 'manual',
        resource_constraints: 'Six hours a week',
        evidence_limits: 'Connected systems cover only part of the work',
        exploration_minutes_per_week: 60,
        measures: [
          {
            id: 'busy-result',
            initiative_id: 'busy',
            outcome: 'A useful decision',
            test: 'The owner can use the decision',
          },
          {
            id: 'useful-result',
            initiative_id: 'useful',
            outcome: 'Less repeated effort',
            test: 'A recorded comparison',
          },
        ],
        assumptions: [
          { id: 'more-tasks', initiative_id: 'busy', statement: 'More completed tasks produce useful results' },
        ],
      },
    },
    records: [record('busy'), record('useful')],
    work: Array.from({ length: 20 }, (_, n) => ({
      scope_id: 'private',
      id: `work-${n}`,
      version: 1,
      kind: 'commitment' as const,
      state: 'completed',
      title: 'Task finished',
      project_id: 'busy',
    })),
    observations: [
      {
        scope_id: 'private',
        id: observed,
        kind: 'strategy_observation',
        charter_version: 1,
        initiative_id: 'useful',
        target: { kind: 'outcome', id: 'useful-result' },
        basis: 'evidence_backed',
        signal: 'supported',
        statement: 'The repeat work decreased',
        observed_at: '2026-10-05T00:00:00Z',
        evidence: [{ kind: 'source', evidence_id: evidence }],
        reason: 'Record a comparison',
      },
    ],
    missions: [],
    source_coverage: [{ scope_id: 'private', source_id: 'selected', version: 1, state: 'available' }],
    source_evidence: [{ scope_id: 'private', source_id: 'selected', evidence_id: evidence }],
    calendar_allocations: [
      { scope_id: 'private', source_id: 'selected', evidence_id: evidence, scheduled_minutes: 120 },
    ],
    decisions: [],
    previous_review: null,
    truncated: false,
  };
}
function draft(): ReviewDraft {
  return {
    findings: [
      {
        kind: 'fact',
        domain: 'activity',
        initiative_id: 'busy',
        statement: 'A recorded task is complete',
        evidence: [{ kind: 'work', work_id: 'work-0', version: 1 }],
        uncertainty: '',
      },
      {
        kind: 'fact',
        domain: 'outcome',
        initiative_id: 'useful',
        statement: 'There is an outcome observation',
        evidence: [{ kind: 'observation', observation_id: observed }],
        uncertainty: 'This comparison is not proof of causation',
      },
      {
        kind: 'assumption',
        domain: 'outcome',
        initiative_id: 'busy',
        statement: 'More tasks may improve the result',
        evidence: [],
        uncertainty: 'That relationship is untested',
      },
      {
        kind: 'recommendation',
        domain: 'other',
        initiative_id: 'busy',
        statement: 'Run a smaller experiment',
        evidence: [],
        uncertainty: 'Its effect is unknown',
      },
    ],
    options: [
      {
        id: 'continue-busy',
        initiative_id: 'busy',
        direction: 'continue',
        title: 'Continue unchanged',
        trade_off: 'No disruption',
        opportunity_cost: 'Less time for exploration',
        next_action: 'Measure the result',
      },
      {
        id: 'change-busy',
        initiative_id: 'busy',
        direction: 'change',
        title: 'Try a smaller experiment',
        trade_off: 'Slower task completion',
        opportunity_cost: 'Defer cosmetic work',
        next_action: 'Ask for exact owner approval',
      },
      {
        id: 'continue-useful',
        initiative_id: 'useful',
        direction: 'continue',
        title: 'Continue unchanged',
        trade_off: 'Keep the current investment',
        opportunity_cost: 'Limited capacity for new ideas',
        next_action: 'Measure again',
      },
    ],
    recommended_option_id: 'change-busy',
    rationale: 'We have activity but little evidence of the desired result',
    confidence: 'low',
    uncertainty: 'Outside progress is not fully observed',
    evidence_would_change: 'A demonstrated useful decision from the existing work',
    forecast_until: '2026-11-01T00:00:00Z',
  };
}
it('S10 charter proposals are bounded and manual cadence does not claim a standing mandate', () => {
  const value = {
    kind: 'review_charter',
    expected_version: 0,
    reason: 'Review outcomes',
    definition: input().charter.definition,
  };
  expect(validReviewCharterChange(value)).toBe(true);
  for (const definition of [
    { ...value.definition, initiative_ids: ['busy', 'busy'] },
    { ...value.definition, source_ids: ['selected', 'selected'] },
    { ...value.definition, ends_at: value.definition.starts_at },
    { ...value.definition, starts_at: '2026-02-30T00:00:00Z' },
    { ...value.definition, cadence: 'weekly' },
    { ...value.definition, exploration_minutes_per_week: 10081 },
    { ...value.definition, measures: [{ ...value.definition.measures[0], initiative_id: 'foreign' }] },
    { ...value.definition, assumptions: [{ ...value.definition.assumptions[0], initiative_id: 'foreign' }] },
  ])
    expect(validReviewCharterChange({ ...value, definition })).toBe(false);
  expect(validReviewCharterChange({ ...value, owner_id: 'forged' })).toBe(false);
});
it('S10 review requests cannot supply scope, context, provider or approval', () => {
  expect(validReviewRequest({ charter_version: 1, previous_review_id: null })).toBe(true);
  expect(validReviewRequest({ charter_version: 1, previous_review_id: 'review-' + 'a'.repeat(64) })).toBe(true);
  for (const extra of ['scope_id', 'owner_id', 'context', 'provider', 'approved'])
    expect(validReviewRequest({ charter_version: 1, previous_review_id: null, [extra]: 'forged' })).toBe(false);
  expect(validReviewRequest({ charter_version: 0, previous_review_id: null })).toBe(false);
  expect(validReviewRequest({ charter_version: 1, previous_review_id: '../../secret' })).toBe(false);
});
it('S10 observations require evidence for an evidence-backed basis and preserve unknown status', () => {
  const { scope_id: _scope, id: _id, ...value } = input().observations[0];
  expect(validStrategyObservationChange(value)).toBe(true);
  expect(validStrategyObservationChange({ ...value, evidence: [] })).toBe(false);
  expect(validStrategyObservationChange({ ...value, basis: 'unknown', signal: 'unknown', evidence: [] })).toBe(true);
  expect(validStrategyObservationChange({ ...value, basis: 'unknown', signal: 'supported', evidence: [] })).toBe(false);
  expect(validStrategyObservationChange({ ...value, basis: 'agent_agreement' })).toBe(false);
  expect(
    validStrategyObservationChange({ ...value, evidence: [{ kind: 'work', work_id: 'work-0', version: 1 }] }),
  ).toBe(false);
});
it('S10-T01 many completed tasks leave the busy initiative outcome unknown', () => {
  const snapshot = buildReviewSnapshot(input());
  expect(snapshot.work).toHaveLength(20);
  expect(outcomeStatus(snapshot, 'busy', 'busy-result')).toBe('unknown');
  expect(outcomeStatus(snapshot, 'useful', 'useful-result')).toBe('evidence_backed');
  const bad = draft();
  bad.findings[0] = { ...bad.findings[0], domain: 'outcome', statement: 'Outcome achieved by task completion' };
  expect(() => assembleReview(snapshot, bad)).toThrow('review_evidence_domain');
});
it('S10-T02 distinct facts, self-reports, assumptions and recommendations stay visible', () => {
  const source = input();
  source.observations[0].basis = 'self_reported';
  const value = draft();
  value.findings[1].kind = 'self_report';
  const snapshot = buildReviewSnapshot(source),
    text = renderReview(assembleReview(snapshot, value));
  expect(outcomeStatus(snapshot, 'useful', 'useful-result')).toBe('self_reported');
  for (const label of ['Fact:', 'Self-report:', 'Assumption:', 'Recommendation:', 'not independently verified'])
    expect(text).toContain(label);
  value.findings[1].kind = 'fact';
  expect(() => assembleReview(snapshot, value)).toThrow('review_evidence_domain');
});
it('S10-T03 consequential claims need evidence or explicit uncertainty', () => {
  const snapshot = buildReviewSnapshot(input()),
    value = draft();
  expect(validReviewDraft(value)).toBe(true);
  value.findings[2].uncertainty = '';
  expect(validReviewDraft(value)).toBe(false);
  expect(() => assembleReview(snapshot, value)).toThrow('review_draft_invalid');
});
it('S10-T06 all review perspectives exclude foreign scope and unselected initiative/source data', () => {
  const source = input();
  source.records.push(record('unselected'), { ...record('busy'), scope_id: 'foreign', title: 'Secret record' });
  source.work.push({ ...source.work[0], scope_id: 'foreign', title: 'Secret work' });
  source.observations.push({ ...source.observations[0], scope_id: 'foreign', statement: 'Secret observation' });
  source.source_evidence.push({ scope_id: 'foreign', source_id: 'selected', evidence_id: 'Secret evidence' });
  source.source_coverage.push({ scope_id: 'foreign', source_id: 'selected', version: 2, state: 'available' });
  source.calendar_allocations.push({ ...source.calendar_allocations[0], scope_id: 'foreign', scheduled_minutes: 999 });
  source.missions.push({
    scope_id: 'private',
    mission_id: 'mission-' + 'b'.repeat(64),
    submission_id: observed,
    digest: 'c'.repeat(64),
    goal_id: null,
    project_id: 'busy',
    source_ids: ['unselected'],
    state: 'completed',
    conclusion: 'Secret specialist result',
    evidence: [],
  });
  source.decisions.push({
    scope_id: 'foreign',
    review_id: source.review_id,
    review_revision: 1,
    initiative_id: 'busy',
    decision: 'approved',
    direction: 'pause',
    rationale: 'Secret decision',
    decided_at: source.as_of,
  });
  const snapshot = buildReviewSnapshot(source),
    serialized = JSON.stringify(snapshot);
  expect(snapshot.initiatives.map((x) => x.id)).toEqual(['busy', 'useful']);
  expect(serialized).not.toContain('Secret');
  expect(serialized).not.toContain('foreign');
  const bad = draft();
  bad.findings[0].initiative_id = 'unselected';
  expect(() => assembleReview(snapshot, bad)).toThrow('review_scope');
});
it('S10-T07 contradictory observations survive synthesis even when a draft omits them', () => {
  const source = input();
  source.observations.push({
    ...source.observations[0],
    id: evidence,
    signal: 'challenged',
    statement: 'The comparison did not repeat',
  });
  const snapshot = buildReviewSnapshot(source),
    text = renderReview(assembleReview(snapshot, draft()));
  expect(outcomeStatus(snapshot, 'useful', 'useful-result')).toBe('conflicting');
  expect(text).toContain('The comparison did not repeat');
  expect(text).toContain('The repeat work decreased');
  expect(text).toContain('Continue unchanged');
  expect(text).toContain('Agreement between agents is not outcome evidence');
});
it('S10-T07 a review cannot remove the continue-unchanged alternative', () => {
  const value = draft();
  value.options = value.options.filter((x) => x.direction !== 'continue');
  expect(() => assembleReview(buildReviewSnapshot(input()), value)).toThrow('review_continue_option');
});
it('S10-T08 scheduled calendar minutes cannot become actual effort or outcome evidence', () => {
  const snapshot = buildReviewSnapshot(input()),
    value = draft();
  value.findings[0] = {
    ...value.findings[0],
    domain: 'calendar_allocation',
    evidence: [{ kind: 'source', evidence_id: evidence }],
    statement: 'Time is scheduled',
  };
  const text = renderReview(assembleReview(snapshot, value));
  expect(text).toContain('120 scheduled minutes');
  expect(text).toContain('Calendar allocation does not establish actual effort or achievement');
  value.findings[0].domain = 'actual_effort';
  expect(() => assembleReview(snapshot, value)).toThrow('review_evidence_domain');
  value.findings[0].domain = 'outcome';
  expect(() => assembleReview(snapshot, value)).toThrow('review_evidence_domain');
});
it('S10-T09 later evidence cannot rewrite the earlier snapshot or turn acceptance into success', () => {
  const source = input(),
    first = assembleReview(buildReviewSnapshot(source), draft()),
    original = JSON.stringify(first);
  source.revision = 2;
  source.previous_review = summarizeReview(first);
  source.as_of = '2026-11-01T00:00:00Z';
  source.observations[0].signal = 'challenged';
  source.observations[0].statement = 'The hoped-for result did not persist';
  source.decisions.push({
    scope_id: 'private',
    review_id: source.review_id,
    review_revision: 1,
    initiative_id: 'busy',
    direction: 'change',
    decision: 'approved',
    rationale: 'Try the experiment',
    decided_at: '2026-10-07T00:00:00Z',
  });
  const later = draft();
  later.forecast_until = '2026-12-01T00:00:00Z';
  const second = assembleReview(buildReviewSnapshot(source), later),
    text = renderReview(second);
  expect(JSON.stringify(first)).toBe(original);
  expect(second.snapshot.revision).toBe(2);
  expect(text).toContain('Try the experiment');
  expect(text).toContain('The hoped-for result did not persist');
  expect(text).toContain('Owner approval is a decision, not a success label');
  expect(text).toContain('Previous recommendation: Try a smaller experiment');
  expect(text).toContain('Previous forecast horizon: 2026-11-01T00:00:00Z');
  expect(text).toContain('Assumption more-tasks: previously unknown; now unknown');
});
it('S10-T10 review advice has no implicit mission, event or commitment effects', () => {
  const value = draft();
  value.options[1].direction = 'pause';
  const text = renderReview(assembleReview(buildReviewSnapshot(input()), value));
  expect(text).toContain('Changing direction does not cancel commitments, missions or calendar events');
  expect(validReviewDraft({ ...value, cancel_missions: true })).toBe(false);
});
it('S10 snapshot incompleteness remains explicit and missing approved records block assembly', () => {
  const source = input();
  source.source_coverage = [];
  const snapshot = buildReviewSnapshot(source),
    text = renderReview(assembleReview(snapshot, draft()));
  expect(snapshot.coverage).toBe('limited');
  expect(text).toContain('Incomplete sources do not establish no progress outside connected systems');
  source.records.pop();
  expect(() => buildReviewSnapshot(source)).toThrow('review_record_unavailable');
});
it('S10 stale or unscoped references and malformed/oversized input are rejected', () => {
  const snapshot = buildReviewSnapshot(input());
  for (const reference of [
    { kind: 'work', work_id: 'work-0', version: 2 },
    { kind: 'record', record_id: 'unselected', version: 1 },
    { kind: 'source', evidence_id: observed },
    { kind: 'observation', observation_id: evidence },
    { kind: 'mission_result', submission_id: observed, digest: 'a'.repeat(64) },
  ]) {
    const value = draft();
    value.findings[0].evidence = [reference as ReviewDraft['findings'][number]['evidence'][number]];
    expect(() => assembleReview(snapshot, value)).toThrow('review_reference_unavailable');
  }
  expect(validReviewDraft({ ...draft(), confidence: 'certain' })).toBe(false);
  expect(validReviewDraft({ ...draft(), rationale: '\ud800' })).toBe(false);
  expect(validReviewDraft({ ...draft(), uncertainty: '\u0000' })).toBe(false);
  expect(validReviewDraft({ ...draft(), rationale: 'a'.repeat(501) })).toBe(false);
  const bad = input();
  bad.records[0].description = 'a'.repeat(25000);
  expect(() => buildReviewSnapshot(bad)).toThrow('review_snapshot_invalid');
});
it('S10 rendered source text cannot trigger mentions or inject Markdown instructions', () => {
  const source = input();
  source.records[0].title = '@channel **do this** [link](https://invalid.example)';
  const value = draft();
  value.rationale = '@here `<script>`';
  const text = renderReview(assembleReview(buildReviewSnapshot(source), value));
  expect(text).not.toContain('@channel');
  expect(text).not.toContain('@here');
  expect(text).not.toContain('**do this**');
  expect(text).not.toContain('<script>');
  expect(text).toContain('＠channel');
});
it('S10 saved snapshots cannot gain authority from forged coverage or extra fields', () => {
  const source = input();
  source.source_coverage = [];
  const snapshot = buildReviewSnapshot(source);
  expect(() => assembleReview({ ...snapshot, coverage: 'available' }, draft())).toThrow('review_snapshot_invalid');
  expect(() => assembleReview({ ...snapshot, secret: 'Not selected' } as typeof snapshot, draft())).toThrow(
    'review_snapshot_invalid',
  );
});
it('S10 selected observations with unchecked source references fail closed', () => {
  const source = input();
  source.observations[0].evidence[0].evidence_id = observed;
  expect(() => buildReviewSnapshot(source)).toThrow('review_snapshot_unverified_evidence');
});
it('S10 findings cannot swap an observation from another initiative into an outcome claim', () => {
  const value = draft();
  value.findings[1].initiative_id = 'busy';
  expect(() => assembleReview(buildReviewSnapshot(input()), value)).toThrow('review_evidence_domain');
});
it('S10 the forecast is bounded by the approved horizon', () => {
  const value = draft();
  value.forecast_until = '2027-01-01T00:00:00Z';
  expect(() => assembleReview(buildReviewSnapshot(input()), value)).toThrow('review_forecast_horizon');
});
it('S10 all ten authorised initiatives can retain their continue-unchanged option', () => {
  const source = input(),
    value = draft();
  for (let n = 0; n < 8; n++) {
    const id = 'initiative-' + n;
    source.charter.definition.initiative_ids.push(id);
    source.charter.definition.measures.push({
      id: 'measure-' + n,
      initiative_id: id,
      outcome: 'Useful result',
      test: 'Observe the result',
    });
    source.records.push(record(id));
    value.options.push({ ...value.options[0], id: 'continue-' + n, initiative_id: id });
  }
  expect(validReviewDraft(value)).toBe(true);
  expect(assembleReview(buildReviewSnapshot(source), value).draft.options).toHaveLength(11);
});
it('S10 historical comparisons require the exact prior revision in the same private scope', () => {
  const source = input(),
    first = assembleReview(buildReviewSnapshot(source), draft());
  source.revision = 2;
  source.previous_review = summarizeReview(first);
  source.previous_review.scope_id = 'foreign';
  expect(() => buildReviewSnapshot(source)).toThrow('review_previous_unavailable');
  source.previous_review.scope_id = 'private';
  source.previous_review.revision = 2;
  expect(() => buildReviewSnapshot(source)).toThrow('review_previous_unavailable');
  source.previous_review = null;
  expect(() => buildReviewSnapshot(source)).toThrow('review_previous_unavailable');
});
it('S10 replacing a review charter preserves old observations without carrying their outcome status into the new charter', () => {
  const source = input();
  source.charter.version = 2;
  source.charter.definition.measures[1].id = 'replacement-result';
  source.charter.definition.measures[1].outcome = 'A different useful result';
  const snapshot = buildReviewSnapshot(source);
  expect(snapshot.observations).toHaveLength(1);
  expect(outcomeStatus(snapshot, 'useful', 'replacement-result')).toBe('unknown');
  const value = draft();
  expect(() => assembleReview(snapshot, value)).toThrow('review_evidence_domain');
  value.findings[1].kind = 'assumption';
  expect(renderReview(assembleReview(snapshot, value))).toContain('Historical observation from charter v1');
});
