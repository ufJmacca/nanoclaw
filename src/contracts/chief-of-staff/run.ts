import { spawnSync } from 'node:child_process';
import { safeHostEnvironment } from '../../host-environment.js';
import { parseFixtureArguments } from './arguments.js';
import { assertRuntimeFixtureGuard, selectedFixtureEnvironment } from './fixture-database.js';

try {
  const { demo, profile } = parseFixtureArguments(process.argv.slice(2));
  const env = { ...process.env, COS_FIXTURE_DATABASE_PROFILE: profile };
  if (profile === 'runtime-disposable') await assertRuntimeFixtureGuard(env);
  const selected = selectedFixtureEnvironment(env, true);
  const fixtures = Object.fromEntries(
    ['COS_FIXTURE_HOST_ROOT', 'COS_FIXTURE_IMAGE', 'COS_FIXTURE_RUNNER_VOLUME'].map((key) => [key, process.env[key]]),
  );
  if (!fixtures.COS_FIXTURE_HOST_ROOT || !fixtures.COS_FIXTURE_IMAGE)
    throw new Error('explicit_container_fixture_configuration_required');
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const files = demo ? ['flow.integration'] : ['priorities.integration', 'flow.integration'];
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
      timeout: 120000,
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
