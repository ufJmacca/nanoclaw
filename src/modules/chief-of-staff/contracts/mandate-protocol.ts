import { missionRequestSchema, validMissionLimits, type MissionLimits } from './mission-protocol.js';
import { scheduleChangeSchema, validBriefSchedulePolicy, type BriefSchedulePolicy } from './schedule-protocol.js';

/** A typed proposal is never authority to execute. Only the host records an owner-approved revision. */
export type MandateTrigger =
  | { kind: 'event_approaching'; look_ahead_minutes: number; max_matches: number }
  | { kind: 'project_changed'; project_id: string; look_ahead_minutes: number; max_matches: number }
  | { kind: 'commitment_due'; commitment_ids: string[]; look_ahead_minutes: number; max_matches: number }
  | { kind: 'scheduled_review'; look_ahead_minutes: number; max_matches: number };
export type MandateBudget = {
  max_missions: number;
  max_attempts: number;
  max_turns: number;
  max_tool_calls: number;
  max_concurrent_workers: number;
  wall_seconds: number;
};
export type MandateDefinition = {
  title: string;
  purpose: string;
  goal_id: string | null;
  project_id: string | null;
  source_ids: string[];
  calendar: { binding_id: string; calendar_ids: string[]; event_ids: string[] };
  template: 'meeting_preparation_v1';
  operation: 'prepare_private_briefing';
  trigger: MandateTrigger;
  schedule: BriefSchedulePolicy;
  output: 'originating_owner';
  notifications_per_day: number;
  escalation_rule: 'event_due_30m' | null;
  limits: MissionLimits;
  budget: MandateBudget;
  starts_at: string;
  review_at: string;
  expires_at: string;
  failure_policy: { max_failures: number; unknown_usage: 'suspend'; missed_occurrences: 'coalesce_latest' };
};
export type MandateChange = {
  kind: 'standing_mandate';
  mandate_id: string | null;
  expected_version: number;
  action: 'activate' | 'replace' | 'renew' | 'pause' | 'resume' | 'revoke';
  reason: string;
  definition: MandateDefinition;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
const integer = (v: unknown, min: number, max: number) =>
  Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' &&
  v.trim().length > 0 &&
  v.length <= max &&
  Buffer.from(v).toString('utf8') === v &&
  [...v].every((c) => {
    const n = c.codePointAt(0)!;
    return (n >= 32 || n === 10 || n === 9) && (n < 127 || n > 159);
  });
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const list = (v: unknown, max: number, valid: (value: unknown) => boolean): v is string[] =>
  Array.isArray(v) && v.length >= 1 && v.length <= max && new Set(v).size === v.length && v.every(valid);
const opaque = (v: unknown) => text(v, 1024) && !/[\s\u007f-\u009f]/u.test(v) && !['.', '..'].includes(v);
const instant = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().replace('.000Z', 'Z') === v;
const budgetRanges = {
  max_missions: [1, 20],
  max_attempts: [1, 60],
  max_turns: [1, 240],
  max_tool_calls: [1, 1280],
  max_concurrent_workers: [1, 1],
  wall_seconds: [30, 36000],
} as const;
export function validMandateTrigger(v: unknown): v is MandateTrigger {
  if (!object(v) || !integer(v.look_ahead_minutes, 1, 10080) || !integer(v.max_matches, 1, 3)) return false;
  const common = ['kind', 'look_ahead_minutes', 'max_matches'];
  if (v.kind === 'event_approaching' || v.kind === 'scheduled_review') return exact(v, common);
  if (v.kind === 'project_changed') return exact(v, [...common, 'project_id']) && id(v.project_id);
  return v.kind === 'commitment_due' && exact(v, [...common, 'commitment_ids']) && list(v.commitment_ids, 3, id);
}
export function validMandateDefinition(v: unknown): v is MandateDefinition {
  if (
    !object(v) ||
    !exact(v, [
      'title',
      'purpose',
      'goal_id',
      'project_id',
      'source_ids',
      'calendar',
      'template',
      'operation',
      'trigger',
      'schedule',
      'output',
      'notifications_per_day',
      'escalation_rule',
      'limits',
      'budget',
      'starts_at',
      'review_at',
      'expires_at',
      'failure_policy',
    ]) ||
    !text(v.title, 200) ||
    !text(v.purpose, 2000) ||
    (v.goal_id !== null && !id(v.goal_id)) ||
    (v.project_id !== null && !id(v.project_id)) ||
    !list(v.source_ids, 6, id) ||
    !object(v.calendar) ||
    !exact(v.calendar, ['binding_id', 'calendar_ids', 'event_ids']) ||
    !uuid(v.calendar.binding_id) ||
    !list(v.calendar.calendar_ids, 2, opaque) ||
    !list(v.calendar.event_ids, 5, opaque) ||
    v.template !== 'meeting_preparation_v1' ||
    v.operation !== 'prepare_private_briefing' ||
    v.output !== 'originating_owner' ||
    !validMandateTrigger(v.trigger) ||
    (v.trigger.kind === 'project_changed' && v.trigger.project_id !== v.project_id) ||
    !validBriefSchedulePolicy(v.schedule) ||
    v.schedule.state !== 'active' ||
    v.schedule.snooze_until !== null ||
    !integer(v.notifications_per_day, 0, 3) ||
    (v.escalation_rule !== null && v.escalation_rule !== 'event_due_30m') ||
    !validMissionLimits(v.limits) ||
    !object(v.budget) ||
    !exact(v.budget, Object.keys(budgetRanges)) ||
    !Object.entries(budgetRanges).every(([k, [min, max]]) =>
      integer((v.budget as Record<string, unknown>)[k], min, max),
    ) ||
    !instant(v.starts_at) ||
    !instant(v.review_at) ||
    !instant(v.expires_at) ||
    Date.parse(v.starts_at) >= Date.parse(v.review_at) ||
    Date.parse(v.review_at) > Date.parse(v.expires_at) ||
    Date.parse(v.expires_at) - Date.parse(v.starts_at) > 30 * 86400000 ||
    !object(v.failure_policy) ||
    !exact(v.failure_policy, ['max_failures', 'unknown_usage', 'missed_occurrences']) ||
    !integer(v.failure_policy.max_failures, 1, 5) ||
    v.failure_policy.unknown_usage !== 'suspend' ||
    v.failure_policy.missed_occurrences !== 'coalesce_latest'
  )
    return false;
  const limits = v.limits,
    budget = v.budget;
  return ['max_attempts', 'max_turns', 'max_tool_calls', 'max_concurrent_workers', 'wall_seconds'].every(
    (key) => Number(budget[key]) >= limits[key as keyof MissionLimits],
  );
}
export function validMandateChange(v: unknown): v is MandateChange {
  return (
    object(v) &&
    exact(v, ['kind', 'mandate_id', 'expected_version', 'action', 'reason', 'definition']) &&
    v.kind === 'standing_mandate' &&
    text(v.reason, 2000) &&
    validMandateDefinition(v.definition) &&
    (v.mandate_id === null
      ? v.action === 'activate' && v.expected_version === 0
      : typeof v.mandate_id === 'string' &&
        /^mandate-[a-f0-9]{64}$/.test(v.mandate_id) &&
        integer(v.expected_version, 1, 2147483646) &&
        ['replace', 'renew', 'pause', 'resume', 'revoke'].includes(String(v.action)))
  );
}
const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const str = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const ident = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' };
const nullableId = { anyOf: [{ type: 'null' }, ident] };
const enumeration = (values: string[]) => ({ type: 'string', enum: values });
const int = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum });
const arr = (maxItems: number, items: unknown) => ({ type: 'array', minItems: 1, maxItems, uniqueItems: true, items });
const moment = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$' };
const triggerCommon = { look_ahead_minutes: int(1, 10080), max_matches: int(1, 3) };
export const mandateChangeSchema = obj({
  kind: enumeration(['standing_mandate']),
  mandate_id: { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^mandate-[a-f0-9]{64}$' }] },
  expected_version: int(0, 2147483646),
  action: enumeration(['activate', 'replace', 'renew', 'pause', 'resume', 'revoke']),
  reason: str(2000),
  definition: obj({
    title: str(200),
    purpose: str(2000),
    goal_id: nullableId,
    project_id: nullableId,
    source_ids: arr(6, ident),
    calendar: obj({
      binding_id: { type: 'string', format: 'uuid' },
      calendar_ids: arr(2, str(1024)),
      event_ids: arr(5, str(1024)),
    }),
    template: enumeration(['meeting_preparation_v1']),
    operation: enumeration(['prepare_private_briefing']),
    trigger: {
      anyOf: [
        obj({ kind: enumeration(['event_approaching']), ...triggerCommon }),
        obj({ kind: enumeration(['project_changed']), ...triggerCommon, project_id: ident }),
        obj({ kind: enumeration(['commitment_due']), ...triggerCommon, commitment_ids: arr(3, ident) }),
        obj({ kind: enumeration(['scheduled_review']), ...triggerCommon }),
      ],
    },
    schedule: scheduleChangeSchema.properties.policy,
    output: enumeration(['originating_owner']),
    notifications_per_day: int(0, 3),
    escalation_rule: { anyOf: [{ type: 'null' }, enumeration(['event_due_30m'])] },
    limits: missionRequestSchema.properties.limits,
    budget: obj(Object.fromEntries(Object.entries(budgetRanges).map(([key, [min, max]]) => [key, int(min, max)]))),
    starts_at: moment,
    review_at: moment,
    expires_at: moment,
    failure_policy: obj({
      max_failures: int(1, 5),
      unknown_usage: enumeration(['suspend']),
      missed_occurrences: enumeration(['coalesce_latest']),
    }),
  }),
});
