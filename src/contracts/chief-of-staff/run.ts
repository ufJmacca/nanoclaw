import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { safeHostEnvironment } from '../../host-environment.js';
import { stopFixtureWorkers } from './fixture-workers.js';
import { parseFixtureArguments, fixtureFiles } from './arguments.js';
import { assertRuntimeFixtureGuard, selectedFixtureEnvironment } from './fixture-database.js';

try {
  const args = parseFixtureArguments(process.argv.slice(2)),
    { profile } = args;
  const env = { ...process.env, COS_FIXTURE_DATABASE_PROFILE: profile };
  if (profile === 'runtime-disposable') await assertRuntimeFixtureGuard(env);
  const selected = selectedFixtureEnvironment(env, true);
  const fixtures = Object.fromEntries(
    ['COS_FIXTURE_HOST_ROOT', 'COS_FIXTURE_IMAGE', 'COS_FIXTURE_RUNNER_VOLUME', 'COS_FIXTURE_SOURCE_ROOT'].map(
      (key) => [key, process.env[key]],
    ),
  );
  if (!fixtures.COS_FIXTURE_HOST_ROOT || !fixtures.COS_FIXTURE_IMAGE)
    throw new Error('explicit_container_fixture_configuration_required');
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const files = fixtureFiles(args),
    directory = path.dirname(fileURLToPath(import.meta.url));
  if (process.env.COS_FIXTURE_WORK_ROOT) {
    const root = process.env.COS_FIXTURE_WORK_ROOT,
      stat = fs.lstatSync(root);
    if (
      extension !== 'ts' ||
      !path.isAbsolute(root) ||
      fs.realpathSync(root) !== root ||
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700
    )
      throw Error('invalid_fixture_workspace');
    process.chdir(root);
  }
  const result = spawnSync(
    process.execPath,
    [
      ...(extension === 'ts' ? ['--import', import.meta.resolve('tsx')] : []),
      '--test',
      '--test-concurrency=1',
      ...files.map((file) => path.join(directory, file + '.' + extension)),
    ],
    {
      env: { ...safeHostEnvironment('docker'), ...selected, ...fixtures },
      stdio: 'inherit',
      // Complete native scenarios and actual database-time expiry use a bounded suite deadline.
      timeout: ['S06', 'S07', 'S08', 'S09'].includes(args.slice) ? 600000 : args.slice === 'S05' ? 300000 : 120000,
    },
  );
  if (['S05', 'S06', 'S07', 'S08', 'S09'].includes(args.slice))
    await stopFixtureWorkers(fixtures.COS_FIXTURE_HOST_ROOT, fixtures.COS_FIXTURE_IMAGE);
  process.exitCode = result.status ?? 1;
  // eslint-disable-next-line no-catch-all/no-catch-all -- The fixture CLI reports its bounded configuration failure and exits without admission.
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'blocked',
      code: error instanceof Error ? error.message : 'fixture_configuration_invalid',
    }),
  );
  process.exitCode = 1;
}
