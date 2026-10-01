/** Canonical owner-approved schedule contract, copied verbatim into the restricted worker. */
export type BriefSchedulePolicy = {
  state: 'active' | 'paused';
  time_zone: string;
  local_time: string;
  weekdays: number[];
  quiet_hours: { start: string; end: string } | null;
  snooze_until: string | null;
};
export type BriefLimits = {
  max_turns: number;
  max_tool_calls: number;
  deadline_seconds: number;
  refresh_seconds: number;
};
export type ScheduleChange = {
  kind: 'brief_schedule';
  title: string;
  reason: string;
  record_id?: string;
  expected_version: number;
  policy: BriefSchedulePolicy;
  limits: BriefLimits;
};
const clockSchema = { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' };
export const scheduleChangeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'title', 'reason', 'expected_version', 'policy', 'limits'],
  properties: {
    kind: { type: 'string', enum: ['brief_schedule'] },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    reason: { type: 'string', minLength: 1, maxLength: 2000 },
    record_id: {
      type: 'string',
      pattern: '^[a-zA-Z0-9_-]{1,100}$',
      description: 'Exact approved schedule ID for an update; omit for creation.',
    },
    expected_version: {
      type: 'integer',
      minimum: 0,
      description: 'Zero for creation; exact current positive version for updates.',
    },
    policy: {
      type: 'object',
      additionalProperties: false,
      required: ['state', 'time_zone', 'local_time', 'weekdays', 'quiet_hours', 'snooze_until'],
      properties: {
        state: { type: 'string', enum: ['active', 'paused'] },
        time_zone: { type: 'string', maxLength: 100, description: 'IANA timezone.' },
        local_time: clockSchema,
        weekdays: {
          type: 'array',
          minItems: 1,
          maxItems: 7,
          uniqueItems: true,
          items: { type: 'integer', minimum: 1, maximum: 7 },
          description: 'Monday=1 through Sunday=7; at most one actual local-date delivery.',
        },
        quiet_hours: {
          anyOf: [
            { type: 'null' },
            {
              type: 'object',
              additionalProperties: false,
              required: ['start', 'end'],
              properties: { start: clockSchema, end: clockSchema },
            },
          ],
        },
        snooze_until: {
          anyOf: [{ type: 'null' }, { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$' }],
        },
      },
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      required: ['max_turns', 'max_tool_calls', 'deadline_seconds', 'refresh_seconds'],
      properties: {
        max_turns: { type: 'integer', minimum: 1, maximum: 3 },
        max_tool_calls: { type: 'integer', minimum: 1, maximum: 16 },
        deadline_seconds: { type: 'integer', minimum: 30, maximum: 300 },
        refresh_seconds: { type: 'integer', minimum: 0, maximum: 30 },
      },
    },
  },
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every((key) => allowed.includes(key));
const time = (v: unknown): v is string => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const boundedInt = (v: unknown, min: number, max: number) =>
  Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' &&
  v.trim().length > 0 &&
  v.length <= max &&
  Buffer.from(v).toString('utf8') === v &&
  [...v].every((c) => c.codePointAt(0)! >= 32 && (c.codePointAt(0)! < 127 || c.codePointAt(0)! > 159));
export function validBriefSchedulePolicy(v: unknown): v is BriefSchedulePolicy {
  if (
    !object(v) ||
    !keys(v, ['state', 'time_zone', 'local_time', 'weekdays', 'quiet_hours', 'snooze_until']) ||
    !['active', 'paused'].includes(String(v.state)) ||
    !text(v.time_zone, 100) ||
    /^[+-]/.test(v.time_zone) ||
    !time(v.local_time) ||
    !Array.isArray(v.weekdays) ||
    v.weekdays.length < 1 ||
    v.weekdays.length > 7 ||
    new Set(v.weekdays).size !== v.weekdays.length ||
    !v.weekdays.every((day) => boundedInt(day, 1, 7))
  )
    return false;
  if (
    v.quiet_hours !== null &&
    (!object(v.quiet_hours) ||
      !keys(v.quiet_hours, ['start', 'end']) ||
      !time(v.quiet_hours.start) ||
      !time(v.quiet_hours.end) ||
      v.quiet_hours.start === v.quiet_hours.end)
  )
    return false;
  if (
    v.snooze_until !== null &&
    (typeof v.snooze_until !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v.snooze_until) ||
      !Number.isFinite(Date.parse(v.snooze_until)) ||
      new Date(v.snooze_until).toISOString() !== v.snooze_until.replace('Z', '.000Z'))
  )
    return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: v.time_zone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}
export function validScheduleChange(v: unknown): v is ScheduleChange {
  return (
    object(v) &&
    keys(v, ['kind', 'title', 'reason', 'record_id', 'expected_version', 'policy', 'limits']) &&
    v.kind === 'brief_schedule' &&
    text(v.title, 200) &&
    text(v.reason, 2000) &&
    (v.record_id === undefined
      ? v.expected_version === 0
      : typeof v.record_id === 'string' &&
        /^[a-zA-Z0-9_-]{1,100}$/.test(v.record_id) &&
        boundedInt(v.expected_version, 1, 2147483647)) &&
    validBriefSchedulePolicy(v.policy) &&
    object(v.limits) &&
    keys(v.limits, ['max_turns', 'max_tool_calls', 'deadline_seconds', 'refresh_seconds']) &&
    boundedInt(v.limits.max_turns, 1, 3) &&
    boundedInt(v.limits.max_tool_calls, 1, 16) &&
    boundedInt(v.limits.deadline_seconds, 30, 300) &&
    boundedInt(v.limits.refresh_seconds, 0, 30)
  );
}
