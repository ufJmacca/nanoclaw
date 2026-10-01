import { Temporal } from '@js-temporal/polyfill';
import { nextRecurrenceAt } from '../../scheduling/next-occurrence.js';
import { digest } from '../contracts/protocol.js';
import { validBriefSchedulePolicy, type BriefSchedulePolicy } from '../contracts/schedule-protocol.js';
export { validBriefSchedulePolicy, type BriefSchedulePolicy } from '../contracts/schedule-protocol.js';
export type ScheduleIdentity = {
  scopeId: string;
  scheduleId: string;
  revision: number;
  activatedAt: string;
  lastLocalDate: string | null;
};
export type BriefOccurrence = { key: string; intendedAt: string; localDate: string; intendedLocalDate: string };
export type SchedulePlan = { due: BriefOccurrence | null; nextWakeAt: string | null };
const instant = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length > 40) return false;
  try {
    Temporal.Instant.from(v);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
};
/** Daily/weekday expressions only: no worker-supplied cron, script or destination. */
export function briefRecurrence(policy: BriefSchedulePolicy): string {
  if (!validBriefSchedulePolicy(policy)) throw new Error('invalid_brief_schedule');
  const [hour, minute] = policy.local_time.split(':').map(Number);
  return `${minute} ${hour} * * ${[...policy.weekdays]
    .sort((a, b) => a - b)
    .map((day) => day % 7)
    .join(',')}`;
}
const iso = (at: Temporal.Instant) => at.toString({ smallestUnit: 'millisecond' });
function outsideQuiet(policy: BriefSchedulePolicy, at: Temporal.Instant): Temporal.Instant {
  if (!policy.quiet_hours) return at;
  const local = at.toZonedDateTimeISO(policy.time_zone),
    time = local.toPlainTime().toString({ smallestUnit: 'minute' });
  const { start, end } = policy.quiet_hours,
    overnight = start > end;
  if (!(overnight ? time >= start || time < end : time >= start && time < end)) return at;
  const date = overnight && time >= start ? local.toPlainDate().add({ days: 1 }) : local.toPlainDate();
  // Temporal's compatible policy shifts missing times forward and chooses the earlier repeated instant.
  const endTime = date.toPlainDateTime(end);
  const earlier = endTime.toZonedDateTime(policy.time_zone, { disambiguation: 'compatible' }).toInstant();
  return Temporal.Instant.compare(earlier, at) > 0
    ? earlier
    : endTime.toZonedDateTime(policy.time_zone, { disambiguation: 'later' }).toInstant();
}
export function planBriefOccurrence(
  policy: BriefSchedulePolicy,
  identity: ScheduleIdentity,
  now: string,
): SchedulePlan {
  if (
    !validBriefSchedulePolicy(policy) ||
    !instant(now) ||
    !instant(identity.activatedAt) ||
    !Number.isSafeInteger(identity.revision) ||
    identity.revision < 1 ||
    !identity.scopeId ||
    !identity.scheduleId
  )
    throw new Error('invalid_brief_schedule');
  if (identity.lastLocalDate !== null) {
    let valid = false;
    try {
      valid = Temporal.PlainDate.from(identity.lastLocalDate).toString() === identity.lastLocalDate;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
    if (!valid) throw new Error('invalid_brief_schedule');
  }
  if (policy.state === 'paused') return { due: null, nextWakeAt: null };
  const at = Temporal.Instant.from(now),
    activated = Temporal.Instant.from(identity.activatedAt),
    today = at.toZonedDateTimeISO(policy.time_zone).toPlainDate();
  const cron = briefRecurrence(policy);
  const next = (after: Temporal.Instant) =>
    Temporal.Instant.from(nextRecurrenceAt(cron, policy.time_zone, new Date(after.epochMilliseconds)));
  const dayStart = (date: Temporal.PlainDate) => date.toZonedDateTime(policy.time_zone).toInstant();
  const maximum = (a: Temporal.Instant, b: Temporal.Instant) => (Temporal.Instant.compare(a, b) >= 0 ? a : b);
  const snooze = policy.snooze_until ? Temporal.Instant.from(policy.snooze_until) : at;
  const allowedAt = outsideQuiet(policy, maximum(at, snooze));
  const already = identity.lastLocalDate !== null && identity.lastLocalDate >= today.toString();
  let futureFrom = maximum(at, activated.subtract({ milliseconds: 1 }));
  if (already)
    futureFrom = maximum(
      futureFrom,
      dayStart(Temporal.PlainDate.from(identity.lastLocalDate!).add({ days: 1 })).subtract({ milliseconds: 1 }),
    );
  let nextWake = outsideQuiet(policy, maximum(next(futureFrom), snooze));
  let due: BriefOccurrence | null = null;
  if (!already) {
    // At least one weekday is selected. Seven days of downtime collapse to the latest occurrence; older backlog is never enumerated.
    for (let back = 0; back <= 7; back++) {
      const date = today.subtract({ days: back });
      if (!policy.weekdays.includes(date.dayOfWeek)) continue;
      const intended = next(dayStart(date).subtract({ milliseconds: 1 }));
      if (
        intended.toZonedDateTimeISO(policy.time_zone).toPlainDate().toString() !== date.toString() ||
        Temporal.Instant.compare(intended, at) > 0 ||
        Temporal.Instant.compare(intended, activated) < 0
      )
        continue;
      if (Temporal.Instant.compare(allowedAt, at) > 0) nextWake = allowedAt;
      else
        due = {
          key: digest({
            scope: identity.scopeId,
            schedule: identity.scheduleId,
            revision: identity.revision,
            intended_at: iso(intended),
          }),
          intendedAt: iso(intended),
          localDate: today.toString(),
          intendedLocalDate: date.toString(),
        };
      break;
    }
  }
  return { due, nextWakeAt: iso(nextWake) };
}
