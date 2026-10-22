import path from 'node:path';
import fs from 'node:fs';
import { verifyMailFixtureReport } from '../../../contracts/chief-of-staff/mail-fixture-report.js';
import { verifyMailDraftFixtureReport } from '../../../contracts/chief-of-staff/mail-draft-fixture-report.js';
import { verifyMailVaultFixtureEvidence, verifyMailDraftVaultFixtureEvidence } from './mail-vault-fixture-evidence.js';
import {
  verifyMailRecoveryFixtureEvidence,
  verifyMailDraftRecoveryFixtureEvidence,
} from './mail-recovery-fixture-evidence.js';
import { verifyVaultFixtureImage } from './vault-fixture-evidence.js';
type Identity = {
  sourceCommit: string;
  sourceTree: string;
  workerAssetsDigest: string;
  hostImage: string;
  workerImages: string[];
  certificateFile: string;
};
type RecordValue = Record<string, unknown>;
export function readMailArtifactFixtureText(file: string): string {
  return readMailFixtureText(file, 'mail_artifacts.log');
}
export function readMailDraftArtifactFixtureText(file: string): string {
  return readMailFixtureText(file, 'draft_artifacts.log');
}
export function readMailCredentialFixtureText(file: string): string {
  return readMailFixtureText(file, 'mail_credentials.log');
}
export function readMailRecoveryFixtureText(file: string): string {
  return readMailFixtureText(file, 'mail_recovery.log');
}
export function readMailDraftCredentialFixtureText(file: string): string {
  return readMailFixtureText(file, 'draft_credentials.log');
}
export function readMailDraftRecoveryFixtureText(file: string): string {
  return readMailFixtureText(file, 'draft_recovery.log');
}
function readMailFixtureText(
  file: string,
  expectedName:
    | 'mail_artifacts.log'
    | 'mail_credentials.log'
    | 'mail_recovery.log'
    | 'draft_artifacts.log'
    | 'draft_credentials.log'
    | 'draft_recovery.log',
): string {
  let fd: number | undefined, bytes: Buffer | undefined;
  try {
    if (
      typeof file !== 'string' ||
      !path.isAbsolute(file) ||
      path.resolve(file) !== file ||
      path.basename(file) !== expectedName ||
      fs.realpathSync(path.dirname(file)) !== path.dirname(file)
    )
      throw Error('report_path');
    const parent = fs.statSync(path.dirname(file));
    if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o7777) !== 0o700)
      throw Error('report_parent');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const initial = fs.fstatSync(fd),
      identity = (s: fs.Stats) => [s.dev, s.ino, s.uid, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(':');
    if (
      !initial.isFile() ||
      initial.dev !== parent.dev ||
      initial.uid !== parent.uid ||
      initial.nlink !== 1 ||
      (initial.mode & 0o7777) !== 0o600 ||
      initial.size < 1 ||
      initial.size > 2 * 1024 ** 2 ||
      identity(fs.lstatSync(file)) !== identity(initial)
    )
      throw Error('report_file');
    bytes = Buffer.alloc(initial.size + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (
      count !== initial.size ||
      identity(fs.fstatSync(fd)) !== identity(initial) ||
      identity(fs.lstatSync(file)) !== identity(initial)
    )
      throw Error('report_changed');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private fixture paths and raw nested diagnostics never become release authority.
    throw Error('mail_artifact_release_evidence_unavailable');
  } finally {
    bytes?.fill(0);
    if (fd !== undefined) fs.closeSync(fd);
  }
}
export function mailArtifactFixtureCertificate(inspection: unknown, releaseId: string): string {
  try {
    if (!Array.isArray(inspection) || inspection.length !== 1 || !/^release-[a-f0-9]{12}-[0-9]{14}$/.test(releaseId))
      throw Error('inspection');
    const mounts = objects(object(inspection[0]).Mounts),
      root = one(mounts, 'Destination', '/workspace');
    if (
      root.Type !== 'bind' ||
      root.RW !== true ||
      typeof root.Source !== 'string' ||
      !/^\/[a-zA-Z0-9_./-]+$/.test(root.Source) ||
      root.Source === '/' ||
      path.resolve(root.Source) !== root.Source
    )
      throw Error('workspace');
    // Docker Desktop registers this Mac bind with its fixed VM prefix, while
    // a new CA bind is reported using the original Mac path. Translate only
    // the observed Users mapping; never treat an unknown VM path as a Mac root.
    const source = root.Source.startsWith('/host_mnt/Users/') ? root.Source.slice('/host_mnt'.length) : root.Source;
    if (source === '/host_mnt' || source.startsWith('/host_mnt/')) throw Error('workspace_mapping');
    return path.join(source, '.cos-plan-state/release-tests', releaseId, 'ca.pem');
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Inspection may contain unrelated private configuration; return only a fixed mapping failure.
    throw Error('mail_fixture_workspace_unverified');
  }
}
type KernelIdentity = Pick<Identity, 'sourceCommit' | 'sourceTree' | 'hostImage'> & {
  fixtureImage: string;
  fixtureInspection: unknown;
};
/** Each gate requires its own actual execution. A database report never stands
 * in for encrypted credential proof; complete recovery remains a separate gate. */
export function verifyMailReleaseEvidence(gate: string, text: string, identity: Identity | KernelIdentity) {
  if (gate === 'mail_credentials' || gate === 'mail_recovery') {
    if (!('fixtureImage' in identity) || !('fixtureInspection' in identity))
      throw Error('mail_kernel_release_evidence_required');
    if (
      verifyVaultFixtureImage(identity.fixtureInspection, identity.sourceCommit, identity.hostImage) !==
      identity.fixtureImage
    )
      throw Error('vault_fixture_identity_mismatch');
    return gate === 'mail_credentials'
      ? verifyMailVaultFixtureEvidence(text, identity)
      : verifyMailRecoveryFixtureEvidence(text, identity);
  }
  if (!['mail_capture', 'mail_evidence', 'mail_retention'].includes(gate) || !('workerImages' in identity))
    throw Error('mail_release_check_unavailable');
  return verifyMailArtifactFixtureEvidence(text, identity);
}
export function verifyMailDraftReleaseEvidence(gate: string, text: string, identity: Identity | KernelIdentity) {
  if (gate === 'draft_credentials' || gate === 'draft_recovery') {
    if (!('fixtureImage' in identity) || !('fixtureInspection' in identity))
      throw Error('mail_draft_kernel_release_evidence_required');
    if (
      verifyVaultFixtureImage(identity.fixtureInspection, identity.sourceCommit, identity.hostImage) !==
      identity.fixtureImage
    )
      throw Error('vault_fixture_identity_mismatch');
    return gate === 'draft_credentials'
      ? verifyMailDraftVaultFixtureEvidence(text, identity)
      : verifyMailDraftRecoveryFixtureEvidence(text, identity);
  }
  if (!['draft_policy', 'draft_transport', 'draft_reconciliation'].includes(gate) || !('workerImages' in identity))
    throw Error('mail_draft_release_check_unavailable');
  return verifyMailDraftArtifactFixtureEvidence(text, identity);
}
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('object');
  return value as RecordValue;
}
function keys(value: RecordValue, expected: string): void {
  if (Object.keys(value).sort().join(',') !== expected.split(',').sort().join(',')) throw Error('shape');
}
function objects(value: unknown): RecordValue[] {
  if (!Array.isArray(value)) throw Error('array');
  return value.map(object);
}
const empty = (value: unknown) => value == null || (Array.isArray(value) && value.length === 0);
const sameArray = (value: unknown, expected: unknown[]) => JSON.stringify(value) === JSON.stringify(expected);
function one(items: RecordValue[], field: string, value: string): RecordValue {
  const matches = items.filter((item) => item[field] === value);
  if (matches.length !== 1) throw Error('mount');
  return matches[0];
}
/** Independently observed Docker configuration, not a process's assertion of
 * its own privileges. Only the private synthetic volume, selected CA and native
 * fixture Docker socket are admitted. No source/dependency overrides exist. */
function scope(
  value: RecordValue,
  identity: Identity,
  volume: string,
  root: string,
  native: boolean,
  contract: string,
): void {
  keys(value, 'contract,image,user,workingDirectory,host,mounts');
  if (
    value.contract !== contract + '-container-scope/v1' ||
    value.image !== identity.hostImage ||
    value.user !== '1000:1000' ||
    value.workingDirectory !== '/release'
  )
    throw Error('scope');
  const h = object(value.host);
  if (
    h.NetworkMode !== 'bridge' ||
    h.Privileged !== false ||
    h.ReadonlyRootfs !== true ||
    !sameArray(h.CapDrop, ['ALL']) ||
    !sameArray(h.SecurityOpt, ['no-new-privileges']) ||
    [h.CapAdd, h.Binds, h.Devices, h.DeviceRequests, h.DeviceCgroupRules, h.Links, h.VolumesFrom].some(
      (v) => !empty(v),
    ) ||
    Object.keys(object(h.PortBindings)).length ||
    h.PublishAllPorts !== false ||
    h.Memory !== 1024 ** 3 ||
    h.MemorySwap !== h.Memory ||
    h.PidsLimit !== 256 ||
    (native ? !sameArray(h.GroupAdd, ['0']) : !empty(h.GroupAdd)) ||
    h.IpcMode !== 'private' ||
    h.PidMode !== '' ||
    h.UTSMode !== '' ||
    h.UsernsMode !== '' ||
    h.CgroupnsMode !== 'private'
  )
    throw Error('scope');
  const restart = object(h.RestartPolicy),
    tmpfs = object(h.Tmpfs),
    limits = objects(h.Ulimits);
  if (
    restart.Name !== 'no' ||
    restart.MaximumRetryCount !== 0 ||
    Object.keys(tmpfs).join(',') !== '/tmp' ||
    tmpfs['/tmp'] !== 'rw,nosuid,nodev,noexec,size=128m,mode=700,uid=1000,gid=1000' ||
    limits.length !== 1 ||
    limits[0].Name !== 'core' ||
    limits[0].Soft !== 0 ||
    limits[0].Hard !== 0
  )
    throw Error('protection');
  const declared = objects(h.Mounts),
    actual = objects(value.mounts),
    count = native ? 3 : 2;
  if (
    declared.length !== count ||
    actual.length !== count ||
    new Set(declared.map((item) => item.Target)).size !== count ||
    new Set(actual.map((item) => item.Destination)).size !== count
  )
    throw Error('mount_inventory');
  const certificate = one(declared, 'Target', '/fixture/ca.pem'),
    certificateActual = one(actual, 'Destination', '/fixture/ca.pem');
  keys(certificate, 'Type,Source,Target,ReadOnly');
  if (
    certificate.Type !== 'bind' ||
    certificate.Source !== identity.certificateFile ||
    certificate.ReadOnly !== true ||
    certificateActual.Type !== 'bind' ||
    certificateActual.Source !== identity.certificateFile ||
    certificateActual.RW !== false ||
    certificateActual.Propagation !== 'rprivate'
  )
    throw Error('certificate');
  const staging = one(declared, 'Target', '/release/.cos-plan-state'),
    stagingActual = one(actual, 'Destination', '/release/.cos-plan-state');
  keys(staging, 'Type,Source,Target,VolumeOptions');
  const options = object(staging.VolumeOptions);
  keys(options, 'Subpath,DriverConfig');
  if (
    staging.Type !== 'volume' ||
    staging.Source !== volume ||
    options.Subpath !== '.cos-plan-state' ||
    Object.keys(object(options.DriverConfig)).length ||
    stagingActual.Type !== 'volume' ||
    stagingActual.Name !== volume ||
    stagingActual.Source !== root ||
    stagingActual.Driver !== 'local' ||
    stagingActual.RW !== true ||
    stagingActual.Propagation !== ''
  )
    throw Error('staging');
  if (native) {
    const socket = one(declared, 'Target', '/var/run/docker.sock'),
      socketActual = one(actual, 'Destination', '/var/run/docker.sock');
    keys(socket, 'Type,Source,Target');
    // Docker Desktop rewrites the exact requested daemon socket to its fixed proxy.
    if (
      socket.Type !== 'bind' ||
      !['/var/run/docker.sock', '/run/host-services/docker.proxy.sock'].includes(String(socket.Source)) ||
      socketActual.Type !== 'bind' ||
      socketActual.Source !== socket.Source ||
      socketActual.RW !== true ||
      socketActual.Propagation !== 'rprivate'
    )
      throw Error('fixture_socket');
  }
}
/** Complete sealed database and two-worker fixture execution only. Actual
 * encrypted profile/kernel proof and installed/live acceptance are separate.
 * A bare exit code, source report or synthetic unit receipt cannot supply this. */
export function verifyMailArtifactFixtureEvidence(text: string, identity: Identity) {
  return verifyBoundMailArtifactEvidence(text, identity, 'G04');
}
export function verifyMailDraftArtifactFixtureEvidence(text: string, identity: Identity) {
  try {
    return verifyBoundMailArtifactEvidence(text, identity, 'G05');
  } catch {
    // eslint-disable-next-line preserve-caught-error -- G05 cannot substitute a reader-only receipt or disclose nested private evidence diagnostics.
    throw Error('mail_draft_artifact_release_evidence_unavailable');
  }
}
function verifyBoundMailArtifactEvidence(text: string, identity: Identity, profile: 'G04' | 'G05') {
  try {
    const contract = profile === 'G05' ? 'cos-g05-draft' : 'cos-g04-mail';
    if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 ** 2) throw Error('bounds');
    keys(object(identity), 'sourceCommit,sourceTree,workerAssetsDigest,hostImage,workerImages,certificateFile');
    if (
      !/^[a-f0-9]{40}$/.test(identity.sourceCommit) ||
      !/^[a-f0-9]{40}$/.test(identity.sourceTree) ||
      !/^[a-f0-9]{64}$/.test(identity.workerAssetsDigest) ||
      !/^sha256:[a-f0-9]{64}$/.test(identity.hostImage) ||
      !Array.isArray(identity.workerImages) ||
      identity.workerImages.length !== 2 ||
      identity.workerImages.some((image) => !/^sha256:[a-f0-9]{64}$/.test(image)) ||
      new Set([identity.hostImage, ...identity.workerImages]).size !== 3 ||
      typeof identity.certificateFile !== 'string' ||
      !/^\/[a-zA-Z0-9_./-]+\/ca\.pem$/.test(identity.certificateFile) ||
      path.resolve(identity.certificateFile) !== identity.certificateFile
    )
      throw Error('identity');
    const lines = text.trim().split(/\r?\n/),
      header = object(JSON.parse(lines.shift()!));
    keys(
      header,
      'contract,sourceCommit,sourceTree,workerAssetsDigest,hostImage,workerImages,fixtureVolume,fixtureRoot',
    );
    const volume = String(header.fixtureVolume),
      root = String(header.fixtureRoot);
    if (
      header.contract !== contract + '-artifact-set/v1' ||
      header.sourceCommit !== identity.sourceCommit ||
      header.sourceTree !== identity.sourceTree ||
      header.workerAssetsDigest !== identity.workerAssetsDigest ||
      header.hostImage !== identity.hostImage ||
      !sameArray(header.workerImages, identity.workerImages) ||
      !new RegExp(
        '^' +
          contract +
          '-' +
          identity.sourceCommit.slice(0, 8) +
          '-[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$',
      ).test(volume) ||
      root !== '/var/lib/docker/volumes/' + volume + '/_data'
    )
      throw Error('set');
    let actualDatabaseCases = 0;
    for (const worker of [null, ...identity.workerImages]) {
      const native = worker !== null,
        suite = native ? 'native' : 'database';
      scope(object(JSON.parse(lines.shift()!)), identity, volume, root, native, contract);
      const binding = object(JSON.parse(lines.shift()!));
      keys(
        binding,
        'contract,suite,hostImage,workerImage,sourceCommit,sourceTree,workerAssetsDigest,actualRuntime,actualNativeSqlite,actualMemoryProtection,compiledProductionPayload,databaseProfile,databaseTls,sourceOverrides,workerSourceOverrides,ownerCredentialsUsed,liveAccountAcceptance,installedAcceptance,storageAdmission',
      );
      if (
        binding.contract !== contract + '-host-run/v1' ||
        binding.suite !== suite ||
        binding.hostImage !== identity.hostImage ||
        binding.workerImage !== worker ||
        binding.sourceCommit !== identity.sourceCommit ||
        binding.sourceTree !== identity.sourceTree ||
        binding.workerAssetsDigest !== identity.workerAssetsDigest ||
        ['actualRuntime', 'actualNativeSqlite', 'actualMemoryProtection', 'compiledProductionPayload'].some(
          (key) => binding[key] !== true,
        ) ||
        [
          'sourceOverrides',
          'workerSourceOverrides',
          'ownerCredentialsUsed',
          'liveAccountAcceptance',
          'installedAcceptance',
        ].some((key) => binding[key] !== false) ||
        binding.databaseProfile !== 'test' ||
        binding.databaseTls !== 'verify-full' ||
        binding.storageAdmission !== 'fixture'
      )
        throw Error('binding');
      const next = lines.findIndex((line) => line.startsWith('{')),
        end = next < 0 ? lines.length : next,
        report = lines.splice(0, end).join('\n');
      const verified =
        profile === 'G05' ? verifyMailDraftFixtureReport(report, suite) : verifyMailFixtureReport(report, suite);
      if (suite === 'database') actualDatabaseCases = verified.actualCases;
    }
    if (lines.some((line) => line.trim())) throw Error('extra');
    return Object.freeze({
      status: 'passed' as const,
      actualDatabaseCases,
      actualNativeRuns: 2,
      sourceOverrides: false as const,
      installedAcceptance: false as const,
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private image, selected database, CA and fixture-root diagnostics remain contained.
    throw Error('mail_artifact_release_evidence_unavailable');
  }
}
