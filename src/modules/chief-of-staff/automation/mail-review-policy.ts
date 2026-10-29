import {
  planBriefOccurrence,
  type BriefSchedulePolicy,
  type ScheduleIdentity,
  type SchedulePlan,
} from './schedule-policy.js';

export const MAIL_REVIEW_LIMITS = Object.freeze({
  candidateThreads: 10,
  modelAttempts: 3,
  draftsPerLocalDay: 5,
});
export type MailReviewSlot = 'morning' | 'afternoon';
export type MailReviewIdentities = Record<MailReviewSlot, ScheduleIdentity>;

/** Timing data only. Current owner, source, run and draft authority are checked separately. */
export function mailReviewSchedulePolicy(
  slot: MailReviewSlot,
  state: 'active' | 'paused' = 'active',
): BriefSchedulePolicy {
  if (!['morning', 'afternoon'].includes(slot) || !['active', 'paused'].includes(state))
    throw Error('invalid_mail_review_policy');
  return {
    state,
    time_zone: 'Australia/Sydney',
    local_time: slot === 'morning' ? '08:00' : '15:00',
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    quiet_hours: null,
    snooze_until: null,
  };
}

/** Preserve native occurrence keys, missed-run coalescing and one actual date per schedule. */
export function planMailReviewOccurrences(
  identities: MailReviewIdentities,
  now: string,
  state: 'active' | 'paused' = 'active',
): Record<MailReviewSlot, SchedulePlan> {
  if (
    !identities ||
    Object.keys(identities).sort().join(',') !== 'afternoon,morning' ||
    !identities.morning ||
    !identities.afternoon ||
    identities.morning.scopeId !== identities.afternoon.scopeId ||
    identities.morning.scheduleId === identities.afternoon.scheduleId
  )
    throw Error('invalid_mail_review_policy');
  return {
    morning: planBriefOccurrence(mailReviewSchedulePolicy('morning', state), identities.morning, now),
    afternoon: planBriefOccurrence(mailReviewSchedulePolicy('afternoon', state), identities.afternoon, now),
  };
}
