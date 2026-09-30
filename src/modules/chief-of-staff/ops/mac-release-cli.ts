/** Project tooling for the host shell coordinator. This file runs only in the devcontainer. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { readEnvFile } from '../../../env.js';
import { safeHostEnvironment } from '../../../host-environment.js';
import { imageProfile } from '../../../release-runtime.js';
import { prepareBuildContext, validateMacBuilder } from './build-context.js';
import { readPrivate, writeAtomic } from './target-state.js';
import { deploymentSettings } from './deployment-settings.js';
import { digest } from '../domain/contracts.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../store/migrations.js';
import { REQUIRED_RELEASE_CHECKS, type ReleaseManifest } from './release-manifest.js';
import {
  completeLocalRelease,
  selectTestEnvironment,
  TEST_ENVIRONMENT_KEYS,
  checkpointLocalExecution,
  readLocalExecution,
} from './mac-release.js';
import { imageConfigurations } from './image-archive.js';
import { artifactHash, verifyReleaseBundle } from './release-artifacts.js';
import { validateTargetObservation } from './mac-deploy.js';

export const BUILD_TARGETS = ['host', 'agent-standard', 'agent-documents'] as const;
type BuildTarget = (typeof BUILD_TARGETS)[number];
type Plan = Omit<ReleaseManifest, 'checks'> & {
  checks: ReleaseManifest['checks'];
  targetDigest: string;
  builder?: string;
  context?: string;
};
function releaseRoot(id: string): string {
  if (!/^release-[a-f0-9]{12}-[0-9]{14}$/.test(id)) throw new Error('invalid_local_release');
  const root = path.resolve('.cos-plan-state/releases', id);
  if (fs.realpathSync(root) !== root || (fs.statSync(root).mode & 0o777) !== 0o700)
    throw new Error('unsafe_local_release');
  return root;
}
function testRoot(id: string) {
  return path.resolve('.cos-plan-state/release-tests', id);
}
function checkedPlan(id: string): { root: string; plan: Plan } {
  const root = releaseRoot(id),
    plan = readPrivate<Plan>(path.join(root, 'plan.json'));
  const current = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (plan.slice !== readLocalExecution(path.resolve('.cos-plan-state')).active_slice)
    throw new Error('active_slice_required');
  if (plan.source.commit !== current || dirty) throw new Error('clean_candidate_required');
  const target = deploymentSettings(readPrivate(path.resolve('.cos-plan-state/deployment-target.json')));
  if (digest(target) !== plan.targetDigest) throw new Error('deployment_target_changed');
  return { root, plan };
}
function inspect(root: string, target: BuildTarget) {
  const value = readPrivate<
    Array<{ Id: string; Os: string; Architecture: string; Config: { Labels: Record<string, string> } }>
  >(path.join(root, target + '-inspect.json'));
  if (!Array.isArray(value) || value.length !== 1) throw new Error('invalid_image_inspection');
  return value[0];
}
export async function macReleaseCommand(args: string[]): Promise<string | void> {
  const [operation, id, ...values] = args;
  if (operation === 'certificate' && args.length === 1) {
    const file = readEnvFile(['COS_TEST_PGSSLROOTCERT']).COS_TEST_PGSSLROOTCERT;
    if (!file || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) throw new Error('test_certificate_required');
    return file;
  }
  if (operation === 'init' && values.length === 3) {
    const [commit, fetchRef, slice] = values;
    if (slice !== 'S02' || SCHEMA_VERSION !== 2) throw new Error('current_release_slice_required');
    if (!/^[a-f0-9]{40}$/.test(commit) || !/^refs\/heads\/[a-zA-Z0-9_./-]+$/.test(fetchRef) || fetchRef.includes('..'))
      throw new Error('invalid_candidate_source');
    const root = releaseRoot(id);
    if (fs.existsSync(path.join(root, 'plan.json'))) throw new Error('release_already_exists');
    const target = deploymentSettings(readPrivate(path.resolve('.cos-plan-state/deployment-target.json')));
    if (readLocalExecution(path.resolve('.cos-plan-state'), true).active_slice !== slice)
      throw new Error('active_slice_required');
    const metadata = await prepareBuildContext(process.cwd(), commit, path.join(root, 'context'));
    const plan: Plan = {
      contract: 'cos-release/v1',
      releaseId: id,
      slice,
      platform: 'linux/arm64',
      source: {
        repository: 'ufJmacca/nanoclaw',
        commit,
        tree: metadata.sourceTree,
        fetchRef,
        syncContract: 'cos-source-sync/github-pinned-v1',
      },
      buildInputDigest: metadata.buildInputDigest,
      workerAssetsDigest: metadata.workerAssetsDigest,
      hostPayloadDigest: '',
      rpc: 'cos-rpc/v1',
      postgres: { minimum: SCHEMA_VERSION, maximum: SCHEMA_VERSION },
      sqlite: { minimum: 22, maximum: 22 },
      migrations: MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })),
      previousReleaseIds: [],
      images: [],
      checks: {},
      targetDigest: digest(target),
    };
    writeAtomic(root, 'plan.json', plan);
    checkedPlan(id);
    checkpointLocalExecution(path.resolve('.cos-plan-state'), {
      head_sha: commit,
      release_build_id: id,
      release_status: 'local_checks_pending',
    });
    fs.mkdirSync(testRoot(id), { recursive: true, mode: 0o700 });
    return;
  }
  const { root, plan } = checkedPlan(id);
  if (operation === 'target' && !values.length) {
    const settings = deploymentSettings(readPrivate(path.resolve('.cos-plan-state/deployment-target.json')));
    const state = validateTargetObservation(settings, readPrivate(path.join(root, 'target-observation.json')));
    plan.previousReleaseIds = state?.releaseId ? [state.releaseId] : [];
    writeAtomic(root, 'plan.json', plan);
    return;
  }
  if (operation === 'builder' && !values.length) {
    const context = readPrivate<{ Name: string; Endpoints: { docker: { Host: string } } }>(
      path.join(root, 'context.json'),
    );
    const engine = readPrivate<{ OperatingSystem: string; Architecture: string }>(path.join(root, 'engine.json'));
    const entries = fs
      .readFileSync(path.join(root, 'builders.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const current = [...new Set(entries.filter((item) => item.Current).map((item) => JSON.stringify(item)))].map(
      (item) => JSON.parse(item),
    );
    if (
      current.length !== 1 ||
      current[0].Driver !== 'docker' ||
      current[0].Name !== context.Name ||
      !/^[a-zA-Z0-9_-]+$/.test(context.Name)
    )
      throw new Error('mac_local_builder_required');
    const nodes = current[0].Nodes.map((node: { Endpoint: string; Platforms: string[] }) => ({
      endpoint: node.Endpoint === context.Name ? context.Endpoints.docker.Host : node.Endpoint,
      platforms: node.Platforms,
    }));
    validateMacBuilder({
      clientPlatform: 'darwin',
      endpoint: context.Endpoints.docker.Host,
      operatingSystem: engine.OperatingSystem,
      architecture: engine.Architecture,
      nodes,
    });
    plan.builder = current[0].Name;
    plan.context = context.Name;
    writeAtomic(root, 'plan.json', plan);
    return;
  }
  if (operation === 'field' && values.length === 1) {
    const fields: Record<string, string | undefined> = {
      commit: plan.source.commit,
      tree: plan.source.tree,
      assets: plan.workerAssetsDigest,
      builder: plan.builder,
      context: plan.context,
    };
    for (const target of BUILD_TARGETS) {
      fields[target + '-tag'] = `nanoclaw-cos-${target}:${id}`;
      fields[target + '-id'] = plan.images.find((image) => image.tag === fields[target + '-tag'])?.id;
    }
    if (!Object.hasOwn(fields, values[0]) || !fields[values[0]]) throw new Error('release_field_unavailable');
    return fields[values[0]];
  }
  if (operation === 'profile' && values.length === 0) {
    const certificate = path.join(testRoot(id), 'ca.pem');
    await artifactHash(certificate, 1024 * 1024);
    const selected = selectTestEnvironment(readEnvFile([...TEST_ENVIRONMENT_KEYS]), '/fixture/ca.pem');
    fs.writeFileSync(
      path.join(testRoot(id), 'test.env'),
      Object.entries(selected)
        .map(([key, value]) => key + '=' + value)
        .join('\n') + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    return;
  }
  if (operation === 'fixture' && values.length === 4) {
    const [mode, hostRoot, image, volume] = values;
    if (
      !['slice', 'demo'].includes(mode) ||
      !path.isAbsolute(hostRoot) ||
      !/^sha256:[a-f0-9]{64}$/.test(image) ||
      !/^[a-zA-Z0-9_.-]+$/.test(volume)
    )
      throw new Error('invalid_fixture_configuration');
    const selected = selectTestEnvironment(readEnvFile([...TEST_ENVIRONMENT_KEYS]), path.join(testRoot(id), 'ca.pem'));
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/contracts/chief-of-staff/run.ts',
        ...(mode === 'demo' ? ['--demo', '--fixture'] : []),
        '--slice',
        plan.slice,
        '--db-profile',
        'test',
      ],
      {
        env: {
          ...safeHostEnvironment('docker'),
          ...selected,
          COS_FIXTURE_HOST_ROOT: hostRoot,
          COS_FIXTURE_IMAGE: image,
          COS_FIXTURE_RUNNER_VOLUME: volume,
        },
        stdio: 'inherit',
        timeout: 180000,
      },
    );
    if (result.status !== 0) throw new Error('local_fixture_failed');
    return;
  }
  if (operation === 'images' && !values.length) {
    if (['root', 'runner', 'slice', 'demo'].some((name) => plan.checks[name]?.status !== 'passed'))
      throw new Error('local_checks_required');
    plan.images = BUILD_TARGETS.map((target) => {
      const actual = inspect(root, target);
      if (
        !/^sha256:[a-f0-9]{64}$/.test(actual.Id) ||
        actual.Os !== 'linux' ||
        actual.Architecture !== 'arm64' ||
        actual.Config.Labels['org.opencontainers.image.revision'] !== plan.source.commit ||
        actual.Config.Labels['nanoclaw.worker-assets'] !== plan.workerAssetsDigest
      )
        throw new Error('built_image_mismatch');
      const apt =
        target === 'agent-documents'
          ? ['poppler-utils', 'python3', 'python3-pip', 'python3-venv', 'python3-reportlab', 'python3-pypdf']
          : [];
      return {
        role: target === 'host' ? 'host' : 'agent',
        profile: target === 'host' ? 'host' : imageProfile('codex', { apt, npm: [] }),
        tag: `nanoclaw-cos-${target}:${id}`,
        id: actual.Id,
        configurationId: 'sha256:' + '0'.repeat(64),
      };
    });
    writeAtomic(root, 'plan.json', plan);
    return;
  }
  if (operation === 'record' && values.length === 2) {
    const [name, status] = values;
    if (
      !REQUIRED_RELEASE_CHECKS.includes(name as (typeof REQUIRED_RELEASE_CHECKS)[number]) ||
      !['0', '1'].includes(status)
    )
      throw new Error('invalid_check_result');
    if (name.includes('image') && plan.images.length !== BUILD_TARGETS.length)
      throw new Error('image_identity_required');
    plan.checks[name] = {
      status: status === '0' ? 'passed' : 'failed',
      at: new Date().toISOString(),
      sourceCommit: plan.source.commit,
      imageIds: name.includes('image') ? plan.images.map((image) => image.id) : [],
    };
    writeAtomic(root, 'plan.json', plan);
    checkpointLocalExecution(path.resolve('.cos-plan-state'), { release_local_checks: plan.checks });
    return;
  }
  if (operation === 'finish' && !values.length) {
    plan.hostPayloadDigest = fs.readFileSync(path.join(root, 'payload.sha256'), 'utf8').trim();
    const stream = fs.createReadStream(path.join(root, 'images.tar.gz')),
      expanded = createGunzip();
    const copying = pipeline(stream, expanded);
    void copying.catch(() => {});
    try {
      const saved = await imageConfigurations(expanded);
      await copying;
      for (const image of plan.images) {
        const actual = saved.find((item) => item.tags.length === 1 && item.tags[0] === image.tag);
        if (!actual) throw new Error('release_archive_mismatch');
        image.configurationId = actual.configurationId;
      }
    } finally {
      stream.destroy();
      expanded.destroy();
      await copying.catch(() => {});
    }
    const { targetDigest: _target, builder: _builder, context: _context, ...candidate } = plan;
    const manifest = completeLocalRelease(candidate, plan.checks);
    writeAtomic(root, 'release.json', manifest);
    const manifestHash = await artifactHash(path.join(root, 'release.json')),
      archiveHash = await artifactHash(path.join(root, 'images.tar.gz')),
      bootstrapHash = await artifactHash(path.join(root, 'bootstrap.mjs'), 1024 * 1024);
    fs.writeFileSync(path.join(root, 'SHA256SUMS'), `${manifestHash}  release.json\n${archiveHash}  images.tar.gz\n`, {
      mode: 0o600,
    });
    await verifyReleaseBundle(root, manifestHash);
    writeAtomic(root, 'local-tests.json', {
      status: 'transferable',
      source: manifest.source,
      checks: manifest.checks,
      manifestHash,
      archiveHash,
      bootstrapHash,
      at: new Date().toISOString(),
    });
    checkpointLocalExecution(path.resolve('.cos-plan-state'), {
      release_status: 'transferable',
      local_test_status: 'passed',
      target_image_test_status: 'passed_on_mac_linux_arm64',
      release_manifest_ref: path.relative(process.cwd(), path.join(root, 'release.json')),
      release_image_ids: manifest.images,
      verified_source_commit: manifest.source.commit,
      verified_source_tree: manifest.source.tree,
      release_local_checks: manifest.checks,
    });
    return manifestHash;
  }
  throw new Error('invalid_release_operation');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.env.NANOCLAW_LOG_STDERR = 'true';
  macReleaseCommand(process.argv.slice(2))
    .then((value) => {
      if (value !== undefined) console.log(value);
    })
    .catch((error) => {
      // Credentials and underlying connection/process diagnostics never enter the public CLI error.
      const code =
        error instanceof Error && /^[a-z_]{1,80}$/.test(error.message) ? error.message : 'local_release_failed';
      console.error(JSON.stringify({ status: 'failed', code }));
      process.exitCode = 1;
    });
}
