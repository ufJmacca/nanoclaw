/** Project tooling for the host shell coordinator. This file runs only in the devcontainer. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { readEnvFile } from '../../../env.js';
import { safeHostEnvironment } from '../../../host-environment.js';
import { imageProfile } from '../../../release-runtime.js';
import { prepareBuildContext, validateMacBuilder } from './build-context.js';
import { readPrivate, writeAtomic } from './target-state.js';
import { deploymentSettings } from './deployment-settings.js';
import { digest } from '../domain/contracts.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../store/migrations.js';
import { requiredReleaseChecks, validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import { vaultRootArtifactSeal } from './vault-root-artifact.js';
import { verifyVaultWireEvidence, verifyVaultFixtureImage } from './vault-fixture-evidence.js';
import {
  completeLocalRelease,
  selectTestEnvironment,
  TEST_ENVIRONMENT_KEYS,
  checkpointReleaseExecution,
  readReleaseExecution,
} from './mac-release.js';
import { imageConfigurations } from './image-archive.js';
import { artifactHash, verifyReleaseBundle } from './release-artifacts.js';
import { validateBuildTargetObservation } from './mac-deploy.js';
import { packageResticReleaseArtifact, verifyResticReleaseArtifactInput } from './restic-release-package.js';
import { beginStageTiming, finishStageTiming, readStageTimings } from './stage-timing.js';
import { validateResticArtifactSeal } from './restic-artifact.js';
import { verifyBackupJobFixtureImage, verifyBackupJobFixtureEvidence } from './backup-job-fixture-evidence.js';
import { verifyBackupSmbFixtureImages, verifyBackupSmbFixtureEvidence } from './backup-smb-fixture-evidence.js';
import { verifyBackupRepositoryFixtureEvidence } from './backup-repository-fixture-evidence.js';
import { verifyBackupCredentialReleaseEvidence } from './backup-vault-fixture-evidence.js';
import { verifyBackupCaptureFixtureEvidence } from './backup-capture-fixture-evidence.js';
import {
  mailArtifactFixtureCertificate,
  readMailArtifactFixtureText,
  readMailDraftArtifactFixtureText,
  readMailCredentialFixtureText,
  readMailRecoveryFixtureText,
  verifyMailReleaseEvidence,
  verifyMailDraftReleaseEvidence,
} from './mail-artifact-fixture-evidence.js';

export const BUILD_TARGETS = ['host', 'agent-standard', 'agent-documents'] as const;
type BuildTarget = (typeof BUILD_TARGETS)[number];
type Plan = Omit<ReleaseManifest, 'checks'> & {
  checks: ReleaseManifest['checks'];
  targetDigest: string;
  builder?: string;
  context?: string;
};
export function releaseCheckImageIds(
  images: ReadonlyArray<Pick<ReleaseManifest['images'][number], 'role' | 'id'>>,
  name: string,
): string[] {
  const hostOnly =
      name.startsWith('vault_') ||
      name.startsWith('backup_') ||
      (name.startsWith('mail_') && name !== 'mail_evidence') ||
      (name.startsWith('draft_') && name !== 'draft_transport'),
    allImages =
      name.includes('image') || name === 'protected_state' || name === 'mail_evidence' || name === 'draft_transport';
  if (!hostOnly && !allImages) return [];
  if (
    images.length !== BUILD_TARGETS.length ||
    new Set(images.map((image) => image.id)).size !== BUILD_TARGETS.length ||
    images.some((image) => !/^sha256:[a-f0-9]{64}$/.test(image.id)) ||
    images.filter((image) => image.role === 'host').length !== 1 ||
    images.filter((image) => image.role === 'agent').length !== 2
  )
    throw Error('image_identity_required');
  return (hostOnly ? images.filter((image) => image.role === 'host') : images).map((image) => image.id);
}
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
  if (plan.slice !== readReleaseExecution(path.resolve('.cos-plan-state'), plan.slice).active_slice)
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
    // Only the current implemented slice may create a new release; historical manifests remain readable.
    if (!['S11', 'G01', 'G02', 'G03', 'G04', 'G05'].includes(slice) || Number(SCHEMA_VERSION) !== MIGRATIONS.length)
      throw new Error('current_release_slice_required');
    if (!/^[a-f0-9]{40}$/.test(commit) || !/^refs\/heads\/[a-zA-Z0-9_./-]+$/.test(fetchRef) || fetchRef.includes('..'))
      throw new Error('invalid_candidate_source');
    const root = releaseRoot(id);
    if (fs.existsSync(path.join(root, 'plan.json'))) throw new Error('release_already_exists');
    const target = deploymentSettings(readPrivate(path.resolve('.cos-plan-state/deployment-target.json')));
    const selectedSlice = slice as ReleaseManifest['slice'];
    if (readReleaseExecution(path.resolve('.cos-plan-state'), selectedSlice, true).active_slice !== slice)
      throw new Error('active_slice_required');
    const metadata = await prepareBuildContext(process.cwd(), commit, path.join(root, 'context'));
    const plan: Plan = {
      contract: 'cos-release/v1',
      releaseId: id,
      slice: selectedSlice,
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
      ...(['G02', 'G03', 'G04', 'G05'].includes(slice)
        ? {
            backupArtifact: packageResticReleaseArtifact({
              binary: path.resolve('.cos-plan-state/g02-restic-0.19.1/restic'),
              output: path.join(root, 'backup-artifact-input'),
            }),
          }
        : {}),
    };
    writeAtomic(root, 'plan.json', plan);
    checkedPlan(id);
    checkpointReleaseExecution(path.resolve('.cos-plan-state'), plan.slice, {
      head_sha: commit,
      release_build_id: id,
      release_status: 'local_checks_pending',
    });
    fs.mkdirSync(testRoot(id), { recursive: true, mode: 0o700 });
    return;
  }
  if (operation === 'timing') {
    const root = releaseRoot(id);
    // A completed bundle can continue delivery after HEAD advances. Timing grants no gate credit.
    const manifestFile = path.join(root, 'release.json');
    const plan = fs.lstatSync(manifestFile, { throwIfNoEntry: false })
      ? validateReleaseManifest(readPrivate(manifestFile))
      : checkedPlan(id).plan;
    if (plan.releaseId !== id) throw Error('stage_timing_unverified');
    const identity = {
      releaseId: plan.releaseId,
      sourceCommit: plan.source.commit,
      sourceTree: plan.source.tree,
      buildInputDigest: plan.buildInputDigest,
    };
    if (values.length === 3 && values[0] === 'start') {
      const spanId = randomUUID();
      writeAtomic(
        root,
        'stage-timings.json',
        beginStageTiming(readStageTimings(root), identity, {
          id: spanId,
          stage: values[1],
          evidence: values[2],
          at: new Date().toISOString(),
        }),
      );
      return spanId;
    }
    if (values.length === 3 && values[0] === 'end' && /^[0-9]{1,3}$/.test(values[2])) {
      const previous = readStageTimings(root);
      if (!previous) throw Error('stage_timing_unverified');
      writeAtomic(
        root,
        'stage-timings.json',
        finishStageTiming(previous, identity, values[1], new Date().toISOString(), Number(values[2])),
      );
      return;
    }
    throw Error('invalid_stage_timing_arguments');
  }
  const { root, plan } = checkedPlan(id);
  if (operation === 'backup-input' && !values.length) {
    if (!['G02', 'G03', 'G04', 'G05'].includes(plan.slice)) throw Error('backup_release_required');
    validateResticArtifactSeal(plan.backupArtifact);
    verifyResticReleaseArtifactInput(path.join(root, 'backup-artifact-input'));
    return;
  }
  if (operation === 'backup-job-fixture' && !values.length) {
    if (!['G02', 'G03', 'G04', 'G05'].includes(plan.slice)) throw Error('backup_release_required');
    const [hostImage] = releaseCheckImageIds(plan.images, 'backup_units');
    const image = verifyBackupJobFixtureImage(
      readPrivate(path.join(root, 'backup-jobs-fixture-inspect.json')),
      plan.source.commit,
      plan.source.tree,
      hostImage,
    );
    writeAtomic(root, 'backup-jobs-fixture.json', { image, hostImage, source: plan.source, releaseSlice: plan.slice });
    return image;
  }
  if (operation === 'backup-smb-fixture' && !values.length) {
    if (!['G02', 'G03', 'G04', 'G05'].includes(plan.slice)) throw Error('backup_release_required');
    const [hostImage] = releaseCheckImageIds(plan.images, 'backup_mount');
    const images = verifyBackupSmbFixtureImages(
      readPrivate(path.join(root, 'backup-smb-server-inspect.json')),
      readPrivate(path.join(root, 'backup-smb-client-inspect.json')),
      plan.source.commit,
      plan.source.tree,
      hostImage,
    );
    writeAtomic(root, 'backup-smb-fixture.json', { ...images, hostImage, source: plan.source });
    return images.clientImage;
  }
  if (operation === 'vault-fixture' && !values.length) {
    if (!['G01', 'G02', 'G03', 'G04', 'G05'].includes(plan.slice) || !plan.vaultArtifact)
      throw Error('vault_release_required');
    const host = plan.images.find((image) => image.role === 'host');
    if (!host) throw Error('image_identity_required');
    const image = verifyVaultFixtureImage(
      readPrivate(path.join(root, 'vault-fixture-inspect.json')),
      plan.source.commit,
      host.id,
    );
    writeAtomic(root, 'vault-fixture.json', {
      image,
      hostImage: host.id,
      source: plan.source,
      artifactDigest: plan.vaultArtifact.digest,
    });
    return image;
  }
  if (operation === 'vault-wire' && !values.length) {
    if (!['G01', 'G02', 'G03', 'G04', 'G05'].includes(plan.slice)) throw Error('vault_release_required');
    const file = path.join(root, 'vault_kernel.log'),
      stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 262144
    )
      throw Error('vault_wire_evidence_unavailable');
    const records = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));
    const fixture = readPrivate<{ image: string }>(path.join(root, 'vault-fixture.json'), 1024);
    verifyVaultWireEvidence(records, plan.source.commit, fixture.image);
    return;
  }
  if (operation === 'vault-artifact' && !values.length) {
    if (!['G01', 'G02', 'G03', 'G04', 'G05'].includes(plan.slice)) throw Error('vault_release_required');
    const seal = vaultRootArtifactSeal(readPrivate(path.join(root, 'vault-artifact.json'), 4096));
    if (
      seal.sourceCommit !== plan.source.commit ||
      seal.sourceTree !== plan.source.tree ||
      seal.runtime.version !== '22.23.2'
    )
      throw Error('vault_artifact_source_mismatch');
    plan.vaultArtifact = { digest: digest(seal), seal };
    writeAtomic(root, 'plan.json', plan);
    return;
  }
  if (operation === 'target' && !values.length) {
    const settings = deploymentSettings(readPrivate(path.resolve('.cos-plan-state/deployment-target.json')));
    const state = validateBuildTargetObservation(settings, readPrivate(path.join(root, 'target-observation.json')));
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
    if (['G02', 'G03', 'G04', 'G05'].includes(plan.slice)) {
      validateResticArtifactSeal(plan.backupArtifact);
      verifyResticReleaseArtifactInput(path.join(root, 'backup-artifact-input'));
    }
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
          ...(['G02', 'G03', 'G04', 'G05'].includes(plan.slice)
            ? { COS_BACKUP_FIXTURE_BINARY: path.join(root, 'backup-artifact-input/restic') }
            : {}),
        },
        stdio: 'inherit',
        timeout: ['G02', 'G03', 'G04', 'G05'].includes(plan.slice)
          ? 1260000
          : ['S10', 'S11', 'G01'].includes(plan.slice)
            ? 960000
            : ['S06', 'S07', 'S08', 'S09'].includes(plan.slice)
              ? 660000
              : 180000,
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
    if (!requiredReleaseChecks(plan.slice).includes(name) || !['0', '1'].includes(status))
      throw new Error('invalid_check_result');
    const imageIds = releaseCheckImageIds(plan.images, name);
    if (['mail_credentials', 'mail_recovery'].includes(name) && status === '0') {
      const fixture = readPrivate<{
        image: string;
        hostImage: string;
        source: ReleaseManifest['source'];
        artifactDigest: string;
      }>(path.join(root, 'vault-fixture.json'));
      if (
        !plan.vaultArtifact ||
        fixture.artifactDigest !== plan.vaultArtifact.digest ||
        fixture.hostImage !== imageIds[0] ||
        digest(fixture.source) !== digest(plan.source)
      )
        throw Error('vault_fixture_identity_mismatch');
      const text =
        name === 'mail_credentials'
          ? readMailCredentialFixtureText(path.join(root, 'mail_credentials.log'))
          : readMailRecoveryFixtureText(path.join(root, 'mail_recovery.log'));
      const proof = verifyMailReleaseEvidence(name, text, {
        sourceCommit: plan.source.commit,
        sourceTree: plan.source.tree,
        hostImage: imageIds[0],
        fixtureImage: fixture.image,
        fixtureInspection: readPrivate(path.join(root, 'vault-fixture-inspect.json'), 1024 ** 2),
      });
      writeAtomic(root, name === 'mail_credentials' ? 'mail-credential-evidence.json' : 'mail-recovery-evidence.json', {
        ...proof,
        at: new Date().toISOString(),
        source: plan.source,
        hostImage: imageIds[0],
        fixtureImage: fixture.image,
        artifactDigest: fixture.artifactDigest,
        reportDigest: digest(text),
      });
    }
    const draftArtifact = ['draft_policy', 'draft_transport', 'draft_reconciliation'].includes(name);
    if (
      ((name.startsWith('mail_') && !['mail_credentials', 'mail_recovery'].includes(name)) || draftArtifact) &&
      status === '0'
    ) {
      // All three artifact checks share the same actual database/two-worker run.
      // The Mac CA path comes from the observed devcontainer mount registration.
      if (draftArtifact && plan.slice !== 'G05') throw Error('draft_release_required');
      const text = draftArtifact
          ? readMailDraftArtifactFixtureText(path.join(root, 'draft_artifacts.log'))
          : readMailArtifactFixtureText(path.join(root, 'mail_artifacts.log')),
        identity = {
          sourceCommit: plan.source.commit,
          sourceTree: plan.source.tree,
          workerAssetsDigest: plan.workerAssetsDigest,
          hostImage: plan.images.find((image) => image.role === 'host')!.id,
          workerImages: plan.images.filter((image) => image.role === 'agent').map((image) => image.id),
          certificateFile: mailArtifactFixtureCertificate(
            readPrivate(path.join(root, 'devcontainer.json'), 1024 ** 2),
            id,
          ),
        },
        proof = draftArtifact
          ? verifyMailDraftReleaseEvidence(name, text, identity)
          : verifyMailReleaseEvidence(name, text, identity);
      writeAtomic(root, draftArtifact ? 'draft-artifact-evidence.json' : 'mail-artifact-evidence.json', {
        ...proof,
        at: new Date().toISOString(),
        source: plan.source,
        hostImage: identity.hostImage,
        workerImages: identity.workerImages,
        workerAssetsDigest: identity.workerAssetsDigest,
        reportDigest: digest(text),
        gates: draftArtifact
          ? ['draft_policy', 'draft_transport', 'draft_reconciliation']
          : ['mail_capture', 'mail_evidence', 'mail_retention'],
      });
    }
    if (name === 'backup_capture' && status === '0') {
      const fixture = readPrivate<{ image: string; hostImage: string; source: ReleaseManifest['source'] }>(
        path.join(root, 'vault-fixture.json'),
      );
      if (fixture.hostImage !== imageIds[0] || digest(fixture.source) !== digest(plan.source))
        throw Error('vault_fixture_identity_mismatch');
      const file = path.join(root, 'backup_capture.log'),
        stat = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o7777) !== 0o600 ||
        stat.size > 512 * 1024
      )
        throw Error('backup_capture_release_evidence_unavailable');
      const records = fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      verifyBackupCaptureFixtureEvidence(records, {
        sourceCommit: plan.source.commit,
        sourceTree: plan.source.tree,
        hostImage: imageIds[0],
        fixtureImage: fixture.image,
      });
    }
    if (name === 'backup_credentials' && status === '0') {
      const fixture = readPrivate<{ image: string; hostImage: string; source: ReleaseManifest['source'] }>(
        path.join(root, 'vault-fixture.json'),
      );
      if (fixture.hostImage !== imageIds[0] || digest(fixture.source) !== digest(plan.source))
        throw Error('vault_fixture_identity_mismatch');
      const file = path.join(root, 'backup_credentials.log'),
        stat = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o7777) !== 0o600 ||
        stat.size > 512 * 1024
      )
        throw Error('backup_credential_release_evidence_unavailable');
      const records = fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      verifyBackupCredentialReleaseEvidence(records, {
        sourceCommit: plan.source.commit,
        sourceTree: plan.source.tree,
        hostImage: imageIds[0],
        fixtureImage: fixture.image,
      });
    }
    if (['backup_transfer', 'backup_retention', 'backup_recovery'].includes(name) && status === '0') {
      const file = path.join(root, name + '.log'),
        stat = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o7777) !== 0o600 ||
        stat.size > 1024 ** 2
      )
        throw Error('backup_repository_release_evidence_unavailable');
      verifyBackupRepositoryFixtureEvidence(fs.readFileSync(file, 'utf8'), {
        sourceCommit: plan.source.commit,
        sourceTree: plan.source.tree,
        hostImage: imageIds[0],
      });
    }
    if (name === 'backup_mount' && status === '0') {
      const fixture = readPrivate<{
        serverImage: string;
        clientImage: string;
        hostImage: string;
        source: ReleaseManifest['source'];
      }>(path.join(root, 'backup-smb-fixture.json'));
      if (fixture.hostImage !== imageIds[0] || digest(fixture.source) !== digest(plan.source))
        throw Error('backup_smb_fixture_identity_mismatch');
      const file = path.join(root, 'backup_mount.log'),
        stat = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o7777) !== 0o600 ||
        stat.size > 262144
      )
        throw Error('backup_smb_fixture_evidence_unavailable');
      const records = fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      verifyBackupSmbFixtureEvidence(records, {
        sourceCommit: plan.source.commit,
        sourceTree: plan.source.tree,
        hostImage: imageIds[0],
        serverImage: fixture.serverImage,
        clientImage: fixture.clientImage,
      });
    }
    if (name === 'backup_units' && status === '0') {
      const fixture = readPrivate<{
        image: string;
        hostImage: string;
        source: ReleaseManifest['source'];
        releaseSlice: string;
      }>(path.join(root, 'backup-jobs-fixture.json'));
      if (
        fixture.hostImage !== imageIds[0] ||
        digest(fixture.source) !== digest(plan.source) ||
        fixture.releaseSlice !== plan.slice
      )
        throw Error('backup_job_fixture_identity_mismatch');
      const file = path.join(root, 'backup_units.log'),
        stat = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o7777) !== 0o600 ||
        stat.size > 262144
      )
        throw Error('backup_job_fixture_evidence_unavailable');
      const records = fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      verifyBackupJobFixtureEvidence(records, {
        sourceCommit: plan.source.commit,
        sourceTree: plan.source.tree,
        hostImage: imageIds[0],
        fixtureImage: fixture.image,
        releaseSlice: plan.slice as 'G02' | 'G03' | 'G04' | 'G05',
      });
    }
    plan.checks[name] = {
      status: status === '0' ? 'passed' : 'failed',
      at: new Date().toISOString(),
      sourceCommit: plan.source.commit,
      imageIds,
    };
    writeAtomic(root, 'plan.json', plan);
    checkpointReleaseExecution(path.resolve('.cos-plan-state'), plan.slice, { release_local_checks: plan.checks });
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
    checkpointReleaseExecution(path.resolve('.cos-plan-state'), plan.slice, {
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
