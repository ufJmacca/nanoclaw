import type {
  ReviewCharterDefinition,
  ReviewDraft,
  ReviewSourceReference,
  StrategyObservationChange,
  ReviewReference,
  ReviewOption,
} from '../contracts/strategy-protocol.js';
import {
  reviewDigest,
  reviewId,
  reviewIdentifier,
  reviewInstant,
  reviewInteger,
  reviewText,
  reviewUuid,
  validReviewCharterDefinition,
  validReviewDraft,
  validReviewOption,
  validReviewSourceReference,
  validStrategyObservationChange,
} from '../contracts/strategy-protocol.js';
import { digest } from '../domain/contracts.js';

export type ReviewRecord = {
  scope_id: string;
  id: string;
  version: number;
  kind: 'goal' | 'project';
  title: string;
  description: string;
  lifecycle: 'active' | 'inactive';
};
export type ReviewWork = {
  scope_id: string;
  id: string;
  version: number;
  project_id: string | null;
  kind: 'commitment' | 'decision';
  state: string;
  title: string;
};
export type ReviewObservation = StrategyObservationChange & { scope_id: string; id: string };
export type ReviewMission = {
  scope_id: string;
  mission_id: string;
  submission_id: string;
  digest: string;
  goal_id: string | null;
  project_id: string | null;
  source_ids: string[];
  state: 'completed' | 'failed';
  conclusion: string;
  evidence: ReviewSourceReference[];
};
export type ReviewSourceCoverage = {
  scope_id: string;
  source_id: string;
  version: number;
  state: 'available' | 'stale' | 'incomplete' | 'unavailable';
};
export type ReviewDecision = {
  scope_id: string;
  review_id: string;
  review_revision: number;
  initiative_id: string;
  decision: 'approved' | 'rejected';
  direction: 'continue' | 'change' | 'pause' | 'stop';
  rationale: string;
  decided_at: string;
};
export type ReviewPrevious = {
  scope_id: string;
  review_id: string;
  revision: number;
  as_of: string;
  charter_version: number;
  recommended_option: ReviewOption;
  rationale: string;
  confidence: ReviewDraft['confidence'];
  uncertainty: string;
  forecast_until: string;
  assumption_statuses: Array<{ id: string; initiative_id: string; status: OutcomeStatus }>;
};
export type ReviewInput = {
  scope_id: string;
  review_id: string;
  revision: number;
  as_of: string;
  charter: { version: number; definition: ReviewCharterDefinition };
  records: ReviewRecord[];
  work: ReviewWork[];
  observations: ReviewObservation[];
  missions: ReviewMission[];
  source_coverage: ReviewSourceCoverage[];
  source_evidence: Array<{ scope_id: string; source_id: string; evidence_id: string }>;
  calendar_allocations: Array<{ scope_id: string; source_id: string; evidence_id: string; scheduled_minutes: number }>;
  decisions: ReviewDecision[];
  previous_review: ReviewPrevious | null;
  truncated: boolean;
};
export type ReviewSnapshot = Omit<ReviewInput, 'records'> & {
  format: 'cos-strategy-snapshot/v1';
  initiatives: ReviewRecord[];
  coverage: 'limited' | 'no_sources' | 'available';
};
export type ReviewArtifact = {
  format: 'cos-strategy-review/v1';
  snapshot: ReviewSnapshot;
  draft: ReviewDraft;
  owner_disposition: 'awaiting_decision';
};
export type OutcomeStatus = 'unknown' | 'self_reported' | 'evidence_backed' | 'challenged' | 'conflicting';

const bounded = (rows: unknown, maximum: number) => Array.isArray(rows) && rows.length <= maximum;
const unique = <T>(rows: T[], identity: (row: T) => string) => new Set(rows.map(identity)).size === rows.length;
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id, 'en');
const fields = (value: object, names: string[]) =>
  Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
const directions = ['continue', 'change', 'pause', 'stop'];
const before = (value: unknown, asOf: string) => reviewInstant(value) && Date.parse(value) <= Date.parse(asOf);
function observationBody(row: ReviewObservation): StrategyObservationChange {
  const { scope_id: _scope, id: _id, ...body } = row;
  return body;
}
/** Host input only: database completeness/current source permission must be checked by the collector.
 * Selection is repeated here so no foreign row can enter an analyst/challenger snapshot.
 * No pool, model, calendar writer or mission runner is held/called by this pure layer. */
export function buildReviewSnapshot(input: ReviewInput): ReviewSnapshot {
  if (
    !reviewIdentifier(input.scope_id) ||
    !reviewId(input.review_id) ||
    !reviewInteger(input.revision) ||
    !reviewInstant(input.as_of) ||
    !reviewInteger(input.charter?.version) ||
    !validReviewCharterDefinition(input.charter.definition) ||
    Date.parse(input.as_of) < Date.parse(input.charter.definition.starts_at) ||
    Date.parse(input.as_of) > Date.parse(input.charter.definition.ends_at) ||
    typeof input.truncated !== 'boolean' ||
    !bounded(input.records, 100) ||
    !bounded(input.work, 100) ||
    !bounded(input.observations, 100) ||
    !bounded(input.missions, 20) ||
    !bounded(input.source_coverage, 20) ||
    !bounded(input.source_evidence, 100) ||
    !bounded(input.calendar_allocations, 25) ||
    !bounded(input.decisions, 100)
  )
    throw Error('review_snapshot_invalid');
  const definition = input.charter.definition,
    selected = (id: string | null) => id !== null && definition.initiative_ids.includes(id),
    scoped = (row: { scope_id: string }) => row.scope_id === input.scope_id,
    sourceSelected = (id: string) => definition.source_ids.includes(id),
    initiatives = input.records.filter((row) => scoped(row) && selected(row.id)).sort(byId);
  if (initiatives.length !== definition.initiative_ids.length || !unique(initiatives, (row) => row.id))
    throw Error('review_record_unavailable');
  if (
    initiatives.some(
      (row) =>
        !fields(row, ['scope_id', 'id', 'version', 'kind', 'title', 'description', 'lifecycle']) ||
        !reviewInteger(row.version) ||
        !['goal', 'project'].includes(row.kind) ||
        !reviewText(row.title, 200) ||
        !reviewText(row.description, 8000, true) ||
        !['active', 'inactive'].includes(row.lifecycle),
    )
  )
    throw Error('review_snapshot_invalid');
  const work = input.work
      .filter(
        (row) => scoped(row) && initiatives.some((record) => record.kind === 'project' && record.id === row.project_id),
      )
      .sort(byId),
    sourceEvidence = input.source_evidence
      .filter((row) => scoped(row) && sourceSelected(row.source_id))
      .sort((a, b) => a.evidence_id.localeCompare(b.evidence_id, 'en')),
    evidenceAllowed = (ref: ReviewSourceReference) =>
      validReviewSourceReference(ref) && sourceEvidence.some((item) => item.evidence_id === ref.evidence_id),
    observations = input.observations.filter((row) => scoped(row) && selected(row.initiative_id)).sort(byId),
    missions = input.missions
      .filter(
        (row) =>
          scoped(row) &&
          (selected(row.project_id) || selected(row.goal_id)) &&
          (row.project_id === null || selected(row.project_id)) &&
          (row.goal_id === null || selected(row.goal_id)) &&
          row.source_ids.every(sourceSelected),
      )
      .sort((a, b) => a.submission_id.localeCompare(b.submission_id, 'en')),
    sourceCoverage = input.source_coverage
      .filter((row) => scoped(row) && sourceSelected(row.source_id))
      .sort((a, b) => a.source_id.localeCompare(b.source_id, 'en')),
    allocations = input.calendar_allocations
      .filter((row) => scoped(row) && sourceSelected(row.source_id))
      .sort((a, b) => a.evidence_id.localeCompare(b.evidence_id, 'en')),
    decisions = input.decisions
      .filter((row) => scoped(row) && selected(row.initiative_id))
      .sort((a, b) => a.decided_at.localeCompare(b.decided_at, 'en') || a.review_id.localeCompare(b.review_id, 'en'));
  if (
    !unique(work, (row) => row.id) ||
    !unique(sourceEvidence, (row) => row.evidence_id) ||
    !unique(observations, (row) => row.id) ||
    !unique(missions, (row) => row.submission_id) ||
    !unique(sourceCoverage, (row) => row.source_id) ||
    !unique(allocations, (row) => row.evidence_id) ||
    work.some(
      (row) =>
        !fields(row, ['scope_id', 'id', 'version', 'project_id', 'kind', 'state', 'title']) ||
        !reviewIdentifier(row.id) ||
        !reviewInteger(row.version) ||
        !reviewText(row.title, 200) ||
        !(
          row.kind === 'commitment'
            ? ['confirmed', 'completed', 'deferred', 'dismissed']
            : row.kind === 'decision'
              ? ['needed', 'decided', 'deferred', 'dismissed']
              : []
        ).includes(row.state),
    ) ||
    sourceEvidence.some(
      (row) => !fields(row, ['scope_id', 'source_id', 'evidence_id']) || !reviewUuid(row.evidence_id),
    ) ||
    sourceCoverage.some(
      (row) =>
        !fields(row, ['scope_id', 'source_id', 'version', 'state']) ||
        !reviewInteger(row.version) ||
        !['available', 'stale', 'incomplete', 'unavailable'].includes(row.state),
    ) ||
    observations.some(
      (row) =>
        !reviewUuid(row.id) ||
        !validStrategyObservationChange(observationBody(row)) ||
        row.charter_version > input.charter.version ||
        !before(row.observed_at, input.as_of) ||
        (row.target.kind === 'outcome'
          ? !definition.measures.some(
              (measure) => measure.id === row.target.id && measure.initiative_id === row.initiative_id,
            )
          : row.target.kind === 'assumption'
            ? !definition.assumptions.some(
                (assumption) => assumption.id === row.target.id && assumption.initiative_id === row.initiative_id,
              )
            : row.target.id !== row.initiative_id),
    ) ||
    missions.some(
      (row) =>
        !fields(row, [
          'scope_id',
          'mission_id',
          'submission_id',
          'digest',
          'goal_id',
          'project_id',
          'source_ids',
          'state',
          'conclusion',
          'evidence',
        ]) ||
        !/^mission-[a-f0-9]{64}$/.test(row.mission_id) ||
        !reviewUuid(row.submission_id) ||
        !reviewDigest(row.digest) ||
        !bounded(row.source_ids, 6) ||
        !['completed', 'failed'].includes(row.state) ||
        !reviewText(row.conclusion, 1000) ||
        !bounded(row.evidence, 6),
    ) ||
    allocations.some(
      (row) =>
        !fields(row, ['scope_id', 'source_id', 'evidence_id', 'scheduled_minutes']) ||
        !reviewUuid(row.evidence_id) ||
        !reviewInteger(row.scheduled_minutes, 0, 527040),
    ) ||
    decisions.some(
      (row) =>
        !fields(row, [
          'scope_id',
          'review_id',
          'review_revision',
          'initiative_id',
          'decision',
          'direction',
          'rationale',
          'decided_at',
        ]) ||
        !reviewId(row.review_id) ||
        !reviewInteger(row.review_revision) ||
        !['approved', 'rejected'].includes(row.decision) ||
        !directions.includes(row.direction) ||
        !reviewText(row.rationale, 500) ||
        !before(row.decided_at, input.as_of),
    )
  )
    throw Error('review_snapshot_invalid');
  if (
    observations.some((row) => !row.evidence.every(evidenceAllowed)) ||
    missions.some((row) => !row.evidence.every(evidenceAllowed)) ||
    allocations.some(
      (row) => !sourceEvidence.some((e) => e.evidence_id === row.evidence_id && e.source_id === row.source_id),
    )
  )
    throw Error('review_snapshot_unverified_evidence');
  if (input.previous_review === null ? input.revision !== 1 : !validPrevious(input.previous_review, input))
    throw Error('review_previous_unavailable');
  const snapshot: ReviewSnapshot = structuredClone({
    format: 'cos-strategy-snapshot/v1',
    scope_id: input.scope_id,
    review_id: input.review_id,
    revision: input.revision,
    as_of: input.as_of,
    charter: input.charter,
    initiatives,
    work,
    observations,
    missions,
    source_coverage: sourceCoverage,
    source_evidence: sourceEvidence,
    calendar_allocations: allocations,
    decisions,
    previous_review: input.previous_review,
    truncated: input.truncated,
    coverage:
      input.truncated ||
      definition.source_ids.some(
        (id) => !sourceCoverage.some((row) => row.source_id === id && row.state === 'available'),
      )
        ? 'limited'
        : definition.source_ids.length
          ? 'available'
          : 'no_sources',
  });
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 24576) throw Error('review_snapshot_limit');
  return snapshot;
}
function status(observations: ReviewObservation[]): OutcomeStatus {
  const supported = observations.filter((row) => row.signal === 'supported'),
    challenged = observations.some((row) => row.signal === 'challenged');
  return supported.length && challenged
    ? 'conflicting'
    : challenged
      ? 'challenged'
      : supported.some((row) => row.basis === 'evidence_backed')
        ? 'evidence_backed'
        : supported.length
          ? 'self_reported'
          : 'unknown';
}
function validPrevious(previous: ReviewPrevious, input: ReviewInput): boolean {
  return (
    fields(previous, [
      'scope_id',
      'review_id',
      'revision',
      'as_of',
      'charter_version',
      'recommended_option',
      'rationale',
      'confidence',
      'uncertainty',
      'forecast_until',
      'assumption_statuses',
    ]) &&
    previous.scope_id === input.scope_id &&
    previous.review_id === input.review_id &&
    reviewInteger(previous.revision) &&
    previous.revision + 1 === input.revision &&
    before(previous.as_of, input.as_of) &&
    reviewInteger(previous.charter_version) &&
    previous.charter_version <= input.charter.version &&
    validReviewOption(previous.recommended_option) &&
    input.charter.definition.initiative_ids.includes(previous.recommended_option.initiative_id) &&
    reviewText(previous.rationale, 500) &&
    reviewText(previous.uncertainty, 500) &&
    ['low', 'medium', 'high'].includes(previous.confidence) &&
    reviewInstant(previous.forecast_until) &&
    bounded(previous.assumption_statuses, 10) &&
    unique(previous.assumption_statuses, (row) => row.id) &&
    previous.assumption_statuses.every(
      (row) =>
        fields(row, ['id', 'initiative_id', 'status']) &&
        reviewIdentifier(row.id) &&
        input.charter.definition.initiative_ids.includes(row.initiative_id) &&
        ['unknown', 'self_reported', 'evidence_backed', 'challenged', 'conflicting'].includes(row.status),
    )
  );
}
export function outcomeStatus(snapshot: ReviewSnapshot, initiative: string, measure: string): OutcomeStatus {
  return status(
    snapshot.observations.filter(
      (row) => row.initiative_id === initiative && row.target.kind === 'outcome' && row.target.id === measure,
    ),
  );
}
function referenceAvailable(snapshot: ReviewSnapshot, ref: ReviewReference): boolean {
  if (ref.kind === 'source') return snapshot.source_evidence.some((row) => row.evidence_id === ref.evidence_id);
  if (ref.kind === 'record')
    return snapshot.initiatives.some((row) => row.id === ref.record_id && row.version === ref.version);
  if (ref.kind === 'work') return snapshot.work.some((row) => row.id === ref.work_id && row.version === ref.version);
  if (ref.kind === 'observation') return snapshot.observations.some((row) => row.id === ref.observation_id);
  return snapshot.missions.some((row) => row.submission_id === ref.submission_id && row.digest === ref.digest);
}
export function assembleReview(snapshot: ReviewSnapshot, proposed: unknown): ReviewArtifact {
  if (!validReviewDraft(proposed)) throw Error('review_draft_invalid');
  // Reject malformed/augmented retained snapshots. The collector owns current database/source permission checks.
  const rebuilt = buildReviewSnapshot({ ...snapshot, records: snapshot.initiatives });
  if (digest(rebuilt) !== digest(snapshot)) throw Error('review_snapshot_invalid');
  const selected = (id: string) => snapshot.initiatives.some((row) => row.id === id);
  if (
    proposed.findings.some((finding) => !selected(finding.initiative_id)) ||
    proposed.options.some((option) => !selected(option.initiative_id))
  )
    throw Error('review_scope');
  if (proposed.findings.some((finding) => !finding.evidence.every((ref) => referenceAvailable(snapshot, ref))))
    throw Error('review_reference_unavailable');
  for (const finding of proposed.findings) {
    if (!['fact', 'self_report'].includes(finding.kind)) continue;
    const observations = finding.evidence.flatMap((ref) =>
      ref.kind === 'observation'
        ? snapshot.observations.filter(
            (row) => row.id === ref.observation_id && row.initiative_id === finding.initiative_id,
          )
        : [],
    );
    if (['outcome', 'actual_effort', 'attention_cost'].includes(finding.domain)) {
      if (
        !observations.some(
          (row) =>
            row.target.kind === finding.domain &&
            row.basis === (finding.kind === 'fact' ? 'evidence_backed' : 'self_reported'),
        )
      )
        throw Error('review_evidence_domain');
    } else if (finding.kind === 'self_report') {
      if (!observations.some((row) => row.basis === 'self_reported')) throw Error('review_evidence_domain');
    } else if (finding.domain === 'calendar_allocation') {
      if (
        !finding.evidence.some(
          (ref) =>
            ref.kind === 'source' && snapshot.calendar_allocations.some((row) => row.evidence_id === ref.evidence_id),
        )
      )
        throw Error('review_evidence_domain');
    } else if (
      finding.domain === 'activity' &&
      !finding.evidence.some((ref) => ref.kind === 'work' || ref.kind === 'mission_result')
    )
      throw Error('review_evidence_domain');
  }
  if (
    snapshot.initiatives.some(
      (initiative) =>
        !proposed.options.some((option) => option.initiative_id === initiative.id && option.direction === 'continue'),
    )
  )
    throw Error('review_continue_option');
  if (
    Date.parse(proposed.forecast_until) < Date.parse(snapshot.as_of) ||
    Date.parse(proposed.forecast_until) > Date.parse(snapshot.charter.definition.ends_at)
  )
    throw Error('review_forecast_horizon');
  return structuredClone({
    format: 'cos-strategy-review/v1',
    snapshot,
    draft: proposed,
    owner_disposition: 'awaiting_decision',
  });
}
/** Bounded comparison derived from an already verified historical artifact, never from model input. */
export function summarizeReview(review: ReviewArtifact): ReviewPrevious {
  const checked = assembleReview(review.snapshot, review.draft),
    { snapshot, draft } = checked;
  return structuredClone({
    scope_id: snapshot.scope_id,
    review_id: snapshot.review_id,
    revision: snapshot.revision,
    as_of: snapshot.as_of,
    charter_version: snapshot.charter.version,
    recommended_option: draft.options.find((option) => option.id === draft.recommended_option_id)!,
    rationale: draft.rationale,
    confidence: draft.confidence,
    uncertainty: draft.uncertainty,
    forecast_until: draft.forecast_until,
    assumption_statuses: snapshot.charter.definition.assumptions.map((assumption) => ({
      id: assumption.id,
      initiative_id: assumption.initiative_id,
      status: status(
        snapshot.observations.filter(
          (row) =>
            row.initiative_id === assumption.initiative_id &&
            row.target.kind === 'assumption' &&
            row.target.id === assumption.id,
        ),
      ),
    })),
  });
}
const label = (text: string) =>
  text.replaceAll('@', '＠').replace(/[\\`*_{}[\]<>()!]/g, (character) => '\\' + character);
const referenceLabel = (ref: ReviewReference) =>
  ref.kind === 'source'
    ? `source evidence ${ref.evidence_id}`
    : ref.kind === 'record'
      ? `record ${ref.record_id} v${ref.version}`
      : ref.kind === 'work'
        ? `work ${ref.work_id} v${ref.version}`
        : ref.kind === 'observation'
          ? `observation ${ref.observation_id}`
          : `mission submission ${ref.submission_id} digest ${ref.digest}`;
const basisLabel = {
  evidence_backed: 'Evidence-backed observation',
  self_reported: 'Self-reported observation (not independently verified)',
  unknown: 'Unknown observation',
};
const findingLabel = {
  fact: 'Fact',
  self_report: 'Self-report',
  assumption: 'Assumption',
  recommendation: 'Recommendation',
};
function observationLine(row: ReviewObservation) {
  return `- ${basisLabel[row.basis]} [${row.id}]: ${row.target.kind} ${row.target.id}, ${row.signal}. ${label(row.statement)}${
    row.evidence.length ? ' [' + row.evidence.map(referenceLabel).join('; ') + ']' : ' [No independent evidence]'
  } Observed ${row.observed_at}.`;
}
/** Host rendering retains every captured contradiction and past decision regardless of model synthesis. */
export function renderReview(review: ReviewArtifact): string {
  if (review.format !== 'cos-strategy-review/v1' || review.owner_disposition !== 'awaiting_decision')
    throw Error('review_artifact_invalid');
  assembleReview(review.snapshot, review.draft);
  const { snapshot, draft } = review,
    definition = snapshot.charter.definition;
  const output = [
    `CoS strategic review ${snapshot.review_id} revision ${snapshot.revision}`,
    `As of ${snapshot.as_of}; privacy scope ${label(snapshot.scope_id)}; review charter v${snapshot.charter.version}.`,
    `Horizon: ${definition.starts_at} to ${definition.ends_at}. Cadence: manual.`,
    `Resources: ${label(definition.resource_constraints)}. Exploration capacity: ${definition.exploration_minutes_per_week} minutes/week.`,
    `Evidence limits: ${label(definition.evidence_limits)}. Source coverage: ${snapshot.coverage.replaceAll('_', ' ')}.`,
    ...definition.source_ids.map((id) => {
      const source = snapshot.source_coverage.find((row) => row.source_id === id);
      return `- Source ${id}: ${source ? source.state + ' v' + source.version : 'unavailable; no checked snapshot'}.`;
    }),
    'Incomplete sources do not establish no progress outside connected systems.',
    'Recorded activity is not evidence that a desired outcome was achieved. Evidence references do not prove causation.',
    ...snapshot.initiatives.flatMap((initiative) => [
      `Initiative: ${label(initiative.title)} [${initiative.id} v${initiative.version}; ${initiative.lifecycle}]`,
      `Approved description: ${label(initiative.description)}`,
      ...definition.measures
        .filter((measure) => measure.initiative_id === initiative.id)
        .map(
          (measure) =>
            `- Outcome sought: ${label(measure.outcome)} [${measure.id}]. Test: ${label(measure.test)}. Observed status: ${outcomeStatus(snapshot, initiative.id, measure.id).replaceAll('_', ' ')}.`,
        ),
      ...snapshot.work
        .filter((work) => work.project_id === initiative.id)
        .map(
          (work) => `- Recorded ${work.kind}: ${label(work.title)} (${work.state}) [work ${work.id} v${work.version}].`,
        ),
      ...snapshot.observations.filter((row) => row.initiative_id === initiative.id).map(observationLine),
      ...definition.assumptions
        .filter((assumption) => assumption.initiative_id === initiative.id)
        .map((assumption) => {
          const observations = snapshot.observations.filter(
              (row) =>
                row.initiative_id === initiative.id &&
                row.target.kind === 'assumption' &&
                row.target.id === assumption.id,
            ),
            result = status(observations);
          return `- Assumption: ${label(assumption.statement)} [${assumption.id}]. ${
            result === 'unknown'
              ? 'Untested'
              : result === 'conflicting'
                ? 'Challenged: conflicting observations'
                : result === 'challenged'
                  ? 'Challenged'
                  : 'Supported by ' + result.replaceAll('_', ' ') + ' observations'
          }.`;
        }),
    ]),
    'Calendar allocation does not establish actual effort or achievement.',
    ...snapshot.calendar_allocations.map(
      (row) => `- ${row.scheduled_minutes} scheduled minutes [source evidence ${row.evidence_id}].`,
    ),
    'Mission results are advisory and may be incomplete. Agreement between agents is not outcome evidence.',
    ...snapshot.missions.map(
      (row) =>
        `- ${row.state} mission ${row.mission_id}; submission ${row.submission_id}, digest ${row.digest}: ${label(row.conclusion)}`,
    ),
    'Review findings:',
    ...draft.findings.map(
      (finding) =>
        `- ${findingLabel[finding.kind]}: ${label(finding.statement)} [${finding.initiative_id}; ${finding.domain}]. ${
          finding.evidence.length ? finding.evidence.map(referenceLabel).join('; ') : 'No supporting evidence'
        }${finding.uncertainty ? '. Uncertainty: ' + label(finding.uncertainty) : ''}.`,
    ),
    'Options for owner decision:',
    ...draft.options.map(
      (option) =>
        `- ${label(option.title)} [${option.id}; ${option.initiative_id}; ${option.direction}]. Trade-off: ${label(option.trade_off)}. Opportunity cost: ${label(option.opportunity_cost)}. Next action: ${label(option.next_action)}.`,
    ),
    `Recommendation: ${draft.recommended_option_id}. ${label(draft.rationale)}`,
    `Confidence: ${draft.confidence}; forecast horizon: ${draft.forecast_until}. Uncertainty: ${label(draft.uncertainty)}.`,
    `Evidence that would change the recommendation: ${label(draft.evidence_would_change)}.`,
    'Owner disposition for this new revision: awaiting decision. Advice grants no permission to execute work.',
    'Changing direction does not cancel commitments, missions or calendar events. Any consequences require separate exact proposals and approvals.',
    'Prior owner decisions as of this snapshot:',
    ...(snapshot.decisions.length
      ? snapshot.decisions.map(
          (row) =>
            `- ${row.review_id} revision ${row.review_revision}, ${row.initiative_id}: ${row.decision} ${row.direction} at ${row.decided_at}. Rationale: ${label(row.rationale)}.`,
        )
      : ['No prior decisions in this authorised snapshot.']),
    'Owner approval is a decision, not a success label. Later outcomes must be observed separately.',
    ...(snapshot.previous_review
      ? [
          `Comparison with ${snapshot.previous_review.review_id} revision ${snapshot.previous_review.revision} (as of ${snapshot.previous_review.as_of}; charter v${snapshot.previous_review.charter_version}):`,
          `Previous recommendation: ${label(snapshot.previous_review.recommended_option.title)} [${snapshot.previous_review.recommended_option.id}; ${snapshot.previous_review.recommended_option.direction}]. ${label(snapshot.previous_review.rationale)}`,
          `Previous forecast horizon: ${snapshot.previous_review.forecast_until}. Confidence: ${snapshot.previous_review.confidence}; uncertainty: ${label(snapshot.previous_review.uncertainty)}.`,
          ...snapshot.previous_review.assumption_statuses.map((previous) => {
            const current = definition.assumptions.find(
                (assumption) => assumption.id === previous.id && assumption.initiative_id === previous.initiative_id,
              ),
              currentStatus = current
                ? status(
                    snapshot.observations.filter(
                      (row) =>
                        row.initiative_id === current.initiative_id &&
                        row.target.kind === 'assumption' &&
                        row.target.id === current.id,
                    ),
                  )
                : 'not selected in the current charter';
            return `- Assumption ${previous.id}: previously ${previous.status}; now ${currentStatus}.`;
          }),
          'The current outcome observations above describe what was observed later; they do not rewrite the earlier recommendation.',
        ]
      : []),
  ].join('\n');
  if (Buffer.byteLength(output) > 32768) throw Error('review_output_limit');
  return output;
}
