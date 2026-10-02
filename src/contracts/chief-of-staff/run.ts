import { spawnSync } from 'node:child_process';
import { safeHostEnvironment } from '../../host-environment.js';
import { parseFixtureArguments, fixtureFiles } from './arguments.js';
import { assertRuntimeFixtureGuard, selectedFixtureEnvironment } from './fixture-database.js';

try {
  const args = parseFixtureArguments(process.argv.slice(2)),
    { profile } = args;
  const env = { ...process.env, COS_FIXTURE_DATABASE_PROFILE: profile };
  if (profile === 'runtime-disposable') await assertRuntimeFixtureGuard(env);
  const selected = selectedFixtureEnvironment(env, true);
  const fixtures = Object.fromEntries(
    ['COS_FIXTURE_HOST_ROOT', 'COS_FIXTURE_IMAGE', 'COS_FIXTURE_RUNNER_VOLUME'].map((key) => [key, process.env[key]]),
  );
  if (!fixtures.COS_FIXTURE_HOST_ROOT || !fixtures.COS_FIXTURE_IMAGE)
    throw new Error('explicit_container_fixture_configuration_required');
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const files = fixtureFiles(args);
  const result = spawnSync(
    process.execPath,
    [
      ...(extension === 'ts' ? ['--import', 'tsx'] : []),
      '--test',
      '--test-concurrency=1',
      ...files.map(
        (file) => (extension === 'ts' ? 'src' : 'dist') + '/contracts/chief-of-staff/' + file + '.' + extension,
      ),
    ],
    {
      env: { ...safeHostEnvironment('docker'), ...selected, ...fixtures },
      stdio: 'inherit',
      // S05 includes all predecessor scenarios plus real worker cancellation, outage and restart.
      timeout: args.slice === 'S05' ? 300000 : 120000,
    },
  );
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'blocked',
      code: error instanceof Error ? error.message : 'fixture_configuration_invalid',
    }),
  );
  process.exitCode = 1;
}
