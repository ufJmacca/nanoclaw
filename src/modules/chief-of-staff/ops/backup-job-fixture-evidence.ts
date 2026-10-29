import { validateResticArtifactSeal } from './restic-artifact.js';
type Identity = Readonly<{
  sourceCommit: string;
  sourceTree: string;
  hostImage: string;
  fixtureImage: string;
  releaseSlice: 'G02' | 'G03' | 'G04' | 'G05' | 'G06';
}>;
export function verifyBackupJobFixtureImage(
  value: unknown,
  sourceCommit: string,
  sourceTree: string,
  hostImage: string,
): string {
  const entries = value as Array<{
    Id: string;
    Os: string;
    Architecture: string;
    Config?: { Labels?: Record<string, string> };
  }>;
  const entry = Array.isArray(entries) && entries.length === 1 ? entries[0] : undefined;
  if (
    !/^[a-f0-9]{40}$/.test(sourceCommit) ||
    !/^[a-f0-9]{40}$/.test(sourceTree) ||
    !/^sha256:[a-f0-9]{64}$/.test(hostImage) ||
    !entry ||
    !/^sha256:[a-f0-9]{64}$/.test(entry.Id) ||
    entry.Id === hostImage ||
    entry.Os !== 'linux' ||
    entry.Architecture !== 'arm64' ||
    entry.Config?.Labels?.['org.opencontainers.image.revision'] !== sourceCommit ||
    entry.Config?.Labels?.['nanoclaw.source-tree'] !== sourceTree ||
    entry.Config?.Labels?.['nanoclaw.tested-host'] !== hostImage ||
    entry.Config?.Labels?.['nanoclaw.release-role'] !== 'backup-job-manager-fixture' ||
    entry.Config?.Labels?.['nanoclaw.final-artifact'] !== 'false'
  )
    throw Error('backup_job_fixture_identity_mismatch');
  return entry.Id;
}
/** The local gate checks real immutable code and manager effects. Installed
 * release authority, scheduled capture and remote upload remain Pi acceptance.
 * Its privileged manager has a private cgroup namespace and no host mounts.
 */
export function verifyBackupJobFixtureEvidence(records: unknown[], identity: Identity) {
  try {
    if (
      !Array.isArray(records) ||
      records.length !== 3 ||
      !identity ||
      Object.keys(identity).sort().join(',') !== 'fixtureImage,hostImage,releaseSlice,sourceCommit,sourceTree' ||
      !['G02', 'G03', 'G04', 'G05', 'G06'].includes(identity.releaseSlice) ||
      !/^[a-f0-9]{40}$/.test(identity.sourceCommit) ||
      !/^[a-f0-9]{40}$/.test(identity.sourceTree) ||
      !/^sha256:[a-f0-9]{64}$/.test(identity.hostImage) ||
      !/^sha256:[a-f0-9]{64}$/.test(identity.fixtureImage) ||
      identity.hostImage === identity.fixtureImage
    )
      throw Error('identity');
    if (records.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) throw Error('records');
    const [binding, scope, probe] = records as Record<string, unknown>[];
    if (
      Object.keys(binding).sort().join(',') !==
        'hostDataMounted,jobFixtureImage,ownerCredentialsUsed,privateCgroupNamespace,releaseSlice,sourceCommit,sourceTree,testedHost' ||
      binding.releaseSlice !== identity.releaseSlice ||
      binding.jobFixtureImage !== identity.fixtureImage ||
      binding.testedHost !== identity.hostImage ||
      binding.sourceCommit !== identity.sourceCommit ||
      binding.sourceTree !== identity.sourceTree ||
      binding.privateCgroupNamespace !== true ||
      binding.hostDataMounted !== false ||
      binding.ownerCredentialsUsed !== false
    )
      throw Error('binding');
    if (
      scope.Privileged !== true ||
      scope.NetworkMode !== 'none' ||
      scope.CgroupnsMode !== 'private' ||
      (scope.Binds !== null && (!Array.isArray(scope.Binds) || scope.Binds.length)) ||
      (scope.Mounts !== undefined && (!Array.isArray(scope.Mounts) || scope.Mounts.length)) ||
      !scope.PortBindings ||
      typeof scope.PortBindings !== 'object' ||
      Object.keys(scope.PortBindings).length ||
      scope.Memory !== 1024 ** 3 ||
      scope.MemorySwap !== scope.Memory ||
      scope.PidsLimit !== 256 ||
      !Array.isArray(scope.Ulimits) ||
      !scope.Ulimits.some((row) => row?.Name === 'core' && row.Soft === 0 && row.Hard === 0) ||
      !scope.Tmpfs ||
      typeof scope.Tmpfs !== 'object' ||
      Object.keys(scope.Tmpfs).sort().join(',') !== '/run,/tmp'
    )
      throw Error('scope');
    for (const options of Object.values(scope.Tmpfs))
      if (
        typeof options !== 'string' ||
        !options.split(',').includes('nosuid') ||
        !options.split(',').includes('nodev')
      )
        throw Error('ram_scope');
    const drafts = identity.releaseSlice === 'G05',
      reviews = identity.releaseSlice === 'G06',
      upgrade = drafts || reviews || identity.releaseSlice === 'G04';
    const required = [
      'actualUserManager',
      'actualStaticCompiler',
      'actualTimerActivation',
      'actualTimerStop',
      'idempotentFiles',
      'withdrawnScopeDenied',
      'compiledProductionInstallerAndAdapter',
      'actualScheduledEntryFailsClosed',
      'unrelatedUnitPreserved',
      'syntheticReleaseAuthority',
    ];
    const keys = [
      ...required,
      'contract',
      'status',
      'cases',
      'sealedSourceCommit',
      'sealedSourceTree',
      'backupArtifact',
      'actualEnablementLinks',
      'installedOwnerCommandAcceptance',
      'actualScheduledCapture',
      'actualRemoteUpload',
      'ownerCredentialsUsed',
      'finalArtifact',
      'proofs',
      'releaseSlice',
      'schemaVersion',
      'actualG03ToG04Upgrade',
      ...(drafts ? ['actualG04ToG05Upgrade'] : []),
      ...(reviews ? ['actualG05ToG06Upgrade'] : []),
    ];
    if (
      Object.keys(probe).sort().join(',') !== keys.sort().join(',') ||
      probe.contract !==
        (reviews
          ? 'cos-backup-job-release-fixture/v4'
          : drafts
            ? 'cos-backup-job-release-fixture/v3'
            : 'cos-backup-job-release-fixture/v2') ||
      probe.status !== 'passed' ||
      probe.releaseSlice !== identity.releaseSlice ||
      probe.schemaVersion !== (reviews ? 21 : drafts ? 20 : identity.releaseSlice === 'G04' ? 19 : 18) ||
      probe.actualG03ToG04Upgrade !== (identity.releaseSlice === 'G04') ||
      (drafts && probe.actualG04ToG05Upgrade !== true) ||
      (reviews && probe.actualG05ToG06Upgrade !== true) ||
      probe.cases !== (upgrade ? 8 : 7) ||
      probe.actualEnablementLinks !== 2 ||
      required.some((key) => probe[key] !== true) ||
      probe.sealedSourceCommit !== identity.sourceCommit ||
      probe.sealedSourceTree !== identity.sourceTree ||
      [
        'installedOwnerCommandAcceptance',
        'actualScheduledCapture',
        'actualRemoteUpload',
        'ownerCredentialsUsed',
        'finalArtifact',
      ].some((key) => probe[key] !== false) ||
      !Number.isSafeInteger(probe.proofs) ||
      Number(probe.proofs) < 25 ||
      Number(probe.proofs) > 1000
    )
      throw Error('coverage');
    validateResticArtifactSeal(probe.backupArtifact);
    return Object.freeze({
      status: 'passed' as const,
      cases: upgrade ? 8 : 7,
      scope: 'immutable_host_local_user_manager' as const,
      installedAcceptance: false as const,
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Only the fixed evidence error is public; private fixture output is not.
    throw Error('backup_job_fixture_evidence_unavailable');
  }
}
