export type HealthStage = 'native_compatibility' | 'process' | 'schema' | 'profiles' | 'images' | 'fixture';
export type TargetHealthReceipt = {
  version: 1;
  releaseId: string;
  sourceCommit: string;
  status: 'passed' | 'failed';
  completed: HealthStage[];
  stage?: HealthStage;
  code?: string;
  at: string;
};

const admittedErrors = new Set([
  'specialist_release_required',
  'target_service_unhealthy',
  'target_process_mismatch',
  'target_host_ownership_mismatch',
  'schema_incompatible',
  'installed_profile_unavailable',
  'coordinator_image_unavailable',
  'release_loaded_image_mismatch',
  'authentication_denied',
  'tls_rejected',
  'schema_privilege_denied',
  'unreachable',
  'unsafe_smoke_root',
  'immutable_smoke_image_required',
  'EACCES',
  'ENOENT',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
]);
/** Persist the gate and a fixed classification; errors can contain tokens, paths or model text. */
function failureCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unclassified_failure';
  const value = error as { code?: unknown; name?: unknown; message?: unknown };
  for (const candidate of [value.code, value.message])
    if (typeof candidate === 'string' && admittedErrors.has(candidate)) return candidate;
  return value.name === 'AssertionError' ? 'fixture_assertion_failed' : 'unclassified_failure';
}

/** A durable result accompanies every attempt, including the failure before compatible rollback. */
export async function runTargetHealth(options: {
  releaseId: string;
  sourceCommit: string;
  checks: Array<{ stage: HealthStage; run(): Promise<void> }>;
  write(receipt: TargetHealthReceipt): void;
}): Promise<boolean> {
  const completed: HealthStage[] = [];
  for (const check of options.checks) {
    let failure: { code: string } | undefined;
    try {
      await check.run();
    } catch (error) {
      failure = { code: failureCode(error) };
    }
    if (failure) {
      options.write({
        version: 1,
        releaseId: options.releaseId,
        sourceCommit: options.sourceCommit,
        status: 'failed',
        completed,
        stage: check.stage,
        code: failure.code,
        at: new Date().toISOString(),
      });
      return false;
    }
    completed.push(check.stage);
  }
  options.write({
    version: 1,
    releaseId: options.releaseId,
    sourceCommit: options.sourceCommit,
    status: 'passed',
    completed,
    at: new Date().toISOString(),
  });
  return true;
}
