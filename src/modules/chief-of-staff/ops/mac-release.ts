import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import path from 'node:path';
import { readPrivate, writeAtomic } from './target-state.js';

/** Preserve unrelated slices and unknown ledger fields; target lifecycle authority stays on the Pi. */
export function checkpointLocalExecution(root: string, patch: Record<string, unknown>): void {
  const ledger = readPrivate<{ active_slice: string; slices: Array<{ id: string }> }>(
    path.join(root, 'execution.json'),
  );
  const slice = ledger.slices.find((item) => item.id === 'S01');
  if (ledger.active_slice !== 'S01' || !slice) throw new Error('active_slice_required');
  Object.assign(slice, patch, { checkpoint_at: new Date().toISOString() });
  writeAtomic(root, 'execution.json', ledger);
}

export const TEST_ENVIRONMENT_KEYS = [
  'COS_TEST_PGHOST',
  'COS_TEST_PGPORT',
  'COS_TEST_PGDATABASE',
  'COS_TEST_PGUSER',
  'COS_TEST_PGPASSWORD',
  'COS_TEST_PGSSLMODE',
  'COS_TEST_PGSSLROOTCERT',
  'COS_TEST_PG_MIGRATION_USER',
  'COS_TEST_PG_MIGRATION_PASSWORD',
  'COS_TEST_TARGET_ID',
] as const;

/** Docker --env-file has literal values; reject line injection rather than shell-escaping credentials. */
export function selectTestEnvironment(input: NodeJS.ProcessEnv, certificate: string): Record<string, string> {
  if (!certificate.startsWith('/') || /[\0\r\n]/.test(certificate)) throw new Error('unsafe_test_environment');
  const result: Record<string, string> = {};
  for (const key of TEST_ENVIRONMENT_KEYS) {
    const value = input[key];
    if (!value) throw new Error('test_profile_incomplete');
    if (/[\0\r\n]/.test(value)) throw new Error('unsafe_test_environment');
    result[key] = value;
  }
  if (result.COS_TEST_PGSSLMODE !== 'verify-full') throw new Error('verified_test_tls_required');
  result.COS_TEST_PGSSLROOTCERT = certificate;
  return result;
}

export function completeLocalRelease(
  manifest: Omit<ReleaseManifest, 'checks'>,
  checks: ReleaseManifest['checks'],
): ReleaseManifest {
  return validateReleaseManifest({ ...manifest, checks });
}
