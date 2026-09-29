import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { nativeFixtureSmoke } from '../../modules/chief-of-staff/ops/native-smoke.js';

test('baked restricted worker proves native RPC and isolation without live accounts', { timeout: 45000 }, async () => {
  const root = process.env.COS_SMOKE_ROOT ?? path.resolve('.cos-plan-state/native-smoke');
  assert.ok(process.env.COS_FIXTURE_IMAGE);
  assert.ok(process.env.COS_FIXTURE_HOST_ROOT);
  const result = await nativeFixtureSmoke({
    root,
    hostRoot:
      process.env.COS_SMOKE_HOST_ROOT ?? path.join(process.env.COS_FIXTURE_HOST_ROOT, '.cos-plan-state/native-smoke'),
    image: process.env.COS_FIXTURE_IMAGE,
  });
  assert.deepEqual(result, { status: 'passed', rpc: 'passed', isolation: 'passed', model: 'fixture', messagesSent: 0 });
});
