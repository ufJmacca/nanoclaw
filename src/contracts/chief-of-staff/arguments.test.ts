import { describe, it, expect } from 'vitest';
import { parseFixtureArguments, fixtureFiles } from './arguments.js';
describe('CoS fixture command selection', () => {
  it('registers S06 admission and its three native demonstrations with predecessor regressions', () => {
    const args = parseFixtureArguments(['--demo', '--fixture', '--slice', 'S06', '--db-profile', 'test']);
    expect(fixtureFiles(args)).toEqual(['team-flow.integration']);
    expect(fixtureFiles({ ...args, demo: false })).toEqual([
      ...fixtureFiles({ slice: 'S05', demo: false }),
      'team-admission.integration',
      'team-flow.integration',
    ]);
  });
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
      ['--slice', 'S12', '--db-profile', 'test'],
      ['--slice', 'S01', '--db-profile', 'runtime'],
      ['--demo', '--slice', 'S01', '--db-profile', 'test'],
      ['--slice', 'S01', '--db-profile', 'test', '--db-profile', 'test'],
    ].map((args) => ({ args })),
  )('rejects unsupported, duplicate or incomplete arguments', ({ args }) =>
    expect(() => parseFixtureArguments(args)).toThrow(),
  );
});
it('S11 replays every predecessor with owner operations and demonstrates delegated/scheduled fixture work without live transports', () => {
  const args = parseFixtureArguments(['--demo', '--fixture', '--slice', 'S11', '--db-profile', 'test']);
  expect(fixtureFiles(args)).toEqual(['mission-flow.integration', 'brief-flow.integration', 'operations.integration']);
  expect(fixtureFiles({ ...args, demo: false })).toEqual([
    ...fixtureFiles({ slice: 'S10', demo: false }),
    'operations.integration',
  ]);
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

it('registers the S05 owner approval, native specialist and main-context review demonstration', () => {
  const args = parseFixtureArguments(['--demo', '--fixture', '--slice', 'S05', '--db-profile', 'test']);
  expect(fixtureFiles(args)).toEqual(['mission-flow.integration']);
  expect(fixtureFiles({ ...args, demo: false })).toEqual([
    ...fixtureFiles({ slice: 'S04', demo: false }),
    'mission-schema.integration',
    'mission-approval.integration',
    'mission-sources.integration',
    'mission-run.integration',
    'mission-flow.integration',
  ]);
});

it('registers S07 proactive database and native synthetic-week contracts with all predecessors', () => {
  const args = parseFixtureArguments(['--demo', '--fixture', '--slice', 'S07', '--db-profile', 'test']);
  expect(fixtureFiles(args)).toEqual(['proactive-flow.integration']);
  expect(fixtureFiles({ ...args, demo: false })).toEqual([
    ...fixtureFiles({ slice: 'S06', demo: false }),
    'proactive.integration',
    'proactive-flow.integration',
  ]);
});

it('registers S08 mandate admission, partition and native preparation contracts with all predecessors', () => {
  const args = parseFixtureArguments(['--demo', '--fixture', '--slice', 'S08', '--db-profile', 'test']);
  expect(fixtureFiles(args)).toEqual(['mandate-flow.integration']);
  expect(fixtureFiles({ ...args, demo: false })).toEqual([
    ...fixtureFiles({ slice: 'S07', demo: false }),
    'mandate.integration',
    'mandate-flow.integration',
  ]);
});
it('registers the complete S09 action, resource and native approval/recovery contracts with all predecessors', () => {
  const args = parseFixtureArguments(['--demo', '--fixture', '--slice', 'S09', '--db-profile', 'test']);
  expect(fixtureFiles(args)).toEqual(['actions-flow.integration']);
  expect(fixtureFiles({ ...args, demo: false })).toEqual([
    ...fixtureFiles({ slice: 'S08', demo: false }),
    'action-schema.integration',
    'actions.integration',
    'actions-sources.integration',
    'actions-flow.integration',
  ]);
});

it('registers S10 strategic review and owner-decision flows with every predecessor regression', () => {
  const args = parseFixtureArguments(['--demo', '--fixture', '--slice', 'S10', '--db-profile', 'test']);
  expect(args).toEqual({ slice: 'S10', demo: true, profile: 'test' });
  expect(fixtureFiles(args)).toEqual(['strategy-flow.integration']);
  expect(fixtureFiles({ ...args, demo: false })).toEqual([
    ...fixtureFiles({ slice: 'S09', demo: false }),
    'strategy.integration',
    'strategy-approval.integration',
    'strategy-collection.integration',
    'strategy-source-evolution.integration',
    'strategy-calendar.integration',
    'strategy-missions.integration',
    'strategy-directions.integration',
    'strategy-flow.integration',
  ]);
});
