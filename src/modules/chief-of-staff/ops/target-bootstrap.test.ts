import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { fixtureRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { payloadDigest } from './payload.js';
import { prepareTargetArtifacts, type BootstrapDocker } from './target-bootstrap.js';
import type { DeploymentSettings } from './deployment-settings.js';
it('retains a stopped exact carrier after a failed extraction and reuses only its verified promoted payload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-extract-'));
  const settings = { releaseRoot: path.join(root, 'releases') } as DeploymentSettings;
  const manifest = fixtureRelease(),
    payload = path.join(root, 'fixture-payload');
  fs.mkdirSync(payload);
  fs.writeFileSync(path.join(payload, 'fixture.txt'), 'tested payload');
  manifest.hostPayloadDigest = await payloadDigest(payload);
  const manifestFile = path.join(root, 'release.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  let created = false,
    loaded = false;
  const docker = vi.fn<BootstrapDocker>(async (args) => {
    if (args[0] === 'image' && args[1] === 'load') {
      loaded = true;
      return 'loaded';
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      if (!loaded) throw new Error('image_not_loaded');
      return JSON.stringify([
        {
          Id: args[2],
          Os: 'linux',
          Architecture: 'arm64',
          Config: {
            Labels: {
              'org.opencontainers.image.revision': manifest.source.commit,
              'nanoclaw.worker-assets': manifest.workerAssetsDigest,
            },
          },
        },
      ]);
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      if (!created) throw new Error('not found');
      return JSON.stringify([
        {
          Id: 'e'.repeat(64),
          Image: manifest.images[0].id,
          State: { Running: false, Status: 'created' },
          Mounts: [],
          Config: { Labels: { 'nanoclaw.extract-release': manifest.releaseId } },
        },
      ]);
    }
    if (args[0] === 'create') {
      created = true;
      return 'e'.repeat(64);
    }
    if (args[0] === 'rm') {
      created = false;
      return '';
    }
    throw new Error('unexpected Docker operation');
  });
  let failExtraction = true;
  const extract = vi.fn(async (id: string, destination: string) => {
    expect(id).toBe('e'.repeat(64));
    if (failExtraction) {
      failExtraction = false;
      fs.writeFileSync(path.join(destination, 'fixture.txt'), 'incomplete copy');
      throw new Error('carrier_extraction_failed');
    }
    fs.copyFileSync(path.join(payload, 'fixture.txt'), path.join(destination, 'fixture.txt'));
  });
  try {
    await expect(
      prepareTargetArtifacts(settings, manifest, manifestFile, path.join(root, 'images.tar.gz'), docker, extract),
    ).rejects.toThrow('carrier_extraction_failed');
    const release = path.join(settings.releaseRoot, manifest.releaseId);
    expect(fs.existsSync(path.join(release, 'payload'))).toBe(false);
    expect(fs.existsSync(path.join(release, 'release.json'))).toBe(false);
    expect(docker.mock.calls.filter(([args]) => args[0] === 'rm')).toHaveLength(0);
    const result = await prepareTargetArtifacts(
      settings,
      manifest,
      manifestFile,
      path.join(root, 'images.tar.gz'),
      docker,
      extract,
    );
    expect(fs.readFileSync(path.join(result.payload, 'fixture.txt'), 'utf8')).toBe('tested payload');
    await expect(
      prepareTargetArtifacts(settings, manifest, manifestFile, path.join(root, 'images.tar.gz'), docker, extract),
    ).resolves.toEqual(result);
    expect(docker.mock.calls.filter(([args]) => args[0] === 'create')).toHaveLength(1);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(docker.mock.calls.filter(([args]) => args[0] === 'image' && args[1] === 'load')).toHaveLength(1);
    expect(docker.mock.calls.flatMap(([args]) => args)).not.toContain('start');
    expect(docker.mock.calls.flatMap(([args]) => args)).not.toContain('build');
    fs.writeFileSync(path.join(result.payload, 'fixture.txt'), 'altered');
    await expect(
      prepareTargetArtifacts(settings, manifest, manifestFile, path.join(root, 'images.tar.gz'), docker, extract),
    ).rejects.toThrow('release_payload_mismatch');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it('refuses incomplete local checks before loading an archive', async () => {
  const manifest = fixtureRelease();
  manifest.checks.root.status = 'failed';
  const docker = vi.fn();
  await expect(
    prepareTargetArtifacts(
      {} as DeploymentSettings,
      manifest,
      '/fixture/release.json',
      '/fixture/images.tar.gz',
      docker,
    ),
  ).rejects.toThrow('release_not_transferable');
  expect(docker).not.toHaveBeenCalled();
});
