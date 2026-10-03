import { Temporal } from '@js-temporal/polyfill';
import { digest, canonical, type WorkDue } from '../contracts/protocol.js';
import { validProactivePolicy, type ProactivePolicy } from '../contracts/proactive-policy.js';
import type { BriefSnapshot, BriefRecord, BriefReference, BriefWork } from './brief-snapshot.js';
export type { ProactivePolicy } from '../contracts/proactive-policy.js';
/** Produced only from host-recorded versions, never accepted through an agent observation-write tool. */
export type ProactiveObservation = {
  event_id: string;
  kind: 'source_revision' | 'calendar_snapshot' | 'commitment_transition' | 'mission_outcome';
  resource_id: string;
  resource_version: number;
  project_id: string | null;
  observed_at: string;
  material_digest: string;
  provenance: Record<string, unknown>;
};
export type ProactiveDisposition = {
  semantic_key: string;
  status: 'open' | 'accepted' | 'deferred' | 'dismissed';
  review_at: string | null;
};
export type ProactiveCandidate = {
  rule: 'confirmed_due' | 'decision_review' | 'unresolved_dependency' | 'no_observed_update';
  target_id: string;
  target_kind: 'commitment' | 'decision' | 'project';
  target_version: number;
  project_id: string | null;
  title: string;
  reason: string;
  due_at: string | null;
  evidence: BriefReference[];
  observation_ids: string[];
  material_digest: string;
  semantic_key: string;
  family_key: string;
};
const instant = (s: string) => Temporal.Instant.from(s);
const dueInstant = (due: WorkDue) =>
  due.kind === 'instant'
    ? instant(due.at)
    : Temporal.PlainDate.from(due.date).add({ days: 1 }).toZonedDateTime(due.time_zone).toInstant();
/** Incidental model phrasing and transport event IDs are deliberately excluded. */
export function semanticProposalKey(input: {
  rule: string;
  target_id: string;
  action_class: string;
  material_digest: string;
}): string {
  return digest({
    rule: input.rule,
    target_id: input.target_id,
    action_class: input.action_class,
    material_digest: input.material_digest,
  });
}
function latestObservations(observations: ProactiveObservation[], now: Temporal.Instant) {
  const latest = new Map<string, ProactiveObservation>();
  for (const observation of observations) {
    if (
      !['source_revision', 'calendar_snapshot', 'commitment_transition', 'mission_outcome'].includes(
        observation.kind,
      ) ||
      !Number.isSafeInteger(observation.resource_version) ||
      observation.resource_version < 1 ||
      !/^[a-f0-9]{64}$/.test(observation.material_digest)
    )
      throw Error('invalid_proactive_observation');
    const at = instant(observation.observed_at);
    if (Temporal.Instant.compare(at, now) > 0) continue;
    const key = canonical([observation.kind, observation.resource_id]),
      previous = latest.get(key);
    if (
      previous &&
      previous.resource_version === observation.resource_version &&
      previous.material_digest !== observation.material_digest
    )
      throw Error('conflicting_proactive_observation');
    if (
      !previous ||
      previous.resource_version < observation.resource_version ||
      (previous.resource_version === observation.resource_version &&
        Temporal.Instant.compare(instant(previous.observed_at), at) < 0)
    )
      latest.set(key, observation);
  }
  return [...latest.values()].sort((a, b) =>
    canonical([a.kind, a.resource_id]).localeCompare(canonical([b.kind, b.resource_id]), 'en'),
  );
}
/** Deterministic prefilter over a bounded, currently authorised snapshot; it does not create or authorise work. */
export function selectProactiveCandidates(input: {
  snapshot: BriefSnapshot;
  records: BriefRecord[];
  observations: ProactiveObservation[];
  dispositions: ProactiveDisposition[];
  policy: ProactivePolicy;
  now: string;
}): ProactiveCandidate[] {
  const { snapshot, records, policy } = input;
  if (!validProactivePolicy(policy)) throw Error('invalid_proactive_policy');
  if (
    records.length > 100 ||
    snapshot.commitments.length + snapshot.decisions.length > 100 ||
    input.observations.length > 500 ||
    input.dispositions.length > 1000
  )
    throw Error('proactive_input_limit');
  if (!records.some((r) => r.kind === 'goal' && r.lifecycle === 'active') || policy.max_proposals === 0) return [];
  const now = instant(input.now),
    horizon = now.add({ hours: policy.due_horizon_hours }),
    projects = records.filter((r) => r.kind === 'project' && r.lifecycle === 'active'),
    observations = latestObservations(input.observations, now),
    candidates: ProactiveCandidate[] = [];
  const add = (item: {
    rule: ProactiveCandidate['rule'];
    id: string;
    kind: ProactiveCandidate['target_kind'];
    version: number;
    project_id: string | null;
    title: string;
    reason: string;
    due_at: string | null;
    evidence: BriefReference[];
    material: unknown;
  }) => {
    const relevant = observations.filter((o) => o.project_id === item.project_id),
      material_digest = digest({
        rule: item.rule,
        target: item.id,
        material: item.material,
        observations: relevant.map((o) => ({
          kind: o.kind,
          resource_id: o.resource_id,
          material_digest: o.material_digest,
        })),
      }),
      semantic_key = semanticProposalKey({
        rule: item.rule,
        target_id: item.id,
        action_class: 'research',
        material_digest,
      });
    const dispositions = input.dispositions.filter((d) => d.semantic_key === semantic_key);
    if (
      dispositions.some(
        (d) => d.status !== 'deferred' || !d.review_at || Temporal.Instant.compare(instant(d.review_at), now) > 0,
      )
    )
      return;
    candidates.push({
      rule: item.rule,
      target_id: item.id,
      target_kind: item.kind,
      target_version: item.version,
      project_id: item.project_id,
      title: item.title,
      reason: item.reason,
      due_at: item.due_at,
      evidence: item.evidence,
      observation_ids: [...new Set(relevant.map((o) => o.event_id))].sort(),
      material_digest,
      semantic_key,
      family_key: digest({ rule: item.rule, target_id: item.id }),
    });
  };
  const eligible = (work: BriefWork) => !work.project_id || projects.some((p) => p.id === work.project_id);
  const workMaterial = (work: BriefWork) => ({
    kind: work.kind,
    state: work.state,
    project_id: work.project_id,
    due: work.due,
    evidence: work.evidence
      .map((e) =>
        e.kind === 'record' ? { kind: e.kind, record_id: e.record_id } : { kind: e.kind, evidence_id: e.evidence_id },
      )
      .sort((a, b) => canonical(a).localeCompare(canonical(b), 'en')),
  });
  for (const work of [...snapshot.commitments, ...snapshot.decisions]) {
    if (!eligible(work)) continue;
    const due = work.due ? dueInstant(work.due) : null;
    const rule =
      work.kind === 'commitment' && work.state === 'confirmed' && due && Temporal.Instant.compare(due, horizon) <= 0
        ? 'confirmed_due'
        : work.kind === 'decision' && work.state === 'needed'
          ? !due
            ? 'unresolved_dependency'
            : Temporal.Instant.compare(due, now) <= 0
              ? 'decision_review'
              : null
          : null;
    if (!rule) continue;
    add({
      rule,
      id: work.id,
      kind: work.kind,
      version: work.version,
      project_id: work.project_id,
      title: work.title,
      reason:
        rule === 'confirmed_due'
          ? 'A confirmed due date is approaching or overdue.'
          : rule === 'decision_review'
            ? 'The recorded decision review is due.'
            : 'A recorded decision remains unresolved.',
      due_at: due?.toString() ?? null,
      evidence: [{ kind: 'work', work_id: work.id, version: work.version }, ...work.evidence],
      material: workMaterial(work),
    });
  }
  if (
    policy.no_update_days !== null &&
    snapshot.coverage.knowledge === 'available' &&
    snapshot.coverage.calendar === 'available' &&
    !snapshot.coverage.truncated &&
    snapshot.coverage.withheld === 0 &&
    snapshot.coverage.refresh === 'complete'
  ) {
    for (const project of projects) {
      const connected = observations.filter(
        (o) => o.project_id === project.id && ['source_revision', 'calendar_snapshot'].includes(o.kind),
      );
      if (!connected.length) continue;
      const latest = connected.reduce(
        (at, o) => (Temporal.Instant.compare(at, instant(o.observed_at)) >= 0 ? at : instant(o.observed_at)),
        instant(connected[0].observed_at),
      );
      if (Temporal.Instant.compare(latest.add({ hours: policy.no_update_days * 24 }), now) > 0) continue;
      add({
        rule: 'no_observed_update',
        id: project.id,
        kind: 'project',
        version: project.version,
        project_id: project.id,
        title: project.title,
        reason: `No progress observed in connected sources since ${latest.toString()}; this is not proof that no work happened.`,
        due_at: null,
        evidence: [{ kind: 'record', record_id: project.id, version: project.version }],
        material: { interval_days: policy.no_update_days },
      });
    }
  }
  const ranks = { confirmed_due: 0, decision_review: 1, unresolved_dependency: 2, no_observed_update: 3 };
  return candidates
    .sort(
      (a, b) =>
        ranks[a.rule] - ranks[b.rule] ||
        (a.due_at ?? '').localeCompare(b.due_at ?? '', 'en') ||
        a.target_id.localeCompare(b.target_id, 'en'),
    )
    .slice(0, policy.max_candidates);
}

/** The caller reserves the returned local-date budget durably before delivering one digest. */
export function planProposalNotification(
  candidate: ProactiveCandidate,
  policy: ProactivePolicy,
  now: string,
  used: number,
): {
  allowed: boolean;
  route: 'digest' | 'interruption';
  local_date: string;
} {
  if (!validProactivePolicy(policy) || !Number.isSafeInteger(used) || used < 0) throw Error('invalid_proactive_policy');
  const at = instant(now),
    local = at.toZonedDateTimeISO(policy.time_zone),
    time = local.toPlainTime().toString().slice(0, 5),
    quiet = policy.quiet_hours
      ? policy.quiet_hours.start < policy.quiet_hours.end
        ? time >= policy.quiet_hours.start && time < policy.quiet_hours.end
        : time >= policy.quiet_hours.start || time < policy.quiet_hours.end
      : false,
    due = candidate.due_at ? instant(candidate.due_at) : null,
    urgent =
      policy.urgent_rule === 'confirmed_due_24h' &&
      candidate.rule === 'confirmed_due' &&
      due !== null &&
      Temporal.Instant.compare(due, at) > 0 &&
      Temporal.Instant.compare(due, at.add({ hours: 24 })) <= 0;
  return {
    allowed: used < policy.notifications_per_day && (!quiet || urgent),
    route: urgent && quiet ? 'interruption' : 'digest',
    local_date: local.toPlainDate().toString(),
  };
}
