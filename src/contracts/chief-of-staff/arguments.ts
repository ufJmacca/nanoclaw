export function parseFixtureArguments(args: string[]): { demo: boolean; profile: 'test' | 'runtime-disposable' } {
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
    values.get('--slice') !== 'S01' ||
    !['test', 'runtime-disposable'].includes(String(profile)) ||
    (demo && values.get('--fixture') !== true) ||
    (!demo && values.has('--fixture'))
  )
    throw new Error('explicit_supported_slice_and_profile_required');
  return { demo, profile: profile as 'test' | 'runtime-disposable' };
}
