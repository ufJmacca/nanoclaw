import { REQUIRED_RELEASE_CHECKS, type ReleaseManifest } from '../../modules/chief-of-staff/ops/release-manifest.js';
import { INITIAL_CHECKSUM } from '../../modules/chief-of-staff/store/migrations.js';
import { KNOWLEDGE_CHECKSUM } from '../../modules/chief-of-staff/store/knowledge-schema.js';
/** Synthetic identities for release-contract tests; never a transferable artifact receipt. */
export function fixtureRelease(slice: 'S01' | 'S02' = 'S01'): ReleaseManifest {
  const commit = 'a'.repeat(40),
    imageIds = ['sha256:' + 'c'.repeat(64), 'sha256:' + 'd'.repeat(64)];
  return {
    contract: 'cos-release/v1',
    releaseId: 'release-fixture',
    slice,
    platform: 'linux/arm64',
    source: {
      repository: 'ufJmacca/nanoclaw',
      commit,
      tree: 'b'.repeat(40),
      fetchRef:
        slice === 'S01' ? 'refs/heads/cos/s01-first-use-and-priorities' : 'refs/heads/cos/s02-grounded-knowledge',
      syncContract: 'cos-source-sync/github-pinned-v1',
    },
    buildInputDigest: 'e'.repeat(64),
    hostPayloadDigest: 'f'.repeat(64),
    workerAssetsDigest: '1'.repeat(64),
    rpc: 'cos-rpc/v1',
    postgres: { minimum: slice === 'S01' ? 1 : 2, maximum: slice === 'S01' ? 1 : 2 },
    sqlite: { minimum: 22, maximum: 22 },
    migrations: [
      { version: 1, checksum: INITIAL_CHECKSUM },
      ...(slice === 'S02' ? [{ version: 2, checksum: KNOWLEDGE_CHECKSUM }] : []),
    ],
    previousReleaseIds: [],
    images: [
      {
        role: 'host',
        profile: 'host',
        tag: 'nanoclaw-cos-host:fixture',
        id: imageIds[0],
        configurationId: 'sha256:' + '2'.repeat(64),
      },
      {
        role: 'agent',
        profile: 'codex',
        tag: 'nanoclaw-cos-agent:fixture',
        id: imageIds[1],
        configurationId: 'sha256:' + '3'.repeat(64),
      },
    ],
    checks: Object.fromEntries(
      REQUIRED_RELEASE_CHECKS.map((check) => [
        check,
        {
          status: 'passed',
          at: '2026-09-29T12:00:00Z',
          sourceCommit: commit,
          imageIds: check.includes('image') ? imageIds : [],
        },
      ]),
    ),
  };
}
