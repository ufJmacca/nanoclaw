import { verifyVaultWireEvidence } from './vault-fixture-evidence.js';
type Identity = Readonly<{ sourceCommit: string; sourceTree: string; hostImage: string; fixtureImage: string }>;
/** This local capture gate combines real kernel staging and six real database
 * cases. Inner target/service/storage admission remains explicit fixture ports;
 * default installed authority and service behavior still require Pi acceptance.
 */
export function verifyBackupCaptureFixtureEvidence(records: unknown[], identity: Identity) {
  try {
    if (
      !identity ||
      Object.keys(identity).sort().join(',') !== 'fixtureImage,hostImage,sourceCommit,sourceTree' ||
      !/^[a-f0-9]{40}$/.test(identity.sourceCommit) ||
      !/^[a-f0-9]{40}$/.test(identity.sourceTree) ||
      !/^sha256:[a-f0-9]{64}$/.test(identity.hostImage) ||
      !/^sha256:[a-f0-9]{64}$/.test(identity.fixtureImage) ||
      identity.hostImage === identity.fixtureImage
    )
      throw Error('identity');
    verifyVaultWireEvidence(records, identity.sourceCommit, identity.fixtureImage, 'backup-capture-kernel');
    const matches = records.filter(
      (value) => value && typeof value === 'object' && !Array.isArray(value) && 'encryptedPostgresCapture' in value,
    );
    if (matches.length !== 1) throw Error('coverage');
    const result = matches[0] as Record<string, unknown>;
    const required = [
      'actualKernelVault',
      'actualPinnedStaging',
      'actualMemoryProtection',
      'compiledProductionPayload',
      'actualScheduledAndManualCapture',
      'actualCompleteImport',
      'privateTemporaryRootsRemoved',
    ];
    const closed = [
      'runtimeProfileUsed',
      'sourceOverrides',
      'ownerCredentialsUsed',
      'installedAcceptance',
      'finalArtifact',
    ];
    if (
      Object.keys(result).sort().join(',') !==
        [
          ...required,
          ...closed,
          'encryptedPostgresCapture',
          'actualDatabaseCases',
          'targetAndServiceAdmission',
          'innerStorageAdmission',
          'outerStorageAdmission',
          'sealedSourceCommit',
          'sealedSourceTree',
        ]
          .sort()
          .join(',') ||
      result.encryptedPostgresCapture !== 'passed' ||
      result.actualDatabaseCases !== 6 ||
      required.some((key) => result[key] !== true) ||
      closed.some((key) => result[key] !== false) ||
      result.targetAndServiceAdmission !== 'fixture' ||
      result.innerStorageAdmission !== 'fixture' ||
      result.outerStorageAdmission !== 'actual_kernel' ||
      result.sealedSourceCommit !== identity.sourceCommit ||
      result.sealedSourceTree !== identity.sourceTree
    )
      throw Error('coverage');
    return Object.freeze({
      status: 'passed' as const,
      actualDatabaseCases: 6,
      actualKernelVault: true as const,
      installedAcceptance: false as const,
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private test database and kernel diagnostics do not leave the fixed gate error.
    throw Error('backup_capture_release_evidence_unavailable');
  }
}
