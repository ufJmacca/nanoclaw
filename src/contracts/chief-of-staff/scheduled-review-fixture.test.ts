import { expect, it } from 'vitest';
import { scheduledReviewFixtureWake } from './scheduled-review-fixture.js';
import {
  planBriefOccurrence,
  type BriefSchedulePolicy,
} from '../../modules/chief-of-staff/automation/schedule-policy.js';

it.each(['2026-10-16T12:21:59.950Z', '2026-10-16T23:59:59.950Z'])(
  'keeps the actual review after activation when a short setup crosses a minute at %s',
  (sample) => {
    const sampled = Date.parse(sample),
      activated = sampled + 250,
      wake = scheduledReviewFixtureWake(sampled);
    const policy: BriefSchedulePolicy = {
      state: 'active',
      time_zone: 'UTC',
      local_time: new Date(wake).toISOString().slice(11, 16),
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      quiet_hours: null,
      snooze_until: null,
    };
    const identity = {
      scopeId: 'scope',
      scheduleId: 'review',
      revision: 1,
      activatedAt: new Date(activated).toISOString(),
      lastLocalDate: null,
    };
    expect(planBriefOccurrence(policy, identity, new Date(activated + 100).toISOString()).due).toBeNull();
    const atWake = new Date(Math.max(wake + 100, activated + 100)).toISOString();
    expect(planBriefOccurrence(policy, identity, atWake).due).toMatchObject({
      intendedAt: new Date(wake).toISOString(),
    });
  },
);
it('leaves activation headroom while bounding the real database-clock wait to under seventy seconds', () => {
  const minute = Date.parse('2026-10-16T12:21:00.000Z');
  for (const offset of [0, 49999, 50000, 59950, 59999]) {
    const sampled = minute + offset,
      wake = scheduledReviewFixtureWake(sampled);
    expect(wake - sampled).toBeGreaterThanOrEqual(10000);
    expect(wake - sampled).toBeLessThan(70000);
    expect(new Date(wake).getUTCSeconds()).toBe(0);
    expect(new Date(wake).getUTCMilliseconds()).toBe(0);
  }
});
