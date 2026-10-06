import { expect, it } from 'vitest';
import { scheduledMinutes } from './calendar-allocation.js';
it('S10 allocation clips event time to the approved horizon', () => {
  expect(
    scheduledMinutes(
      { kind: 'instant', instant: '2026-10-06T08:00:00Z', timeZone: 'UTC' },
      { kind: 'instant', instant: '2026-10-06T11:00:00Z', timeZone: 'UTC' },
      'UTC',
      '2026-10-06T09:00:00Z',
      '2026-10-06T10:00:00Z',
    ),
  ).toBe(60);
});
it('S10 all-day allocation respects daylight-saving elapsed time without implying actual effort', () => {
  expect(
    scheduledMinutes(
      { kind: 'date', date: '2026-10-04' },
      { kind: 'date', date: '2026-10-05' },
      'Australia/Sydney',
      '2026-10-03T00:00:00Z',
      '2026-10-06T00:00:00Z',
    ),
  ).toBe(23 * 60);
});
it('S10 events outside the approved horizon contribute no allocation', () => {
  expect(
    scheduledMinutes(
      { kind: 'date', date: '2026-10-01' },
      { kind: 'date', date: '2026-10-02' },
      'UTC',
      '2026-10-03T00:00:00Z',
      '2026-10-06T00:00:00Z',
    ),
  ).toBe(0);
});
