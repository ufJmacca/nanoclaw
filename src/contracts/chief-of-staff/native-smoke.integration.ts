import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeFixtureSmoke } from '../../modules/chief-of-staff/ops/native-smoke.js';
import { safeHostEnvironment } from '../../host-environment.js';
import { startFixtureProcess } from './fixture-process.js';

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
  assert.deepEqual(result, {
    status: 'passed',
    rpc: 'passed',
    isolation: 'passed',
    provider: 'passed',
    model: 'fixture',
    messagesSent: 0,
  });
});

test(
  'isolated startup cleanup, native communication, health failure and rollback preserve synthetic state',
  { timeout: 90000 },
  async (context) => {
    const root = process.env.COS_SMOKE_ROOT ?? path.resolve('.cos-plan-state/native-smoke');
    const hostRoot =
      process.env.COS_SMOKE_HOST_ROOT ?? path.join(process.env.COS_FIXTURE_HOST_ROOT!, '.cos-plan-state/native-smoke');
    const image = process.env.COS_FIXTURE_IMAGE;
    assert.ok(image && /^sha256:[a-f0-9]{64}$/.test(image));
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const cwd = fs.mkdtempSync(path.join(root, 'lifecycle-'));
    const caseId = randomUUID(),
      marker = 'nanoclaw.cos-lifecycle-case=' + caseId;
    const source = import.meta.url.endsWith('.ts');
    const worker = fileURLToPath(new URL('./native-lifecycle-fixture.' + (source ? 'ts' : 'js'), import.meta.url));
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk) => {
      text = (text + chunk.toString()).slice(-(1024 ** 2));
    });
    const env = safeHostEnvironment('docker');
    const child = startFixtureProcess(
      [
        ...(source ? ['--import', 'tsx'] : []),
        worker,
        JSON.stringify({ root: cwd, hostRoot: path.join(hostRoot, path.basename(cwd)), image, caseId }),
      ],
      env,
      output,
      { cwd },
    );
    const abort = () => {
      void child.stop().catch(() => {});
    };
    context.signal.addEventListener('abort', abort, { once: true });
    const docker = async (...args: string[]) =>
      (await promisify(execFile)('docker', args, { env, timeout: 10000, maxBuffer: 1024 ** 2 })).stdout.trim();
    try {
      try {
        await child.finished;
      } catch (error) {
        throw new Error('native_lifecycle_child_failed: ' + text, { cause: error });
      }
      const resultLine = text
        .split('\n')
        .find(
          (line) => line.startsWith('{') && line.includes('native_startup_cleanup_health_rollback_lifecycle_rehearsed'),
        );
      assert.ok(resultLine, text);
      const result = JSON.parse(resultLine);
      assert.equal(result.image, image);
      assert.equal(result.legacyCollisionReproduced, true);
      assert.equal(result.terminalReplayRejected, true);
      assert.equal(result.freshCorrectedOperationHealthy, true);
      assert.equal(result.syntheticProtectedStatePreserved, true);
      assert.equal(result.actualAccountCalls, 0);
      assert.equal(result.actualModelCalls, 0);
      console.log(JSON.stringify(result));
    } finally {
      context.signal.removeEventListener('abort', abort);
      await child.stop();
      const containers = (await docker('ps', '--all', '--no-trunc', '--quiet', '--filter', 'label=' + marker))
        .split('\n')
        .filter(Boolean);
      assert.ok(containers.length <= 8 && containers.every((id) => /^[a-f0-9]{64}$/.test(id)));
      for (const id of containers) {
        const inspected = JSON.parse(await docker('inspect', id))[0];
        assert.equal(inspected.Image, image);
        assert.equal(inspected.Config.Labels['nanoclaw.cos-lifecycle-case'], caseId);
        await docker('rm', '--force', id);
      }
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  },
);
