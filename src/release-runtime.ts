/** Host-owned release mode. Runtime data stays under cwd; code metadata comes from this payload. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { safeHostEnvironment } from './host-environment.js';
import { validateReleaseManifest, type ReleaseManifest } from './modules/chief-of-staff/ops/release-manifest.js';
export type ReleaseRuntime = { manifest: ReleaseManifest; assetRoot: string };
type Packages = { apt: string[]; npm: string[] };
export function releaseMode(): boolean {
  return process.env.NANOCLAW_RELEASE_MANIFEST !== undefined;
}
export function imageProfile(provider: string, packages: Packages): string {
  if (
    !/^[a-z][a-z0-9-]{0,20}$/.test(provider) ||
    !packages ||
    [packages.apt, packages.npm].some(
      (items) =>
        !Array.isArray(items) ||
        items.length > 100 ||
        new Set(items).size !== items.length ||
        items.some((item) => typeof item !== 'string' || !/^[@a-zA-Z0-9][@a-zA-Z0-9._/+~:=-]{0,199}$/.test(item)),
    )
  )
    throw new Error('invalid_image_profile');
  const hash = createHash('sha256')
    .update(JSON.stringify({ apt: [...packages.apt].sort(), npm: [...packages.npm].sort() }))
    .digest('hex');
  return `${provider}-${hash.slice(0, 32)}`;
}
function readJson(file: string): unknown {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 262144) throw new Error('invalid_release_metadata');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}
export function readReleaseAt(assetRoot: string, manifestPath: string): ReleaseRuntime {
  if (!path.isAbsolute(manifestPath) || !path.isAbsolute(assetRoot) || fs.realpathSync(assetRoot) !== assetRoot)
    throw new Error('invalid_release_metadata');
  const manifest = validateReleaseManifest(readJson(manifestPath));
  const info = readJson(path.join(assetRoot, 'build-info.json')) as Record<string, unknown>;
  if (
    info?.commit !== manifest.source.commit ||
    info?.tree !== manifest.source.tree ||
    info?.workerAssetsDigest !== manifest.workerAssetsDigest
  )
    throw new Error('release_payload_mismatch');
  for (const item of [
    'container/CLAUDE.md',
    'container/agent-runner/src',
    'container/skills',
    'src/deep-research-workflow',
  ]) {
    const file = path.join(assetRoot, item),
      stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (
      !stat ||
      stat.isSymbolicLink() ||
      fs.realpathSync(file) !== file ||
      (item.endsWith('.md') ? !stat.isFile() : !stat.isDirectory())
    )
      throw new Error('release_asset_missing');
  }
  return { manifest, assetRoot };
}
export function currentRelease(): ReleaseRuntime | null {
  if (!releaseMode()) return null;
  // Both src/ and compiled dist/ live one level below the immutable payload root.
  return readReleaseAt(
    path.resolve(fileURLToPath(new URL('..', import.meta.url))),
    process.env.NANOCLAW_RELEASE_MANIFEST!,
  );
}
export function codeAssetRoot(): string {
  return currentRelease()?.assetRoot ?? process.cwd();
}
export function assertReleaseMounts(mounts: ReadonlyArray<{ containerPath: string }>): void {
  for (const mount of mounts) {
    const target = path.posix.resolve(mount.containerPath);
    if (target === '/' || target === '/app' || target.startsWith('/app/')) throw new Error('release_code_override');
  }
}
export type ImageInspection = {
  Id?: string;
  Os?: string;
  Architecture?: string;
  Config?: { Labels?: Record<string, string> };
};
async function inspectImage(id: string): Promise<ImageInspection> {
  const { stdout } = await promisify(execFile)('docker', ['image', 'inspect', id], {
    env: safeHostEnvironment('docker'),
    timeout: 10000,
    maxBuffer: 262144,
  });
  const result = JSON.parse(stdout);
  if (!Array.isArray(result) || result.length !== 1) throw new Error('image_unavailable');
  return result[0];
}
export async function selectReleaseImage(
  release: ReleaseRuntime,
  provider: string,
  packages: Packages,
  inspect: (id: string) => Promise<ImageInspection> = inspectImage,
): Promise<string> {
  const profile = imageProfile(provider, packages);
  const image = release.manifest.images.find((item) => item.role === 'agent' && item.profile === profile);
  if (!image) throw new Error('image_unavailable');
  let actual: ImageInspection;
  try {
    actual = await inspect(image.id);
  } catch (error) {
    throw new Error('image_unavailable', { cause: error });
  }
  if (
    actual.Id !== image.id ||
    actual.Os !== 'linux' ||
    actual.Architecture !== 'arm64' ||
    actual.Config?.Labels?.['org.opencontainers.image.revision'] !== release.manifest.source.commit ||
    actual.Config?.Labels?.['nanoclaw.worker-assets'] !== release.manifest.workerAssetsDigest
  )
    throw new Error('image_unavailable');
  return image.id;
}
