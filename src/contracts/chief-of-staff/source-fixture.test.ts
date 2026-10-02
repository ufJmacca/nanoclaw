import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { sourceFixtureEnvironment } from './source-fixture.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-source-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  return { COS_FIXTURE_WORK_ROOT: root, COS_FIXTURE_WORK_HOST_ROOT: '/var/lib/docker/volumes/fixture/_data' };
}
it('keeps historical fixture paths when no native workspace is supplied', () => {
  expect(sourceFixtureEnvironment('/mac/project', {})).toEqual({ COS_FIXTURE_HOST_ROOT: '/mac/project' });
});
it('separates daemon-native runtime paths from the read-only source checkout', () => {
  const env = fixture();
  expect(
    sourceFixtureEnvironment('/mac/project', {
      ...env,
      COS_PGPASSWORD: 'never-forward',
      OPENAI_API_KEY: 'never-forward',
    }),
  ).toEqual({
    COS_FIXTURE_HOST_ROOT: env.COS_FIXTURE_WORK_HOST_ROOT,
    COS_FIXTURE_SOURCE_ROOT: '/mac/project',
    COS_FIXTURE_WORK_ROOT: env.COS_FIXTURE_WORK_ROOT,
  });
});
it('refuses partial, ambiguous and unowned workspace mappings', () => {
  const env = fixture();
  for (const values of [
    { COS_FIXTURE_WORK_ROOT: env.COS_FIXTURE_WORK_ROOT },
    { COS_FIXTURE_WORK_HOST_ROOT: env.COS_FIXTURE_WORK_HOST_ROOT },
    { ...env, COS_FIXTURE_WORK_HOST_ROOT: '/a/../b' },
    { ...env, COS_FIXTURE_WORK_HOST_ROOT: '/' },
  ])
    expect(() => sourceFixtureEnvironment('/mac/project', values)).toThrow();
  fs.chmodSync(env.COS_FIXTURE_WORK_ROOT, 0o777);
  expect(() => sourceFixtureEnvironment('/mac/project', env)).toThrow();
});
it('refuses symlink workspace aliases', () => {
  const env = fixture(),
    alias = path.join(env.COS_FIXTURE_WORK_ROOT, 'alias');
  fs.symlinkSync(env.COS_FIXTURE_WORK_ROOT, alias);
  expect(() => sourceFixtureEnvironment('/mac/project', { ...env, COS_FIXTURE_WORK_ROOT: alias })).toThrow();
});
it('binds the prepared source snapshot to the original request without accepting a different tree', async () => {
  const { validatePreparedFixtureSource } = await import('./source-fixture.js');
  const request = { sourceCommit: '1'.repeat(40), sourceTree: '2'.repeat(40) },
    info = { commit: request.sourceCommit, tree: request.sourceTree, workerAssetsDigest: '3'.repeat(64) };
  expect(() => validatePreparedFixtureSource(info, request)).not.toThrow();
  for (const changed of [
    { ...info, commit: '4'.repeat(40) },
    { ...info, tree: '5'.repeat(40) },
    { ...info, workerAssetsDigest: 'invalid' },
    null,
  ])
    expect(() => validatePreparedFixtureSource(changed, request)).toThrow();
});
