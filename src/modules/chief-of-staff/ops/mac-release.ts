import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import path from 'node:path';
import { readPrivate, writeAtomic } from './target-state.js';

type LocalExecution = {
  active_slice: string;
  slices: Array<{
    id: string;
    implementation_status?: string;
    review_status?: string;
    merged_sha?: string;
    deployed_source_sha?: string;
    merged_source_delivery_status?: string;
    pi_smoke_status?: string;
    operator_assessment?: { status: string };
  }>;
};

/** Programme history can outgrow a target receipt; retain its bounded private-file checks. */
export function readLocalExecution(root: string, forRelease = false): LocalExecution {
  const ledger = readPrivate<LocalExecution>(path.join(root, 'execution.json'), 1024 * 1024);
  const slice = ledger.slices?.find((item) => item.id === ledger.active_slice);
  if (
    !['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08'].includes(ledger.active_slice) ||
    !slice ||
    (forRelease && !['in_progress', 'alignment_in_progress'].includes(slice.implementation_status ?? ''))
  )
    throw new Error('active_slice_required');
  if (ledger.active_slice !== 'S01') {
    const predecessor = { S02: 'S01', S03: 'S02', S04: 'S03', S05: 'S04', S06: 'S05', S07: 'S06', S08: 'S07' }[
      ledger.active_slice
    ];
    const previous = ledger.slices.find((item) => item.id === predecessor);
    if (
      !previous ||
      previous.implementation_status !== 'merged' ||
      previous.review_status !== 'human_merged' ||
      !/^[a-f0-9]{40}$/.test(previous.merged_sha ?? '') ||
      previous.deployed_source_sha !== previous.merged_sha ||
      previous.merged_source_delivery_status !== 'passed' ||
      previous.pi_smoke_status !== 'passed' ||
      (ledger.active_slice === 'S08' && previous.operator_assessment?.status !== 'passed')
    )
      throw new Error('predecessor_acceptance_required');
  }
  return ledger;
}

/** Preserve unrelated slices and unknown ledger fields; target lifecycle authority stays on the Pi. */
export function checkpointLocalExecution(root: string, patch: Record<string, unknown>): void {
  const ledger = readLocalExecution(root);
  const slice = ledger.slices.find((item) => item.id === ledger.active_slice);
  if (!['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08'].includes(ledger.active_slice) || !slice)
    throw new Error('active_slice_required');
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

export const RUNTIME_ENVIRONMENT_KEYS = TEST_ENVIRONMENT_KEYS.filter((key) => key !== 'COS_TEST_TARGET_ID').map((key) =>
  key.replace('COS_TEST_PG', 'COS_PG'),
);

/** Select the runtime profile explicitly; never fall back to test credentials or forward unrelated secrets. */
export function selectRuntimeEnvironment(input: NodeJS.ProcessEnv, certificate: string): Record<string, string> {
  if (!certificate.startsWith('/') || /[\0\r\n]/.test(certificate)) throw new Error('unsafe_runtime_environment');
  const result: Record<string, string> = {};
  for (const key of RUNTIME_ENVIRONMENT_KEYS) {
    const value = input[key];
    if (!value) throw new Error('runtime_profile_incomplete');
    if (/[\0\r\n]/.test(value)) throw new Error('unsafe_runtime_environment');
    result[key] = value;
  }
  if (result.COS_PGSSLMODE !== 'verify-full') throw new Error('verified_runtime_tls_required');
  result.COS_PGSSLROOTCERT = certificate;
  return result;
}

export function completeLocalRelease(
  manifest: Omit<ReleaseManifest, 'checks'>,
  checks: ReleaseManifest['checks'],
): ReleaseManifest {
  return validateReleaseManifest({ ...manifest, checks });
}
