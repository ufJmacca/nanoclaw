import { expect, it } from 'vitest';
import { planMandateNotification } from './mandate-notification-policy.js';

const policy = {
  schedule: {
    state: 'active' as const,
    time_zone: 'Australia/Sydney',
    local_time: '08:00',
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    quiet_hours: { start: '22:00', end: '07:00' },
    snooze_until: null,
  },
  notifications_per_day: 1,
  escalation_rule: null as 'event_due_30m' | null,
};
const input = {
  scopeId: 'scope',
  mandateId: 'mandate',
  revision: 1,
  createdAt: '2026-10-04T20:30:00Z', // Monday 07:30 after the DST change.
  now: '2026-10-04T20:45:00Z',
  eventStart: '2026-10-04T21:00:00Z',
  used: 0,
};
it('S08-T09 sends only at the approved digest time unless the exact escalation rule is approved', () => {
  expect(planMandateNotification(policy, input).mode).toBe(null);
  expect(planMandateNotification(policy, { ...input, now: '2026-10-04T21:00:00Z' }).mode).toBe('digest');
  expect(planMandateNotification({ ...policy, escalation_rule: 'event_due_30m' }, input).mode).toBe('escalation');
});
it('S08-T09 a result ready after today’s digest waits for the next occurrence', () => {
  const plan = planMandateNotification(policy, {
    ...input,
    createdAt: '2026-10-04T21:01:00Z',
    now: '2026-10-04T22:00:00Z',
  });
  expect(plan.mode).toBe(null);
  expect(plan.nextWakeAt).toBe('2026-10-05T21:00:00.000Z');
});
it('S08-T09 quiet hours and daily limits also constrain approved escalation', () => {
  const escalation = { ...policy, escalation_rule: 'event_due_30m' as const };
  expect(
    planMandateNotification(escalation, {
      ...input,
      createdAt: '2026-10-04T19:00:00Z',
      now: '2026-10-04T19:30:00Z',
      eventStart: '2026-10-04T19:50:00Z',
    }).mode,
  ).toBe(null);
  expect(planMandateNotification(escalation, { ...input, used: 1 }).mode).toBe(null);
  expect(planMandateNotification(escalation, { ...input, createdAt: '2026-10-04T20:45:00.001Z' }).mode).toBe(null);
  expect(planMandateNotification({ ...escalation, notifications_per_day: 0 }, input).mode).toBe(null);
  expect(planMandateNotification(escalation, { ...input, eventStart: '2026-10-04T20:44:00Z' }).mode).toBe(null);
});
