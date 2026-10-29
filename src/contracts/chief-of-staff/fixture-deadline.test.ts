import { expect, it } from 'vitest';
import { fixtureSuiteDeadline } from './fixture-deadline.js';

it('allows the accumulated G05 suite to finish a late native case within its existing case deadline', () => {
  // A captured timeout reached the final native-team file after 1,156,697 ms
  // with no failed assertions. That file already has a six-minute deadline;
  // the remaining storage file retains the original two-minute suite budget.
  const lastNativeFileStartedAt = 1156697,
    nativeCaseDeadline = 360000,
    trailingStorageBudget = 120000,
    deadline = fixtureSuiteDeadline({ slice: 'G05', demo: false });
  expect(deadline).toBeGreaterThan(lastNativeFileStartedAt + nativeCaseDeadline + trailingStorageBudget);
  expect(deadline).toBeLessThanOrEqual(1800000);
});

it.each([
  ['G06', false, 1800000],
  ['G06', true, 1200000],
  ['G05', true, 1200000],
  ['G04', false, 1200000],
  ['G03', false, 1200000],
  ['G02', false, 1200000],
  ['G01', false, 900000],
  ['S11', false, 900000],
  ['S10', false, 900000],
  ['S11', true, 600000],
  ['S10', true, 600000],
  ['G01', true, 600000],
  ['S09', false, 600000],
  ['S08', false, 600000],
  ['S07', false, 600000],
  ['S06', true, 600000],
  ['S05', false, 300000],
  ['S04', false, 120000],
  ['S01', false, 120000],
] as const)('preserves the bounded deadline for %s demo=%s', (slice, demo, deadline) => {
  expect(fixtureSuiteDeadline({ slice, demo })).toBe(deadline);
});
