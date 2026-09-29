import { describe, it, expect } from 'vitest';
import { parseFixtureArguments } from './arguments.js';
describe('CoS fixture command selection', () => {
  it('accepts only explicit S01 profile selection', () =>
    expect(parseFixtureArguments(['--slice', 'S01', '--db-profile', 'test'])).toEqual({
      demo: false,
      profile: 'test',
    }));
  it('requires fixture acknowledgement for demo', () =>
    expect(
      parseFixtureArguments(['--demo', '--slice', 'S01', '--fixture', '--db-profile', 'runtime-disposable']),
    ).toEqual({ demo: true, profile: 'runtime-disposable' }));
  it.each(
    [
      [],
      ['--slice', 'S02', '--db-profile', 'test'],
      ['--slice', 'S01', '--db-profile', 'runtime'],
      ['--demo', '--slice', 'S01', '--db-profile', 'test'],
      ['--slice', 'S01', '--db-profile', 'test', '--db-profile', 'test'],
    ].map((args) => ({ args })),
  )('rejects unsupported, duplicate or incomplete arguments', ({ args }) =>
    expect(() => parseFixtureArguments(args)).toThrow(),
  );
});
