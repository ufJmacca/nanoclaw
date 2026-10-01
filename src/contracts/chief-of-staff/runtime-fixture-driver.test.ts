import { expect, it } from 'vitest';
import { startRuntimeFixtureGuard, validateRuntimeFixtureRequest } from './runtime-fixture-driver.js';
import { assertRuntimeFixtureGuard } from './fixture-database.js';
import type { RuntimeTestReply } from '../../modules/chief-of-staff/ops/runtime-test-client.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
const request = {
  version: 1,
  owner: 'fixture-run',
  execution: 'source',
  mode: 'slice',
  sourceCommit: '1'.repeat(40),
  sourceTree: '2'.repeat(40),
  hostImage: 'sha256:' + '3'.repeat(64),
  workerImage: 'sha256:' + '4'.repeat(64),
  hostRoot: '/fixture/root',
  runnerVolume: 'fixture-runner',
  databaseFingerprint: '5'.repeat(64),
  bindingDigest: '6'.repeat(64),
};
it('binds a runtime fixture run to explicit source, image, target and execution identities', () => {
  expect(validateRuntimeFixtureRequest(request)).toEqual(request);
  expect(validateRuntimeFixtureRequest({ ...request, execution: 'packaged', runnerVolume: '' })).toMatchObject({
    execution: 'packaged',
  });
});

it('binds new runs to their slice without changing historical request identities', () => {
  const historical = digest(request);
  expect(digest(validateRuntimeFixtureRequest(request))).toBe(historical);
  const current = { ...request, slice: 'S02' };
  expect(validateRuntimeFixtureRequest(current)).toEqual(current);
  expect(digest(validateRuntimeFixtureRequest(current))).not.toBe(historical);
  expect(validateRuntimeFixtureRequest({ ...request, slice: 'S01' }).slice).toBe('S01');
  expect(validateRuntimeFixtureRequest({ ...request, slice: 'S03' }).slice).toBe('S03');
  for (const slice of ['S04', '', null, undefined])
    expect(() => validateRuntimeFixtureRequest({ ...request, slice })).toThrow('invalid_runtime_fixture_request');
});

it('requires the private capability and a fresh live control check for every database admission', async () => {
  let calls = 0;
  let alive = true;
  const guard = await startRuntimeFixtureGuard({
    request: async (action) => {
      expect(action).toBe('check');
      calls++;
      if (!alive) throw new Error('control_lost');
      return { status: 'ready', databaseFingerprint: '5'.repeat(64) } as RuntimeTestReply;
    },
  });
  const env = { COS_FIXTURE_GUARD_SOCKET: guard.socket, COS_FIXTURE_GUARD_TOKEN: guard.token };
  try {
    await expect(assertRuntimeFixtureGuard({ ...env, COS_FIXTURE_GUARD_TOKEN: '0'.repeat(64) })).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(assertRuntimeFixtureGuard(env)).resolves.toBe('5'.repeat(64));
    await expect(assertRuntimeFixtureGuard(env)).resolves.toBe('5'.repeat(64));
    expect(calls).toBe(2);
    alive = false;
    await expect(assertRuntimeFixtureGuard(env)).rejects.toThrow();
    expect(calls).toBe(3);
  } finally {
    await guard.close();
  }
});
it('refuses source mounts in packaged tests, mutable images, unsafe roots and extra credential fields', () => {
  for (const patch of [
    { execution: 'packaged' },
    { workerImage: 'fixture:latest' },
    { hostRoot: '/' },
    { hostRoot: '/fixture/../elsewhere' },
    { hostRoot: '/fixture,src=/private' },
    { databaseFingerprint: 'unknown' },
    { OPENAI_API_KEY: 'must-not-enter-request' },
  ])
    expect(() => validateRuntimeFixtureRequest({ ...request, ...patch })).toThrow('invalid_runtime_fixture_request');
});
