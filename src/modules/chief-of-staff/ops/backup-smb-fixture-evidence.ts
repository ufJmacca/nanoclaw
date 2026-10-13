type Identity = Readonly<{
  sourceCommit: string;
  sourceTree: string;
  hostImage: string;
  serverImage: string;
  clientImage: string;
}>;
const immutable = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join(',') === keys.sort().join(',');
export function verifyBackupSmbFixtureImages(
  server: unknown,
  client: unknown,
  sourceCommit: string,
  sourceTree: string,
  hostImage: string,
) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || !/^[a-f0-9]{40}$/.test(sourceTree) || !immutable(hostImage))
    throw Error('backup_smb_fixture_identity_mismatch');
  const image = (value: unknown, role: 'server' | 'client') => {
    const entries = value as Array<{
      Id: string;
      Os: string;
      Architecture: string;
      Config?: { Labels?: Record<string, string> };
    }>;
    const entry = Array.isArray(entries) && entries.length === 1 ? entries[0] : undefined;
    const labels = entry?.Config?.Labels;
    if (
      !entry ||
      !immutable(entry.Id) ||
      entry.Id === hostImage ||
      entry.Os !== 'linux' ||
      entry.Architecture !== 'arm64' ||
      labels?.['org.opencontainers.image.revision'] !== sourceCommit ||
      labels?.['nanoclaw.source-tree'] !== sourceTree ||
      labels?.['nanoclaw.release-role'] !== 'backup-smb-' + role + '-fixture' ||
      labels?.['nanoclaw.final-artifact'] !== 'false' ||
      (role === 'client' && labels?.['nanoclaw.tested-host'] !== hostImage)
    )
      throw Error('backup_smb_fixture_identity_mismatch');
    return entry.Id;
  };
  const serverImage = image(server, 'server'),
    clientImage = image(client, 'client');
  if (serverImage === clientImage) throw Error('backup_smb_fixture_identity_mismatch');
  return Object.freeze({ serverImage, clientImage });
}
/** The local gate exercises real kernel SMB and encrypted transport. Live NAS
 * account, vault handoff, capacity and complete capture require installed checks.
 */
export function verifyBackupSmbFixtureEvidence(records: unknown[], identity: Identity) {
  try {
    if (
      !Array.isArray(records) ||
      records.length !== 4 ||
      !identity ||
      !exact(identity, ['sourceCommit', 'sourceTree', 'hostImage', 'serverImage', 'clientImage']) ||
      !/^[a-f0-9]{40}$/.test(identity.sourceCommit) ||
      !/^[a-f0-9]{40}$/.test(identity.sourceTree) ||
      ![identity.hostImage, identity.serverImage, identity.clientImage].every(immutable) ||
      new Set([identity.hostImage, identity.serverImage, identity.clientImage]).size !== 3 ||
      records.some((row) => !row || typeof row !== 'object' || Array.isArray(row))
    )
      throw Error('identity');
    const [binding, scope, probe, ciphertext] = records as Record<string, unknown>[];
    if (
      !exact(binding, [
        'serverImage',
        'clientImage',
        'testedHost',
        'sourceCommit',
        'sourceTree',
        'internalNetwork',
        'hostPortsPublished',
        'hostDataMounted',
        'ownerCredentialsUsed',
      ]) ||
      binding.serverImage !== identity.serverImage ||
      binding.clientImage !== identity.clientImage ||
      binding.testedHost !== identity.hostImage ||
      binding.sourceCommit !== identity.sourceCommit ||
      binding.sourceTree !== identity.sourceTree ||
      binding.internalNetwork !== true ||
      binding.hostPortsPublished !== false ||
      binding.hostDataMounted !== false ||
      binding.ownerCredentialsUsed !== false
    )
      throw Error('binding');
    if (
      typeof scope.NetworkMode !== 'string' ||
      !new RegExp('^cos-g02-smb-' + identity.sourceCommit.slice(0, 8) + '-[1-9][0-9]*-network$').test(
        scope.NetworkMode,
      ) ||
      scope.Privileged !== false ||
      scope.ReadonlyRootfs !== true ||
      JSON.stringify(scope.CapDrop) !== '["ALL"]' ||
      JSON.stringify(scope.SecurityOpt) !== '["no-new-privileges"]' ||
      !Array.isArray(scope.CapAdd) ||
      [...scope.CapAdd].sort().join(',') !==
        'CAP_CHOWN,CAP_DAC_OVERRIDE,CAP_DAC_READ_SEARCH,CAP_FOWNER,CAP_SETGID,CAP_SETUID,CAP_SYS_ADMIN' ||
      [scope.Binds, scope.Mounts, scope.Devices, scope.DeviceRequests, scope.Links, scope.VolumesFrom].some(
        (value) => value != null && (!Array.isArray(value) || value.length),
      ) ||
      !scope.PortBindings ||
      typeof scope.PortBindings !== 'object' ||
      Array.isArray(scope.PortBindings) ||
      Object.keys(scope.PortBindings).length ||
      scope.Memory !== 768 * 1024 ** 2 ||
      scope.MemorySwap !== scope.Memory ||
      scope.PidsLimit !== 128 ||
      !Array.isArray(scope.Ulimits) ||
      scope.Ulimits.length !== 1 ||
      scope.Ulimits[0]?.Name !== 'core' ||
      scope.Ulimits[0]?.Soft !== 0 ||
      scope.Ulimits[0]?.Hard !== 0 ||
      !scope.Tmpfs ||
      typeof scope.Tmpfs !== 'object' ||
      Array.isArray(scope.Tmpfs)
    )
      throw Error('scope');
    const ram = scope.Tmpfs as Record<string, unknown>;
    if (
      !exact(ram, ['/run/fixture', '/tmp', '/var/lib/nanoclaw-cos']) ||
      ram['/run/fixture'] !== 'rw,nosuid,nodev,noexec,size=128m,mode=700' ||
      ram['/tmp'] !== 'rw,nosuid,nodev,noexec,size=8m,mode=700,uid=1000,gid=1000' ||
      ram['/var/lib/nanoclaw-cos'] !== 'rw,nosuid,nodev,noexec,size=8m,mode=711'
    )
      throw Error('ram');
    const required = [
      'actualKernelCifs',
      'dedicatedNonAdminAccount',
      'unrelatedShareDenied',
      'actualPinnedRestic',
      'actualEncryptedRepositoryV2',
      'actualGuardedInitialization',
      'actualReadDataCheck',
      'actualIsolatedRamRestore',
      'releasedLeaseDenied',
      'closedUnderlayDenied',
      'compiledHostCode',
    ];
    if (
      !exact(probe, [
        ...required,
        'contract',
        'status',
        'cases',
        'protocol',
        'signing',
        'ownerCredentialsUsed',
        'liveNasAcceptance',
        'capacityAcceptance',
        'finalArtifact',
      ]) ||
      probe.contract !== 'cos-g02-signed-smb-fixture/v1' ||
      probe.status !== 'passed' ||
      probe.cases !== 8 ||
      probe.protocol !== 'SMB2.1' ||
      probe.signing !== 'required' ||
      required.some((key) => probe[key] !== true) ||
      ['ownerCredentialsUsed', 'liveNasAcceptance', 'capacityAcceptance', 'finalArtifact'].some(
        (key) => probe[key] !== false,
      )
    )
      throw Error('coverage');
    if (
      !exact(ciphertext, ['contract', 'status', 'snapshotFiles', 'plaintextCanaryAbsent', 'deniedShareUnchanged']) ||
      ciphertext.contract !== 'cos-g02-smb-ciphertext-inspection/v1' ||
      ciphertext.status !== 'passed' ||
      ciphertext.snapshotFiles !== 1 ||
      ciphertext.plaintextCanaryAbsent !== true ||
      ciphertext.deniedShareUnchanged !== true
    )
      throw Error('ciphertext');
    return Object.freeze({
      status: 'passed' as const,
      cases: 8,
      scope: 'immutable_host_signed_smb_transport' as const,
      liveNasAcceptance: false as const,
      capacityAcceptance: false as const,
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Only a fixed gate error is public; private fixture diagnostics are not.
    throw Error('backup_smb_fixture_evidence_unavailable');
  }
}
