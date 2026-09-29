import { spawnSync } from 'node:child_process';
import { safeHostEnvironment } from '../../host-environment.js';
import { parseFixtureArguments } from './arguments.js';

try {
  const { demo, profile } = parseFixtureArguments(process.argv.slice(2));
  if (profile !== 'test') throw new Error('runtime_disposable_target_guard_not_implemented');
  const selected = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('COS_TEST_PG') || key === 'COS_TEST_TARGET_ID'),
  );
  const fixtures = Object.fromEntries(
    ['COS_FIXTURE_HOST_ROOT', 'COS_FIXTURE_IMAGE', 'COS_FIXTURE_RUNNER_VOLUME'].map((key) => [key, process.env[key]]),
  );
  if (!fixtures.COS_FIXTURE_HOST_ROOT || !fixtures.COS_FIXTURE_IMAGE)
    throw new Error('explicit_container_fixture_configuration_required');
  const files = demo ? ['flow.integration.ts'] : ['priorities.integration.ts', 'flow.integration.ts'];
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      '--test-concurrency=1',
      ...files.map((file) => 'src/contracts/chief-of-staff/' + file),
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
