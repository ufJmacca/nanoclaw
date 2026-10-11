import fs from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyResticReleasePayload } from '../../modules/chief-of-staff/ops/restic-release-payload.js';
import { RESTIC_ARTIFACT } from '../../modules/chief-of-staff/ops/restic-artifact.js';

test('the final ARM64 host carries the exact official backup executable and immutable seal', () => {
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
});
