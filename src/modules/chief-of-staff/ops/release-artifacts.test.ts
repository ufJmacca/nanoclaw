import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fixtureRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { verifySavedImages, verifyLoadedImages, verifyReleaseBundle } from './release-artifacts.js';
import type { SavedImage } from './image-archive.js';
import type { ImageInspection } from '../../../release-runtime.js';

function fixture() {
  const manifest = fixtureRelease();
  const saved: SavedImage[] = manifest.images.map((image) => ({
    configurationId: image.configurationId,
    tags: [image.tag],
    os: 'linux',
    architecture: 'arm64',
    labels: {
      'org.opencontainers.image.revision': manifest.source.commit,
      'nanoclaw.worker-assets': manifest.workerAssetsDigest,
    },
  }));
  return { manifest, saved };
}
it('checks configuration bytes, source labels, exact declared image set and platform before loading', () => {
  const { manifest, saved } = fixture();
  expect(() => verifySavedImages(manifest, saved)).not.toThrow();
  for (const altered of [
    saved.slice(1),
    [...saved, saved[0]],
    saved.map((item, i) => (i === 0 ? { ...item, configurationId: 'sha256:' + '9'.repeat(64) } : item)),
    saved.map((item) => ({ ...item, architecture: 'amd64' })),
    saved.map((item) => ({ ...item, labels: { ...item.labels, 'org.opencontainers.image.revision': 'wrong' } })),
    saved.map((item) => ({ ...item, tags: [...item.tags, 'foreign:tag'] })),
  ])
    expect(() => verifySavedImages(manifest, altered)).toThrow('release_archive_mismatch');
});

it('rejects partial transfer, changed checksums and failed evidence before archive admission', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-bundle-'));
  const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  const manifest = fixtureRelease(),
    files: Record<string, string> = {};
  const entries = manifest.images.map((image) => {
    const config = JSON.stringify({
      os: 'linux',
      architecture: 'arm64',
      rootfs: { type: 'layers', diff_ids: [] },
      config: {
        Labels: {
          'org.opencontainers.image.revision': manifest.source.commit,
          'nanoclaw.worker-assets': manifest.workerAssetsDigest,
        },
      },
      comment: image.role,
    });
    image.configurationId = 'sha256:' + hash(config);
    const file = hash(config) + '.json';
    files[file] = config;
    return { Config: file, RepoTags: [image.tag], Layers: [] };
  });
  files['manifest.json'] = JSON.stringify(entries);
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const bytes = Buffer.from(text),
      header = Buffer.alloc(512);
    header.write(name);
    header.write('0000644\0', 100);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257);
    header.write(
      header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
    );
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  const archive = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])),
    text = JSON.stringify(manifest);
  try {
    fs.writeFileSync(path.join(root, 'release.json'), text, { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'images.tar.gz'), archive, { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'SHA256SUMS'), `${hash(text)}  release.json\n${hash(archive)}  images.tar.gz\n`, {
      mode: 0o600,
    });
    await expect(verifyReleaseBundle(root, hash(text))).resolves.toMatchObject({ manifest });
    await expect(verifyReleaseBundle(root, '0'.repeat(64))).rejects.toThrow('release_manifest_mismatch');
    fs.writeFileSync(path.join(root, 'images.tar.gz'), archive.subarray(0, 40));
    await expect(verifyReleaseBundle(root, hash(text))).rejects.toThrow('release_archive_mismatch');
    fs.writeFileSync(path.join(root, 'images.tar.gz'), archive);
    manifest.checks.root.status = 'failed';
    const failed = JSON.stringify(manifest);
    fs.writeFileSync(path.join(root, 'release.json'), failed);
    await expect(verifyReleaseBundle(root, hash(failed))).rejects.toThrow('release_not_transferable');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it('inspects immutable engine identities after load and never accepts matching tags alone', async () => {
  const { manifest } = fixture();
  const inspect = vi.fn(
    async (id: string): Promise<ImageInspection> => ({
      Id: id,
      Os: 'linux',
      Architecture: 'arm64',
      Config: {
        Labels: {
          'org.opencontainers.image.revision': manifest.source.commit,
          'nanoclaw.worker-assets': manifest.workerAssetsDigest,
        },
      },
    }),
  );
  await verifyLoadedImages(manifest, inspect);
  expect(inspect.mock.calls.map((call) => call[0])).toEqual(manifest.images.map((item) => item.id));
  inspect.mockImplementation(async () => ({
    Id: 'foreign',
    Os: 'linux',
    Architecture: 'arm64',
    Config: { Labels: {} },
  }));
  await expect(verifyLoadedImages(manifest, inspect)).rejects.toThrow('release_loaded_image_mismatch');
});
