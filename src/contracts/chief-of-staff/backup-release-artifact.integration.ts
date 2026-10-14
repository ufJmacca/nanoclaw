import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyResticReleasePayload } from '../../modules/chief-of-staff/ops/restic-release-payload.js';
import { RESTIC_ARTIFACT } from '../../modules/chief-of-staff/ops/restic-artifact.js';
import { installResticRuntimeArtifact } from '../../modules/chief-of-staff/ops/restic-runtime-install.js';
import { fixtureVaultRelease } from './release-fixture.js';

test('the final ARM64 host carries the exact official backup executable and immutable seal', async () => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'arm64');
  assert.equal(process.versions.node, '22.23.2');
  assert.equal(fs.realpathSync('/release'), '/release');
  assert.deepEqual(verifyResticReleasePayload('/release/libexec'), RESTIC_ARTIFACT);
  for (const [file, mode] of [
    ['restic', 0o555],
    ['artifact.json', 0o444],
  ] as const) {
    const stat = fs.lstatSync('/release/libexec/' + file);
    assert.equal(stat.uid, 0);
    assert.equal(stat.nlink, 1);
    assert.equal(stat.mode & 0o7777, mode);
  }
  const build = JSON.parse(fs.readFileSync('/release/build-info.json', 'utf8'));
  assert.match(build.commit, /^[a-f0-9]{40}$/);
  assert.match(build.tree, /^[a-f0-9]{40}$/);
  assert.match(build.workerAssetsDigest, /^[a-f0-9]{64}$/);
  // Synthetic target authority; execute the exact baked installer against the
  // baked public utility, without source overrides or owner credentials.
  for (const slice of ['G02', 'G03'] as const) {
    const installationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-runtime-artifact-'));
    try {
      const input = { installationRoot, payload: '/release', manifest: fixtureVaultRelease(slice), check() {} };
      const installed = await installResticRuntimeArtifact(input),
        file = installationRoot + '/libexec/restic';
      assert.deepEqual(installed, {
        status: 'installed',
        bytes: RESTIC_ARTIFACT.bytes,
        sha256: RESTIC_ARTIFACT.sha256,
      });
      const inode = fs.lstatSync(file).ino;
      assert.equal(fs.lstatSync(file).mode & 0o7777, 0o555);
      assert.deepEqual(await installResticRuntimeArtifact(input), { ...installed, status: 'already_installed' });
      assert.equal(fs.lstatSync(file).ino, inode);
      fs.chmodSync(file, 0o600);
      fs.writeFileSync(file, 'synthetic-interrupted-artifact');
      await assert.rejects(installResticRuntimeArtifact(input), /^Error: backup_runtime_artifact_unavailable$/);
      assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic-interrupted-artifact');
    } finally {
      fs.rmSync(installationRoot, { recursive: true, force: true });
    }
  }
});
