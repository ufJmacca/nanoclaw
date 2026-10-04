import { Temporal } from '@js-temporal/polyfill';
import type { MandateDefinition } from '../contracts/mandate-protocol.js';
import { nextBriefAllowedAt, planBriefOccurrence } from './schedule-policy.js';

type Policy = Pick<MandateDefinition, 'schedule' | 'notifications_per_day' | 'escalation_rule'>;
type Input = {
  scopeId: string;
  mandateId: string;
  revision: number;
  createdAt: string;
  now: string;
  eventStart: string | null;
  used: number;
};
/** Deterministic delivery eligibility, independent of model prose or the local wall clock. */
export function planMandateNotification(policy: Policy, input: Input) {
  const localDate = Temporal.Instant.from(input.now)
    .toZonedDateTimeISO(policy.schedule.time_zone)
    .toPlainDate()
    .toString();
  const plan = planBriefOccurrence(
    policy.schedule,
    {
      scopeId: input.scopeId,
      scheduleId: input.mandateId,
      revision: input.revision,
      activatedAt: input.createdAt,
      lastLocalDate: null,
    },
    input.now,
  );
  const none = { mode: null, localDate, nextWakeAt: plan.nextWakeAt } as const;
  if (input.used >= policy.notifications_per_day || Date.parse(input.createdAt) > Date.parse(input.now)) return none;
  if (Date.parse(nextBriefAllowedAt(policy.schedule, input.now)) > Date.parse(input.now)) return none;
  const untilEvent = input.eventStart === null ? null : Date.parse(input.eventStart) - Date.parse(input.now);
  if (policy.escalation_rule === 'event_due_30m' && untilEvent !== null && untilEvent > 0 && untilEvent <= 1800000)
    return { mode: 'escalation', localDate, nextWakeAt: plan.nextWakeAt } as const;
  return plan.due ? ({ mode: 'digest', localDate, nextWakeAt: plan.nextWakeAt } as const) : none;
}
