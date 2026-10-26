import { describe, expect, it } from 'vitest';
import {
  MAIL_REVIEW_LIMITS,
  mailReviewSchedulePolicy,
  planMailReviewOccurrences,
  type MailReviewIdentities,
} from './mail-review-policy.js';

const identities = (activatedAt = '2026-09-01T00:00:00Z'): MailReviewIdentities => ({
  morning: { scopeId: 'scope', scheduleId: 'mail-morning', revision: 1, activatedAt, lastLocalDate: null },
  afternoon: { scopeId: 'scope', scheduleId: 'mail-afternoon', revision: 1, activatedAt, lastLocalDate: null },
});

describe('G06 fixed Sydney mail-review schedules', () => {
  it('defines separate daily schedules and the agreed shared limits', () => {
    expect(mailReviewSchedulePolicy('morning')).toEqual({
      state: 'active',
      time_zone: 'Australia/Sydney',
      local_time: '08:00',
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      quiet_hours: null,
      snooze_until: null,
    });
    expect(mailReviewSchedulePolicy('afternoon').local_time).toBe('15:00');
    expect(MAIL_REVIEW_LIMITS).toEqual({ candidateThreads: 10, modelAttempts: 3, draftsPerLocalDay: 5 });
  });

  it.each([
    ['summer', '2026-10-26T04:00:00Z', '2026-10-25T21:00:00.000Z', '2026-10-26T04:00:00.000Z'],
    ['winter', '2027-06-01T05:00:00Z', '2027-05-31T22:00:00.000Z', '2027-06-01T05:00:00.000Z'],
    ['DST starts on Sunday', '2026-10-04T04:00:00Z', '2026-10-03T21:00:00.000Z', '2026-10-04T04:00:00.000Z'],
    ['DST ends on Sunday', '2027-04-04T05:00:00Z', '2027-04-03T22:00:00.000Z', '2027-04-04T05:00:00.000Z'],
  ])('keeps 08:00 and 15:00 local time when %s', (_label, now, morning, afternoon) => {
    const plan = planMailReviewOccurrences(identities(), now);
    expect(plan.morning.due?.intendedAt).toBe(morning);
    expect(plan.afternoon.due?.intendedAt).toBe(afternoon);
    expect(plan.morning.due?.key).not.toBe(plan.afternoon.due?.key);
  });

  it('allows both daily reviews while preserving one actual-date occurrence for each schedule', () => {
    const ids = identities('2026-10-25T20:00:00Z'); // 07:00 Sydney
    const morning = planMailReviewOccurrences(ids, '2026-10-25T21:00:00Z');
    expect(morning.morning.due?.localDate).toBe('2026-10-26');
    expect(morning.afternoon.due).toBeNull();
    ids.morning.lastLocalDate = '2026-10-26';
    const afternoon = planMailReviewOccurrences(ids, '2026-10-26T04:00:00Z');
    expect(afternoon.morning.due).toBeNull();
    expect(afternoon.afternoon.due?.localDate).toBe('2026-10-26');
    ids.afternoon.lastLocalDate = '2026-10-26';
    const repeated = planMailReviewOccurrences(ids, '2026-10-26T06:00:00Z');
    expect(repeated.morning.due).toBeNull();
    expect(repeated.afternoon.due).toBeNull();
  });

  it('uses the existing bounded missed-occurrence policy rather than enumerating a backlog', () => {
    const ids = identities();
    const first = planMailReviewOccurrences(ids, '2026-10-26T05:00:00Z');
    const repeated = planMailReviewOccurrences(ids, '2026-10-26T05:01:00Z');
    expect(Object.values(first).filter((p) => p.due)).toHaveLength(2);
    for (const slot of ['morning', 'afternoon'] as const) {
      expect(first[slot].due?.intendedLocalDate).toBe('2026-10-26');
      expect(repeated[slot].due?.key).toBe(first[slot].due?.key);
    }
  });

  it('closes both schedules while the mail-review policy is paused', () => {
    const plan = planMailReviewOccurrences(identities(), '2026-10-26T05:00:00Z', 'paused');
    expect(plan.morning).toEqual({ due: null, nextWakeAt: null });
    expect(plan.afternoon).toEqual({ due: null, nextWakeAt: null });
  });

  it('refuses a third slot, shared schedule identity or cross-scope pair', () => {
    const same = identities();
    same.afternoon.scheduleId = same.morning.scheduleId;
    expect(() => planMailReviewOccurrences(same, '2026-10-26T05:00:00Z')).toThrow();
    const other = identities();
    other.afternoon.scopeId = 'other';
    expect(() => planMailReviewOccurrences(other, '2026-10-26T05:00:00Z')).toThrow();
    expect(() =>
      planMailReviewOccurrences(
        { ...identities(), third: identities().morning } as MailReviewIdentities,
        '2026-10-26T05:00:00Z',
      ),
    ).toThrow();
  });

  it('returns independent policy data so a caller cannot rewrite future schedules', () => {
    const first = mailReviewSchedulePolicy('morning');
    first.local_time = '12:00';
    first.weekdays.length = 0;
    expect(mailReviewSchedulePolicy('morning').local_time).toBe('08:00');
    expect(mailReviewSchedulePolicy('morning').weekdays).toHaveLength(7);
  });
});
