import { describe, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import {
  planMailReviewOccurrences,
  type MailReviewIdentities,
} from '../../modules/chief-of-staff/automation/mail-review-policy.js';
import { mailReviewFixtureTiming } from './mail-review-fixture-timing.js';

describe('synthetic mail-review timeline', () => {
  it.each([
    '2026-10-26T19:00:00Z', // Before 08:00 Sydney.
    '2026-10-26T23:40:00Z', // Between the two real review times: the observed failure.
    '2026-10-27T06:00:00Z', // After 15:00 Sydney.
    '2026-10-27T12:59:59Z', // Just before local midnight.
    '2026-10-03T12:00:00Z', // Before daylight saving starts.
    '2027-04-03T12:00:00Z', // Before daylight saving ends.
  ])('starts with morning and then afternoon independently of wall time %s', (now) => {
    const timing = mailReviewFixtureTiming(now);
    const identities: MailReviewIdentities = {
      morning: {
        scopeId: 'fixture',
        scheduleId: 'morning',
        revision: 1,
        activatedAt: timing.activatedAt,
        lastLocalDate: null,
      },
      afternoon: {
        scopeId: 'fixture',
        scheduleId: 'afternoon',
        revision: 1,
        activatedAt: timing.activatedAt,
        lastLocalDate: null,
      },
    };
    const morning = planMailReviewOccurrences(identities, timing.clock('morning'));
    expect(morning.morning.due).not.toBeNull();
    expect(morning.afternoon.due).toBeNull();
    identities.morning.lastLocalDate = morning.morning.due!.localDate;
    const afternoon = planMailReviewOccurrences(identities, timing.clock('afternoon'));
    expect(afternoon.morning.due).toBeNull();
    expect(afternoon.afternoon.due?.localDate).toBe(morning.morning.due!.localDate);
    expect(timing.clock('morning', 2)).not.toBe(timing.clock('morning'));
  });
  it('keeps the same timeline across a real midnight or native fixture restart', () => {
    const now = vi.spyOn(Temporal.Now, 'instant').mockReturnValue(Temporal.Instant.from('2026-10-27T12:59:59Z'));
    try {
      const timing = mailReviewFixtureTiming();
      now.mockReturnValue(Temporal.Instant.from('2026-10-27T13:01:00Z'));
      expect(timing.clock('morning')).toBe('2026-10-27T21:01:00Z');
      expect(timing.activatedAt).toBe('2026-10-27T13:00:00Z');
    } finally {
      now.mockRestore();
    }
  });
});
