/** Bundled into one tested bootstrap.mjs on the Mac. Uses only the Pi's existing Node, Git and Docker. */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { digest } from '../domain/contracts.js';
import { deploymentSettings, type DeploymentSettings } from './deployment-settings.js';
import { readPrivate, writeAtomic } from './target-state.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import { artifactHash, verifyReleaseBundle, verifyLoadedImages } from './release-artifacts.js';
import { payloadDigest } from './payload.js';
import { machineFingerprint } from './host-fingerprint.js';
import { withDeploymentLock } from './deployment-lock.js';
import { syncPinnedSource } from './source-sync.js';

export type BootstrapDocker = (args: string[]) => Promise<string>;
function privateDirectory(directory: string): void {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory)
    throw new Error('unsafe_bootstrap_directory');
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })) {
    let existing = path.dirname(directory);
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    const parent = fs.statSync(existing);
    if (fs.realpathSync(existing) !== existing || parent.uid !== process.getuid?.() || parent.mode & 0o022)
      throw new Error('unsafe_bootstrap_directory');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    fs.realpathSync(directory) !== directory ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('unsafe_bootstrap_directory');
}
/** Invoked only after verifyReleaseBundle has authenticated the complete saved archive against the supplied hash. */
export async function prepareTargetArtifacts(
  settings: DeploymentSettings,
  input: ReleaseManifest,
  manifestFile: string,
  archiveFile: string,
  docker: BootstrapDocker,
) {
  const manifest = validateReleaseManifest(input);
  if (digest(validateReleaseManifest(readPrivate(manifestFile))) !== digest(manifest))
    throw new Error('release_manifest_mismatch');
  privateDirectory(settings.releaseRoot);
  const release = path.join(settings.releaseRoot, manifest.releaseId),
    payload = path.join(release, 'payload'),
    partial = path.join(release, 'payload.partial');
  privateDirectory(release);
  const marker = path.join(release, 'extraction.json');
  const identity = { version: 1, releaseId: manifest.releaseId, manifestDigest: digest(manifest) };
  if (fs.lstatSync(marker, { throwIfNoEntry: false })) {
    if (digest(readPrivate(marker)) !== digest(identity)) throw new Error('release_extraction_conflict');
  } else {
    if (fs.readdirSync(release).length) throw new Error('release_extraction_conflict');
    writeAtomic(release, 'extraction.json', identity);
  }
  const inspect = async (id: string) => {
    const result = JSON.parse(await docker(['image', 'inspect', id]));
    if (!Array.isArray(result) || result.length !== 1) throw new Error('release_loaded_image_mismatch');
    return result[0];
  };
  // A lost load acknowledgement must not force another full import of already verified immutable images.
  let loaded = false;
  try {
    await verifyLoadedImages(manifest, inspect);
    loaded = true;
  } catch {
    /* Missing or mismatched images must still pass verification after loading the authenticated archive. */
  }
  if (!loaded) {
    await docker(['image', 'load', '--input', archiveFile]);
    await verifyLoadedImages(manifest, inspect);
  }
  if (!fs.lstatSync(payload, { throwIfNoEntry: false })) {
    privateDirectory(partial);
    const host = manifest.images.find((image) => image.role === 'host')!;
    const name = 'cos-carrier-' + digest(identity).slice(0, 24);
    let container: unknown;
    try {
      container = JSON.parse(await docker(['container', 'inspect', name]))[0];
    } catch {
      container = undefined;
    }
    if (!container) {
      const id = (
        await docker([
          'create',
          '--pull=never',
          '--network=none',
          '--name',
          name,
          '--label',
          'nanoclaw.extract-release=' + manifest.releaseId,
          '--entrypoint',
          '/bin/true',
          host.id,
        ])
      ).trim();
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid_carrier_identity');
      container = JSON.parse(await docker(['container', 'inspect', name]))[0];
    }
    const actual = container as {
      Id: string;
      Image: string;
      State: { Running: boolean; Status: string };
      Mounts: unknown[];
      Config: { Labels: Record<string, string> };
    };
    if (
      !actual ||
      !/^([a-f0-9]{64})$/.test(actual.Id) ||
      actual.Image !== host.id ||
      actual.State?.Running !== false ||
      actual.State.Status !== 'created' ||
      !Array.isArray(actual.Mounts) ||
      actual.Mounts.length !== 0 ||
      actual.Config?.Labels?.['nanoclaw.extract-release'] !== manifest.releaseId
    )
      throw new Error('carrier_identity_conflict');
    await docker(['cp', actual.Id + ':/release/.', partial]);
    if ((await payloadDigest(partial)) !== manifest.hostPayloadDigest) throw new Error('release_payload_mismatch');
    fs.renameSync(partial, payload);
    await docker(['rm', actual.Id]);
  }
  if ((await payloadDigest(payload)) !== manifest.hostPayloadDigest) throw new Error('release_payload_mismatch');
  const destination = path.join(release, 'release.json'),
    sourceHash = await artifactHash(manifestFile, 262144);
  if (fs.lstatSync(destination, { throwIfNoEntry: false })) {
    if ((await artifactHash(destination, 262144)) !== sourceHash) throw new Error('release_manifest_mismatch');
  } else {
    fs.copyFileSync(manifestFile, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
  }
  return { releaseId: manifest.releaseId, payload, hostPayloadDigest: manifest.hostPayloadDigest };
}
export async function bootstrapCommand(args: string[]): Promise<Record<string, unknown>> {
  const [command, settingsFile, releaseId, manifestHash] = args;
  if (
    args.length !== 4 ||
    !['source', 'prepare'].includes(command) ||
    !path.isAbsolute(settingsFile) ||
    !/^release-[a-zA-Z0-9_-]{1,120}$/.test(releaseId) ||
    !/^[a-f0-9]{64}$/.test(manifestHash)
  )
    throw new Error('invalid_bootstrap_arguments');
  const settings = deploymentSettings(readPrivate(settingsFile));
  if (machineFingerprint() !== settings.hostFingerprint || process.getuid?.() === 0)
    throw new Error('wrong_bootstrap_target');
  for (const directory of [settings.userHome, settings.installationRoot, settings.dataRoot]) {
    const stat = fs.lstatSync(directory);
    if (
      !stat.isDirectory() ||
      fs.realpathSync(directory) !== directory ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o022
    )
      throw new Error('wrong_bootstrap_target');
  }
  process.chdir(settings.installationRoot);
  const stage = path.join(settings.stagingRoot, releaseId),
    manifestFile = path.join(stage, 'release.json');
  privateDirectory(settings.stagingRoot);
  privateDirectory(stage);
  if (fs.realpathSync(stage) !== stage || (await artifactHash(manifestFile, 262144)) !== manifestHash)
    throw new Error('release_manifest_mismatch');
  const manifest = validateReleaseManifest(readPrivate(manifestFile));
  if (manifest.releaseId !== releaseId) throw new Error('release_manifest_mismatch');
  // All newly created administrative paths are owned and private; existing installation paths are unchanged.
  const stateParent = path.dirname(settings.stateRoot);
  if (!fs.existsSync(stateParent)) privateDirectory(stateParent);
  return withDeploymentLock(settings.stateRoot + '.operation.lock', async () => {
    const source = await syncPinnedSource({
      repository: settings.installationRoot,
      sourceRoot: settings.sourceRoot,
      releaseId,
      source: manifest.source,
    });
    writeAtomic(stage, 'source.json', source);
    if (command === 'source') return { status: 'source_verified', releaseId, commit: source.commit, tree: source.tree };
    const bundle = await verifyReleaseBundle(stage, manifestHash);
    const required = fs.statSync(bundle.archiveFile).size * 3 + 512 * 1024 * 1024,
      disk = fs.statfsSync(settings.userHome);
    if (disk.bavail * disk.bsize < required) throw new Error('insufficient_target_disk');
    const docker: BootstrapDocker = async (params) =>
      (
        await promisify(execFile)('/usr/bin/docker', ['--host=unix:///var/run/docker.sock', ...params], {
          env: { PATH: '/usr/bin:/bin', HOME: settings.userHome },
          timeout: params[0] === 'image' && params[1] === 'load' ? 1800000 : 600000,
          maxBuffer: 2 * 1024 * 1024,
        })
      ).stdout.trim();
    const result = await prepareTargetArtifacts(settings, manifest, manifestFile, bundle.archiveFile, docker);
    writeAtomic(stage, 'prepared.json', {
      status: 'prepared',
      ...result,
      manifestHash,
      archiveHash: bundle.archiveHash,
    });
    return { status: 'prepared', releaseId, sourceCommit: source.commit, sourceTree: source.tree };
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.env.NANOCLAW_LOG_STDERR = 'true';
  bootstrapCommand(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(JSON.stringify({ status: 'unavailable', code: 'bootstrap_failed' }));
      process.exitCode = 1;
    });
}
