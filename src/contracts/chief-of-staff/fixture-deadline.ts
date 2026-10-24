import { parseFixtureArguments } from './arguments.js';

type FixtureSelection = Pick<ReturnType<typeof parseFixtureArguments>, 'slice' | 'demo'>;

export function fixtureSuiteDeadline({ slice, demo }: FixtureSelection): number {
  // The full G05 regression includes all prior slices. A measured 19-minute
  // pass left too little aggregate margin for the final six-minute native case.
  // Keep each case's own deadline and the shorter demonstration budget intact.
  if (slice === 'G05' && !demo) return 1800000;
  return ['G02', 'G03', 'G04', 'G05'].includes(slice)
    ? 1200000
    : ['S10', 'S11', 'G01'].includes(slice) && !demo
      ? 900000
      : ['S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'G01'].includes(slice)
        ? 600000
        : slice === 'S05'
          ? 300000
          : 120000;
}
