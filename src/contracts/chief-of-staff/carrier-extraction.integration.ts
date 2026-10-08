/** Actual stopped carrier, Docker archive stream and non-root GNU tar; no live stores or credentials. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractCarrierPayload } from '../../modules/chief-of-staff/ops/carrier-extraction.js';
import { payloadDigest } from '../../modules/chief-of-staff/ops/payload.js';

test('the immutable host carrier extracts every sealed file with the exact digest as the non-root owner', async () => {
  assert.equal(process.platform, 'linux');
  assert.notEqual(process.getuid?.(), 0);
  const image = process.env.COS_CARRIER_IMAGE;
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const expected = process.env.COS_CARRIER_PAYLOAD_DIGEST;
  assert.match(expected ?? '', /^[a-f0-9]{64}$/);
  const owner = randomUUID();
  const docker = async (args: string[]) =>
    (
      await promisify(execFile)('/usr/bin/docker', ['--host=unix:///var/run/docker.sock', ...args], {
        env: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
        timeout: 600000,
        maxBuffer: 1048576,
      })
    ).stdout.trim();
  const id = await docker([
    'create',
    '--pull=never',
    '--network=none',
    '--label',
    'nanoclaw.carrier-fixture=' + owner,
    '--entrypoint',
    '/bin/true',
    image!,
  ]);
  assert.match(id, /^[a-f0-9]{64}$/);
  try {
    const [carrier] = JSON.parse(await docker(['container', 'inspect', id]));
    assert.equal(carrier.Id, id);
    assert.equal(carrier.Image, image);
    assert.equal(carrier.State.Status, 'created');
    assert.equal(carrier.State.Running, false);
    assert.deepEqual(carrier.Mounts, []);
    assert.equal(carrier.Config.Labels['nanoclaw.carrier-fixture'], owner);
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-carrier-artifact-'));
    fs.chmodSync(destination, 0o700);
    await extractCarrierPayload(id, destination);
    assert.equal(await payloadDigest(destination), expected);
    assert.equal(fs.statSync(destination).mode & 0o777, 0o700);
    const artifacts = path.join(destination, 'vault-artifacts');
    if (fs.existsSync(artifacts)) {
      const names = fs.readdirSync(artifacts);
      assert.equal(names.length, 1);
      const sealed = path.join(artifacts, names[0]);
      assert.equal(fs.statSync(sealed).mode & 0o777, 0o555);
      for (const [name, mode] of [
        ['artifact.json', 0o444],
        ['gateway.mjs', 0o444],
        ['node', 0o555],
      ] as const)
        assert.equal(fs.statSync(path.join(sealed, name)).mode & 0o777, mode);
    }
    // An interrupted unpromoted tree can contain readonly directories and stale files.
    fs.writeFileSync(path.join(destination, 'failed-copy-residue'), 'synthetic');
    await extractCarrierPayload(id, destination);
    assert.equal(await payloadDigest(destination), expected);
    assert.equal(fs.existsSync(path.join(destination, 'failed-copy-residue')), false);
    const [after] = JSON.parse(await docker(['container', 'inspect', id]));
    assert.equal(after.State.Status, 'created');
    assert.equal(after.State.Running, false);
  } finally {
    // The fresh, verified fixture ID is the only container this check removes.
    await docker(['rm', id]);
  }
});
