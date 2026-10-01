type FixtureArguments = { slice: 'S01' | 'S02' | 'S03'; demo: boolean; profile: 'test' | 'runtime-disposable' };
export function parseFixtureArguments(args: string[]): FixtureArguments {
  const values = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--demo', '--fixture', '--slice', '--db-profile'].includes(flag) || values.has(flag))
      throw new Error('explicit_supported_slice_and_profile_required');
    if (flag === '--demo' || flag === '--fixture') values.set(flag, true);
    else values.set(flag, args[++i]);
  }
  const demo = values.get('--demo') === true,
    profile = values.get('--db-profile');
  if (
    !['S01', 'S02', 'S03'].includes(String(values.get('--slice'))) ||
    !['test', 'runtime-disposable'].includes(String(profile)) ||
    (demo && values.get('--fixture') !== true) ||
    (!demo && values.has('--fixture'))
  )
    throw new Error('explicit_supported_slice_and_profile_required');
  return {
    slice: values.get('--slice') as FixtureArguments['slice'],
    demo,
    profile: profile as 'test' | 'runtime-disposable',
  };
}

export function fixtureFiles(args: Pick<FixtureArguments, 'slice' | 'demo'>): string[] {
  if (args.slice === 'S03')
    return args.demo
      ? ['calendar-flow.integration']
      : [
          ...fixtureFiles({ slice: 'S02', demo: false }),
          'calendar.integration',
          'calendar-evidence.integration',
          'calendar-flow.integration',
        ];
  if (args.slice === 'S02')
    return args.demo
      ? ['knowledge-flow.integration']
      : ['priorities.integration', 'flow.integration', 'knowledge.integration', 'knowledge-flow.integration'];
  return args.demo ? ['flow.integration'] : ['priorities.integration', 'flow.integration'];
}
