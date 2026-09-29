import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import type { ImageInspection } from '../../../release-runtime.js';
import { imageConfigurations, type SavedImage } from './image-archive.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';

export function verifySavedImages(manifest: ReleaseManifest, saved: SavedImage[]): void {
  if (
    saved.length !== manifest.images.length ||
    new Set(saved.map((image) => image.configurationId)).size !== saved.length
  )
    throw new Error('release_archive_mismatch');
  for (const image of manifest.images) {
    const actual = saved.find((item) => item.configurationId === image.configurationId);
    if (
      !actual ||
      !actual.engineIds.includes(image.id) ||
      actual.os !== 'linux' ||
      actual.architecture !== 'arm64' ||
      actual.tags.length !== 1 ||
      actual.tags[0] !== image.tag ||
      actual.labels['org.opencontainers.image.revision'] !== manifest.source.commit ||
      actual.labels['nanoclaw.worker-assets'] !== manifest.workerAssetsDigest
    )
      throw new Error('release_archive_mismatch');
  }
}
export async function verifyLoadedImages(
  manifest: ReleaseManifest,
  inspect: (id: string) => Promise<ImageInspection>,
): Promise<void> {
  for (const image of manifest.images) {
    const actual = await inspect(image.id);
    if (
      actual.Id !== image.id ||
      actual.Os !== 'linux' ||
      actual.Architecture !== 'arm64' ||
      actual.Config?.Labels?.['org.opencontainers.image.revision'] !== manifest.source.commit ||
      actual.Config?.Labels?.['nanoclaw.worker-assets'] !== manifest.workerAssetsDigest
    )
      throw new Error('release_loaded_image_mismatch');
  }
}
export async function artifactHash(file: string, maximum = 64 * 1024 * 1024 * 1024): Promise<string> {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum || stat.uid !== process.getuid?.() || stat.mode & 0o022)
      throw new Error('unsafe_release_artifact');
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file, { fd, autoClose: false })) hash.update(chunk);
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}
/** The expected manifest hash comes from the Mac's verified receipt over authenticated SSH. */
export async function verifyReleaseBundle(root: string, expectedManifestHash: string) {
  if (
    !/^[a-f0-9]{64}$/.test(expectedManifestHash) ||
    !path.isAbsolute(root) ||
    fs.realpathSync(root) !== root ||
    !fs.lstatSync(root).isDirectory()
  )
    throw new Error('unsafe_release_bundle');
  const manifestFile = path.join(root, 'release.json'),
    archiveFile = path.join(root, 'images.tar.gz');
  if ((await artifactHash(manifestFile, 262144)) !== expectedManifestHash) throw new Error('release_manifest_mismatch');
  const manifest = validateReleaseManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
  const sumsFile = path.join(root, 'SHA256SUMS');
  await artifactHash(sumsFile, 1024);
  const sums = fs.readFileSync(sumsFile, 'utf8');
  const match = /^([a-f0-9]{64}) {2}release\.json\n([a-f0-9]{64}) {2}images\.tar\.gz\n$/.exec(sums);
  if (!match || match[1] !== expectedManifestHash || (await artifactHash(archiveFile)) !== match[2])
    throw new Error('release_archive_mismatch');
  const compressed = fs.createReadStream(archiveFile),
    expanded = createGunzip();
  const copying = pipeline(compressed, expanded);
  // Observe stream failures immediately; metadata parsing and transport must both finish successfully.
  void copying.catch(() => {});
  try {
    verifySavedImages(manifest, await imageConfigurations(expanded));
    await copying;
  } finally {
    compressed.destroy();
    expanded.destroy();
    await copying.catch(() => {});
  }
  return { manifest, manifestHash: expectedManifestHash, archiveHash: match[2], archiveFile };
}
