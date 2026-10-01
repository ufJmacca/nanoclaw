import { Temporal } from '@js-temporal/polyfill';
import type { WorkDue } from '../contracts/protocol.js';
import type { AnswerCitation } from '../contracts/answer-protocol.js';
import type { CalendarTime } from '../calendar/normalization.js';
export type BriefWork = {
  id: string;
  version: number;
  kind: 'commitment' | 'decision';
  state: string;
  title: string;
  project_id: string | null;
  due: WorkDue | null;
  defer_until: string | null;
  evidence: AnswerCitation[];
};
export type BriefRecord = {
  id: string;
  version: number;
  kind: string;
  title: string;
  description: string;
  lifecycle: string;
};
export type BriefEvent = {
  time_zone: string;
  summary: string;
  start: CalendarTime;
  end: CalendarTime;
  status: string;
  evidence: { kind: 'source'; evidence_id: string };
  source_version: number;
  revision_id: string;
  binding_id: string;
  calendar_id: string;
  snapshot_id: string;
};
export type BriefCoverage = {
  knowledge: 'available' | 'stale' | 'not_connected' | 'unavailable';
  calendar: 'available' | 'stale' | 'not_connected' | 'incomplete' | 'unavailable';
  refresh: 'not_requested' | 'complete' | 'failed' | 'timed_out';
  truncated: boolean;
  withheld: number;
};
export type BriefCalendarCoverage = {
  binding_id: string;
  calendar_id: string;
  time_zone: string;
  snapshot_id: string | null;
  coverage: string;
  warning: string | null;
  last_success_at: string | null;
  last_attempt_at: string | null;
  window: { timeMin: string; timeMax: string; timeZone: string } | null;
};
export type BriefInputs = {
  generatedAt: string;
  timeZone: string;
  records: BriefRecord[];
  work: BriefWork[];
  calendars: BriefEvent[];
  calendarCoverage?: BriefCalendarCoverage[];
  coverage: BriefCoverage;
};

export type BriefReference = AnswerCitation | { kind: 'work'; work_id: string; version: number };
export type BriefAttention = {
  id: string;
  title: string;
  reason: 'overdue' | 'due_within_window' | 'decision_needed' | 'upcoming_event' | 'approved_goal' | 'active_project';
  reference: BriefReference;
};
export type BriefSnapshot = {
  format: 'cos-brief/v1';
  generated_at: string;
  time_zone: string;
  window: { time_min: string; time_max: string };
  coverage: BriefCoverage;
  attention: BriefAttention[];
  commitments: BriefWork[];
  decisions: BriefWork[];
  events: BriefEvent[];
  calendar_coverage: BriefCalendarCoverage[];
  suggested_work: [];
};
const dueInstant = (due: WorkDue) =>
  due.kind === 'instant'
    ? Temporal.Instant.from(due.at)
    : Temporal.PlainDate.from(due.date).add({ days: 1 }).toZonedDateTime(due.time_zone).toInstant();
const eventInstant = (time: CalendarTime, zone: string) =>
  time.kind === 'instant'
    ? Temporal.Instant.from(time.instant)
    : Temporal.PlainDate.from(time.date).toZonedDateTime(zone).toInstant();
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id, 'en');
const sortWork = (a: BriefWork, b: BriefWork) =>
  a.due && b.due
    ? Temporal.Instant.compare(dueInstant(a.due), dueInstant(b.due)) || byId(a, b)
    : a.due
      ? -1
      : b.due
        ? 1
        : byId(a, b);
/** Pure host selection from already authorized, bounded inputs. Source text never grants authority. */
export function buildBriefSnapshot(input: BriefInputs): BriefSnapshot {
  if (input.records.length > 100 || input.work.length > 100 || input.calendars.length > 25)
    throw Error('brief_input_limit');
  const now = Temporal.Instant.from(input.generatedAt),
    end = now.toZonedDateTimeISO(input.timeZone).add({ days: 1 }).toInstant();
  const records = input.records
    .filter((r) => r.lifecycle === 'active')
    .sort((a, b) => a.kind.localeCompare(b.kind, 'en') || byId(a, b));
  const work = input.work
    .filter(
      (w) =>
        (w.state === 'confirmed' ||
          w.state === 'needed' ||
          (w.state === 'deferred' && w.defer_until && Temporal.Instant.compare(w.defer_until, now) <= 0)) &&
        (!w.project_id || records.some((r) => r.kind === 'project' && r.id === w.project_id)),
    )
    .sort(sortWork);
  const commitments = work.filter((w) => w.kind === 'commitment'),
    decisions = work.filter((w) => w.kind === 'decision');
  const events = input.calendars
    .filter(
      (e) =>
        e.status !== 'cancelled' &&
        Temporal.Instant.compare(eventInstant(e.end, e.time_zone), now) > 0 &&
        Temporal.Instant.compare(eventInstant(e.start, e.time_zone), end) < 0,
    )
    .sort(
      (a, b) =>
        Temporal.Instant.compare(eventInstant(a.start, a.time_zone), eventInstant(b.start, b.time_zone)) ||
        a.evidence.evidence_id.localeCompare(b.evidence.evidence_id, 'en'),
    );
  const due = commitments.filter((w) => w.due && Temporal.Instant.compare(dueInstant(w.due), end) <= 0);
  const candidates: BriefAttention[] = [
    ...due.map((w) => ({
      id: w.id,
      title: w.title,
      reason:
        Temporal.Instant.compare(dueInstant(w.due!), now) <= 0 ? ('overdue' as const) : ('due_within_window' as const),
      reference: { kind: 'work' as const, work_id: w.id, version: w.version },
    })),
    ...decisions.map((w) => ({
      id: w.id,
      title: w.title,
      reason: 'decision_needed' as const,
      reference: { kind: 'work' as const, work_id: w.id, version: w.version },
    })),
    ...events.map((e) => ({
      id: e.evidence.evidence_id,
      title: e.summary,
      reason: 'upcoming_event' as const,
      reference: e.evidence,
    })),
    ...records
      .filter((r) => ['goal', 'project'].includes(r.kind))
      .map((r) => ({
        id: r.id,
        title: r.title,
        reason: r.kind === 'goal' ? ('approved_goal' as const) : ('active_project' as const),
        reference: { kind: 'record' as const, record_id: r.id, version: r.version },
      })),
  ];
  // Copy all output so subsequent collector mutations cannot rewrite the historical snapshot.
  return structuredClone({
    format: 'cos-brief/v1',
    generated_at: now.toString(),
    time_zone: input.timeZone,
    window: { time_min: now.toString(), time_max: end.toString() },
    coverage: {
      ...input.coverage,
      truncated: input.coverage.truncated || commitments.length > 5 || decisions.length > 5 || events.length > 5,
    },
    attention: candidates.slice(0, 3),
    commitments: commitments.slice(0, 5),
    decisions: decisions.slice(0, 5),
    events: events.slice(0, 5),
    calendar_coverage: (input.calendarCoverage ?? []).slice(0, 5),
    suggested_work: [],
  });
}
const label = (text: string) =>
  [...text]
    .slice(0, 300)
    .join('')
    .replace(/[@]/g, '＠')
    .replace(/[\r\n]/g, ' ')
    .replace(/[\\`*_{}[\]<>]/g, (c) => '\\' + c);
const reference = (ref: BriefReference) =>
  ref.kind === 'source'
    ? `source evidence ${label(ref.evidence_id)}`
    : ref.kind === 'work'
      ? `work ${label(ref.work_id)} v${ref.version}`
      : `record ${label(ref.record_id)} v${ref.version}`;
const reason = {
  overdue: 'Overdue commitment',
  due_within_window: 'Commitment due within this window',
  decision_needed: 'Decision needed',
  upcoming_event: 'Upcoming event',
  approved_goal: 'Approved goal',
  active_project: 'Active project',
};
const dueLabel = (due: WorkDue | null) =>
  due
    ? due.kind === 'date'
      ? `${due.date} (${due.time_zone}, date only)`
      : `${due.at} (${due.time_zone})`
    : 'No deadline recorded';
export function renderBrief(snapshot: BriefSnapshot): string {
  const coverage = snapshot.coverage;
  return [
    `CoS brief — generated ${snapshot.generated_at} (${label(snapshot.time_zone)})`,
    `Window: ${snapshot.window.time_min} to ${snapshot.window.time_max} (end exclusive).`,
    `Knowledge: ${coverage.knowledge.replaceAll('_', ' ')}. Calendar: ${coverage.calendar.replaceAll('_', ' ')}. Refresh: ${coverage.refresh.replaceAll('_', ' ')}.`,
    ...snapshot.calendar_coverage.map(
      (c) =>
        `Calendar ${label(c.calendar_id)} (${label(c.time_zone)}): ${label(c.coverage)}${c.warning ? ' — ' + label(c.warning) : ''}. Last successful refresh: ${c.last_success_at ?? 'never'}. Last attempt: ${c.last_attempt_at ?? 'never'}.`,
    ),
    'Calendar information is a stored snapshot. An empty or incomplete result does not establish that nothing is scheduled.',
    ...(coverage.truncated ? ['Some eligible items are not shown; request the next page or an exact record.'] : []),
    ...(coverage.withheld
      ? [`${coverage.withheld} items withheld because their current evidence could not be verified.`]
      : []),
    'Attention (advice):',
    ...(snapshot.attention.length
      ? snapshot.attention.map((x) => `- ${reason[x.reason]}: ${label(x.title)} [${reference(x.reference)}]`)
      : ['No evidence-backed attention items in this view.']),
    'Confirmed commitments:',
    ...(snapshot.commitments.length
      ? snapshot.commitments.map((w) => `- ${label(w.title)} — ${dueLabel(w.due)} [work ${label(w.id)} v${w.version}]`)
      : ['No confirmed commitments in this view.']),
    'Decisions needed:',
    ...(snapshot.decisions.length
      ? snapshot.decisions.map((w) => `- ${label(w.title)} [work ${label(w.id)} v${w.version}]`)
      : ['No open decisions in this view.']),
    'Upcoming calendar events:',
    ...(snapshot.events.length
      ? snapshot.events.map(
          (e) =>
            `- ${label(e.summary)} — ${e.start.kind === 'date' ? e.start.date + ' (all day)' : e.start.instant} [${reference(e.evidence)}]`,
        )
      : ['No visible events in the recorded window.']),
    'Suggested delegated work: none. Any follow-up still requires an owner-approved proposal.',
  ].join('\n');
}
