import { describe, it, expect } from 'vitest';
import { parseFixtureArguments, fixtureFiles } from './arguments.js';
describe('CoS fixture command selection', () => {
  it('accepts explicit supported slice and profile selection', () =>
    expect(parseFixtureArguments(['--slice', 'S01', '--db-profile', 'test'])).toEqual({
      slice: 'S01',
      demo: false,
      profile: 'test',
    }));
  it('requires fixture acknowledgement for demo', () =>
    expect(
      parseFixtureArguments(['--demo', '--slice', 'S01', '--fixture', '--db-profile', 'runtime-disposable']),
    ).toEqual({ slice: 'S01', demo: true, profile: 'runtime-disposable' }));
  it.each(
    [
      [],
      ['--slice', 'S05', '--db-profile', 'test'],
      ['--slice', 'S01', '--db-profile', 'runtime'],
      ['--demo', '--slice', 'S01', '--db-profile', 'test'],
      ['--slice', 'S01', '--db-profile', 'test', '--db-profile', 'test'],
    ].map((args) => ({ args })),
  )('rejects unsupported, duplicate or incomplete arguments', ({ args }) =>
    expect(() => parseFixtureArguments(args)).toThrow(),
  );
});
it('registers the authenticated S04 recurring flow and all affected predecessor contracts', () => {
  const args = parseFixtureArguments(['--demo', '--fixture', '--slice', 'S04', '--db-profile', 'test']);
  expect(fixtureFiles(args)).toEqual(['brief-flow.integration']);
  expect(fixtureFiles({ ...args, demo: false })).toEqual([
    ...fixtureFiles({ slice: 'S03', demo: false }),
    'work.integration',
    'schedules.integration',
    'brief.integration',
    'brief-flow.integration',
  ]);
});

it('registers S02 demonstration and all affected contracts without permitting later slices', () => {
  const args = parseFixtureArguments(['--demo', '--fixture', '--slice', 'S02', '--db-profile', 'test']);
  expect(args).toEqual({ slice: 'S02', demo: true, profile: 'test' });
  expect(fixtureFiles(args)).toEqual(['knowledge-flow.integration']);
  expect(fixtureFiles({ ...args, demo: false })).toEqual([
    'priorities.integration',
    'flow.integration',
    'knowledge.integration',
    'knowledge-flow.integration',
  ]);
});
it('registers the offline S03 preparation flow and all affected predecessor/database contracts', () => {
  const args = parseFixtureArguments(['--demo', '--fixture', '--slice', 'S03', '--db-profile', 'test']);
  expect(fixtureFiles(args)).toEqual(['calendar-flow.integration']);
  expect(fixtureFiles({ ...args, demo: false })).toEqual([
    'priorities.integration',
    'flow.integration',
    'knowledge.integration',
    'knowledge-flow.integration',
    'calendar.integration',
    'calendar-evidence.integration',
    'calendar-flow.integration',
  ]);
});
