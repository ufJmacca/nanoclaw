import { restrictedLaunch, type RestrictedLaunchInput } from '../bridge/restricted-launch.js';
import { getInstallSlug } from '../../../install-slug.js';

/** Keep an administration probe outside the starting host's orphan ownership. */
export function nativeSmokeLaunch(input: RestrictedLaunchInput): ReturnType<typeof restrictedLaunch> {
  if (input.entry !== 'mcp' || input.subscription || input.research) throw Error('native_smoke_profile_required');
  const launch = restrictedLaunch(input);
  launch.args = launch.args.map((arg) =>
    arg.startsWith('nanoclaw-install=')
      ? 'nanoclaw-install=cos-native-smoke-' + getInstallSlug(input.sessionDirectory)
      : arg,
  );
  return launch;
}
