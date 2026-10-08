type FixtureArguments = {
  slice: 'S01' | 'S02' | 'S03' | 'S04' | 'S05' | 'S06' | 'S07' | 'S08' | 'S09' | 'S10' | 'S11' | 'G01';
  demo: boolean;
  profile: 'test' | 'runtime-disposable';
};
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
    !['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'G01'].includes(
      String(values.get('--slice')),
    ) ||
    !['test', 'runtime-disposable'].includes(String(profile)) ||
    (values.get('--slice') === 'G01' && profile !== 'test') ||
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
  // Vault helper/kernel/unit/wire checks have their own immutable release gates; regress every prior database/native contract here.
  if (args.slice === 'G01') return fixtureFiles({ slice: 'S11', demo: args.demo });
  if (args.slice === 'S11')
    return args.demo
      ? ['mission-flow.integration', 'brief-flow.integration', 'operations.integration']
      : [...fixtureFiles({ slice: 'S10', demo: false }), 'operations.integration'];
  if (args.slice === 'S10')
    return args.demo
      ? ['strategy-flow.integration']
      : [
          ...fixtureFiles({ slice: 'S09', demo: false }),
          'strategy.integration',
          'strategy-approval.integration',
          'strategy-collection.integration',
          'strategy-source-evolution.integration',
          'strategy-calendar.integration',
          'strategy-missions.integration',
          'strategy-directions.integration',
          'strategy-flow.integration',
        ];
  if (args.slice === 'S09')
    return args.demo
      ? ['actions-flow.integration']
      : [
          ...fixtureFiles({ slice: 'S08', demo: false }),
          'action-schema.integration',
          'actions.integration',
          'actions-sources.integration',
          'actions-flow.integration',
        ];
  if (args.slice === 'S08')
    return args.demo
      ? ['mandate-flow.integration']
      : [...fixtureFiles({ slice: 'S07', demo: false }), 'mandate.integration', 'mandate-flow.integration'];
  if (args.slice === 'S07')
    return args.demo
      ? ['proactive-flow.integration']
      : [...fixtureFiles({ slice: 'S06', demo: false }), 'proactive.integration', 'proactive-flow.integration'];
  if (args.slice === 'S06')
    return args.demo
      ? ['team-flow.integration']
      : [...fixtureFiles({ slice: 'S05', demo: false }), 'team-admission.integration', 'team-flow.integration'];
  if (args.slice === 'S05')
    return args.demo
      ? ['mission-flow.integration']
      : [
          ...fixtureFiles({ slice: 'S04', demo: false }),
          'mission-schema.integration',
          'mission-approval.integration',
          'mission-sources.integration',
          'mission-run.integration',
          'mission-flow.integration',
        ];
  if (args.slice === 'S04')
    return args.demo
      ? ['brief-flow.integration']
      : [
          ...fixtureFiles({ slice: 'S03', demo: false }),
          'work.integration',
          'schedules.integration',
          'brief.integration',
          'brief-flow.integration',
        ];
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
