import { expect, it } from 'vitest';
import assert from 'node:assert/strict';
import { assertReleaseTestRuntime, verifyReleaseTestRuntime, type ReleaseTestRuntime } from './release-test-runtime.js';
const ready: ReleaseTestRuntime = {
  platform: 'linux',
  architecture: 'arm64',
  uid: 1000,
  machineIdentityInitialized: true,
  systemdAnalyzeAvailable: true,
  systemdEscapeAvailable: true,
};
it('admits the actual release test platform only with its required Linux utilities and initialized identity', () => {
  expect(() => assertReleaseTestRuntime(ready)).not.toThrow();
  expect(() => verifyReleaseTestRuntime(() => ready)).not.toThrow();
});
it.each([
  ['platform', 'darwin'],
  ['architecture', 'x64'],
  ['uid', 0],
  ['machineIdentityInitialized', false],
  ['systemdAnalyzeAvailable', false],
  ['systemdEscapeAvailable', false],
] as const)('rejects a missing or incompatible development prerequisite: %s', (key, value) => {
  expect(() => assertReleaseTestRuntime({ ...ready, [key]: value })).toThrow(/^development_test_runtime_unavailable$/);
});
it('does not disclose private identity or inspection errors', () => {
  assert.throws(
    () =>
      verifyReleaseTestRuntime(() => {
        throw Error('PRIVATE_INSPECTION');
      }),
    (error: unknown) =>
      error instanceof Error && error.message === 'development_test_runtime_unavailable' && error.cause === undefined,
  );
});
