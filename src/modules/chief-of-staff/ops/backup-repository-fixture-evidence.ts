import { verifyBackupRepositoryReport } from '../../../contracts/chief-of-staff/backup-repository-report.js';
type Identity = Readonly<{ sourceCommit: string; sourceTree: string; hostImage: string }>;
/** All three local repository gates share one complete actual run. Vault and NAS
 * admission are explicit fixtures here and have their separate kernel gates.
 */
export function verifyBackupRepositoryFixtureEvidence(text: string, identity: Identity) {
  try {
    if (
      typeof text !== 'string' ||
      Buffer.byteLength(text) > 1024 ** 2 ||
      !identity ||
      Object.keys(identity).sort().join(',') !== 'hostImage,sourceCommit,sourceTree' ||
      !/^[a-f0-9]{40}$/.test(identity.sourceCommit) ||
      !/^[a-f0-9]{40}$/.test(identity.sourceTree) ||
      !/^sha256:[a-f0-9]{64}$/.test(identity.hostImage)
    )
      throw Error('identity');
    const lines = text.split('\n'),
      binding = JSON.parse(lines.shift()!),
      scope = JSON.parse(lines.shift()!);
    if (
      !binding ||
      typeof binding !== 'object' ||
      Array.isArray(binding) ||
      !scope ||
      typeof scope !== 'object' ||
      Array.isArray(scope) ||
      Object.keys(binding).sort().join(',') !==
        [
          'contract',
          'hostImage',
          'sourceCommit',
          'sourceTree',
          'actualRuntime',
          'actualPinnedPayload',
          'actualNativeSqlite',
          'sourceOverrides',
          'ownerCredentialsUsed',
          'databaseCredentialsUsed',
          'liveNasAcceptance',
          'vaultAndNasAdmission',
          'installedAcceptance',
        ]
          .sort()
          .join(',') ||
      binding.contract !== 'cos-g02-backup-repository-host/v1' ||
      binding.hostImage !== identity.hostImage ||
      binding.sourceCommit !== identity.sourceCommit ||
      binding.sourceTree !== identity.sourceTree ||
      ['actualRuntime', 'actualPinnedPayload', 'actualNativeSqlite'].some((key) => binding[key] !== true) ||
      [
        'sourceOverrides',
        'ownerCredentialsUsed',
        'databaseCredentialsUsed',
        'liveNasAcceptance',
        'installedAcceptance',
      ].some((key) => binding[key] !== false) ||
      binding.vaultAndNasAdmission !== 'fixture'
    )
      throw Error('binding');
    if (
      scope.NetworkMode !== 'none' ||
      scope.Privileged !== false ||
      scope.ReadonlyRootfs !== true ||
      JSON.stringify(scope.CapDrop) !== '["ALL"]' ||
      JSON.stringify(scope.SecurityOpt) !== '["no-new-privileges"]' ||
      [
        scope.CapAdd,
        scope.Binds,
        scope.Mounts,
        scope.Devices,
        scope.DeviceRequests,
        scope.Links,
        scope.VolumesFrom,
      ].some((value) => value != null && (!Array.isArray(value) || value.length)) ||
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
      Object.keys(scope.Tmpfs).join(',') !== '/tmp' ||
      scope.Tmpfs['/tmp'] !== 'rw,nosuid,nodev,exec,size=256m,mode=700,uid=1000,gid=1000'
    )
      throw Error('scope');
    const { actualRepositoryCases } = verifyBackupRepositoryReport(lines.join('\n'));
    return Object.freeze({
      status: 'passed' as const,
      actualRepositoryCases,
      gates: ['backup_transfer', 'backup_retention', 'backup_recovery'] as const,
      installedAcceptance: false as const,
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Only fixed release errors are public; raw private fixture output is not.
    throw Error('backup_repository_release_evidence_unavailable');
  }
}
