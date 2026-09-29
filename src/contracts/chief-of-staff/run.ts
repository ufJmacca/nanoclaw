import { spawnSync } from 'node:child_process';
import { safeHostEnvironment } from '../../host-environment.js';

const args = process.argv.slice(2);
if (
  args.length !== 4 ||
  args[0] !== '--slice' ||
  args[1] !== 'S01' ||
  args[2] !== '--db-profile' ||
  args[3] !== 'test'
) {
  console.error(
    JSON.stringify({ status: 'blocked', code: 'explicit_supported_slice_and_admitted_test_profile_required' }),
  );
  process.exitCode = 1;
} else {
  // Only trusted integration processes receive this one selected profile.
  const profile = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('COS_TEST_PG') || key === 'COS_TEST_TARGET_ID'),
  );
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', 'src/contracts/chief-of-staff/priorities.integration.ts'],
    {
      env: { ...safeHostEnvironment('docker'), ...profile },
      stdio: 'inherit',
      timeout: 120000,
    },
  );
  process.exitCode = result.status ?? 1;
}
