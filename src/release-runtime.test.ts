import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { imageProfile, assertReleaseMounts, readReleaseAt, selectReleaseImage } from './release-runtime.js';
import { REQUIRED_RELEASE_CHECKS, type ReleaseManifest } from './modules/chief-of-staff/ops/release-manifest.js';
const commit = 'a'.repeat(40),
  tree = 'b'.repeat(40),
  host = 'sha256:' + 'c'.repeat(64),
  agent = 'sha256:' + 'd'.repeat(64);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-release-runtime-'));
  roots.push(root);
  const manifest: ReleaseManifest = {
    contract: 'cos-release/v1',
    releaseId: 'release-fixture',
    slice: 'S01',
    platform: 'linux/arm64',
    source: {
      repository: 'ufJmacca/nanoclaw',
      commit,
      tree,
      fetchRef: 'refs/heads/fixture',
      syncContract: 'cos-source-sync/github-pinned-v1',
    },
    buildInputDigest: 'e'.repeat(64),
    hostPayloadDigest: 'f'.repeat(64),
    rpc: 'cos-rpc/v1',
    postgres: { minimum: 1, maximum: 1 },
    workerAssetsDigest: '1'.repeat(64),
    images: [
      { role: 'host', profile: 'host', tag: 'fixture:host', id: host },
      { role: 'agent', profile: imageProfile('codex', { apt: [], npm: [] }), tag: 'fixture:agent', id: agent },
    ],
    checks: Object.fromEntries(
      REQUIRED_RELEASE_CHECKS.map((name) => [
        name,
        {
          status: 'passed',
          at: '2026-09-29T13:00:00Z',
          sourceCommit: commit,
          imageIds: name.includes('image') ? [host, agent] : [],
        },
      ]),
    ),
  };
  const file = path.join(root, 'release.json');
  fs.writeFileSync(file, JSON.stringify(manifest));
  fs.writeFileSync(
    path.join(root, 'build-info.json'),
    JSON.stringify({ commit, tree, workerAssetsDigest: manifest.workerAssetsDigest }),
  );
  for (const item of ['container/agent-runner/src', 'container/skills', 'src/deep-research-workflow'])
    fs.mkdirSync(path.join(root, item), { recursive: true });
  fs.writeFileSync(path.join(root, 'container/CLAUDE.md'), 'system instructions');
  return { root, file, manifest };
}
describe('S01-REL04 immutable release runtime', () => {
  it('binds metadata discovery to the packaged host source and worker assets', () => {
    const f = fixture();
    expect(readReleaseAt(f.root, f.file).assetRoot).toBe(f.root);
    fs.writeFileSync(path.join(f.root, 'build-info.json'), JSON.stringify({ commit: '9'.repeat(40), tree }));
    expect(() => readReleaseAt(f.root, f.file)).toThrow('release_payload_mismatch');
  });
  it('refuses missing packaged assets instead of reading the active checkout', () => {
    const f = fixture();
    fs.rmSync(path.join(f.root, 'container/CLAUDE.md'));
    expect(() => readReleaseAt(f.root, f.file)).toThrow('release_asset_missing');
  });
  it('selects a recorded image by provider/package content and verifies its immutable local identity', async () => {
    const f = fixture(),
      inspect = vi.fn().mockResolvedValue({
        Id: agent,
        Os: 'linux',
        Architecture: 'arm64',
        Config: {
          Labels: {
            'org.opencontainers.image.revision': commit,
            'nanoclaw.worker-assets': f.manifest.workerAssetsDigest,
          },
        },
      });
    expect(await selectReleaseImage(readReleaseAt(f.root, f.file), 'codex', { apt: [], npm: [] }, inspect)).toBe(agent);
    expect(inspect).toHaveBeenCalledWith(agent);
    await expect(
      selectReleaseImage(readReleaseAt(f.root, f.file), 'codex', { apt: ['new-package'], npm: [] }, inspect),
    ).rejects.toThrow('image_unavailable');
    expect(inspect).toHaveBeenCalledOnce();
    inspect.mockResolvedValue({ Id: agent, Os: 'linux', Architecture: 'amd64' });
    await expect(
      selectReleaseImage(readReleaseAt(f.root, f.file), 'codex', { apt: [], npm: [] }, inspect),
    ).rejects.toThrow('image_unavailable');
  });
  it('refuses application-code overlays while retaining ordinary data/config mounts', () => {
    expect(() => assertReleaseMounts([{ containerPath: '/workspace/inbound.db' }])).not.toThrow();
    for (const containerPath of ['/app', '/app/src', '/app/skills/custom', '/', '/app/../app/CLAUDE.md'])
      expect(() => assertReleaseMounts([{ containerPath }])).toThrow('release_code_override');
  });
  it('reuses profiles across fresh group IDs but refuses malformed or ambiguous package lists', () => {
    expect(imageProfile('codex', { apt: ['b', 'a'], npm: [] })).toBe(
      imageProfile('codex', { apt: ['a', 'b'], npm: [] }),
    );
    expect(() => imageProfile('codex', { apt: ['a', 'a'], npm: [] })).toThrow('invalid_image_profile');
    expect(() => imageProfile('codex', { apt: ['a; shell'], npm: [] })).toThrow('invalid_image_profile');
  });
});
