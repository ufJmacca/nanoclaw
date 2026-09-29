import { describe, it, expect } from 'vitest';
import { REQUIRED_RELEASE_CHECKS, validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import { INITIAL_CHECKSUM } from '../store/migrations.js';
const sha = 'a'.repeat(40),
  tree = 'b'.repeat(40),
  image = 'sha256:' + 'c'.repeat(64),
  agent = 'sha256:' + 'd'.repeat(64);
function manifest(): ReleaseManifest {
  return {
    contract: 'cos-release/v1',
    releaseId: 'release-fixture',
    slice: 'S01',
    platform: 'linux/arm64',
    source: {
      repository: 'ufJmacca/nanoclaw',
      commit: sha,
      tree,
      fetchRef: 'refs/heads/cos/s01-first-use-and-priorities',
      syncContract: 'cos-source-sync/github-pinned-v1',
    },
    buildInputDigest: 'e'.repeat(64),
    hostPayloadDigest: 'f'.repeat(64),
    workerAssetsDigest: '1'.repeat(64),
    rpc: 'cos-rpc/v1',
    postgres: { minimum: 1, maximum: 1 },
    sqlite: { minimum: 21, maximum: 21 },
    migrations: [{ version: 1, checksum: INITIAL_CHECKSUM }],
    previousReleaseIds: [],
    images: [
      {
        role: 'host',
        profile: 'host',
        tag: 'nanoclaw-cos-host:fixture',
        id: image,
        configurationId: 'sha256:' + '2'.repeat(64),
      },
      {
        role: 'agent',
        profile: 'codex',
        tag: 'nanoclaw-cos-agent:fixture',
        id: agent,
        configurationId: 'sha256:' + '3'.repeat(64),
      },
    ],
    checks: Object.fromEntries(
      REQUIRED_RELEASE_CHECKS.map((check) => [
        check,
        {
          status: 'passed',
          at: '2026-09-29T12:00:00Z',
          sourceCommit: sha,
          imageIds: check.includes('image') ? [image, agent] : [],
        },
      ]),
    ),
  };
}
describe('S01-REL01 source and final-image evidence gate', () => {
  it('records configuration digests separately and requires explicit schema/migration compatibility', () => {
    for (const key of ['configurationId']) {
      const value = manifest();
      delete (value.images[0] as unknown as Record<string, unknown>)[key];
      expect(() => validateReleaseManifest(value)).toThrow();
    }
    for (const patch of [
      { sqlite: { minimum: 1, maximum: 20 } },
      { migrations: [] },
      { previousReleaseIds: ['../foreign'] },
    ])
      expect(() => validateReleaseManifest({ ...manifest(), ...patch })).toThrow();
  });
  it('accepts only complete evidence for one exact source and final image pair', () =>
    expect(validateReleaseManifest(manifest())).toEqual(manifest()));
  it.each(REQUIRED_RELEASE_CHECKS)('refuses a failed or missing mandatory %s check', (check) => {
    const value = manifest();
    value.checks[check].status = 'failed';
    expect(() => validateReleaseManifest(value)).toThrow('release_not_transferable');
    delete value.checks[check];
    expect(() => validateReleaseManifest(value)).toThrow('release_not_transferable');
  });
  it('S01-REL05 rejects evidence for other image identities', () => {
    const value = manifest();
    value.checks.agent_image.imageIds = [image];
    expect(() => validateReleaseManifest(value)).toThrow();
  });
  it('S01-REL13 rejects moving source references and a changed tested commit', () => {
    const value = manifest();
    value.source.commit = 'main';
    expect(() => validateReleaseManifest(value)).toThrow();
    value.source.commit = sha;
    value.checks.slice.sourceCommit = '1'.repeat(40);
    expect(() => validateReleaseManifest(value)).toThrow();
  });
  it('S01-REL08 rejects foreign repositories, traversal and a different platform', () => {
    for (const value of [
      { ...manifest(), releaseId: '../active' },
      { ...manifest(), platform: 'linux/amd64' },
      { ...manifest(), source: { ...manifest().source, repository: 'foreign/repo' } },
    ])
      expect(() => validateReleaseManifest(value)).toThrow();
  });
  it('does not accept mutable application tags or duplicate profile identities', () => {
    const value = manifest();
    value.images[0].tag = 'nanoclaw:latest';
    expect(() => validateReleaseManifest(value)).toThrow();
    value.images[0].tag = 'nanoclaw:fixture';
    value.images.push(value.images[1]);
    expect(() => validateReleaseManifest(value)).toThrow();
  });
});
