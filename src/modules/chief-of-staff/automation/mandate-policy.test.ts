import { expect, it } from 'vitest';
import { mandateDueAt } from './mandate-policy.js';

it('S08-T07 recorded commitment dates use their approved timezone across daylight saving rather than UTC midnight', () => {
  expect(mandateDueAt({ kind: 'date', date: '2026-10-04', time_zone: 'Australia/Sydney' })).toBe(
    Date.parse('2026-10-03T14:00:00Z'),
  );
  expect(mandateDueAt({ kind: 'date', date: '2026-10-05', time_zone: 'Australia/Sydney' })).toBe(
    Date.parse('2026-10-04T13:00:00Z'),
  );
  expect(mandateDueAt({ kind: 'date', date: '2026-10-05', time_zone: 'Pacific/Honolulu' })).toBe(
    Date.parse('2026-10-05T10:00:00Z'),
  );
  expect(mandateDueAt({ kind: 'instant', at: '2026-10-05T12:30:00Z', time_zone: 'Pacific/Honolulu' })).toBe(
    Date.parse('2026-10-05T12:30:00Z'),
  );
});
