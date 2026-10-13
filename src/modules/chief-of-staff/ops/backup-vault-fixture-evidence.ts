import { verifyVaultWireEvidence } from './vault-fixture-evidence.js';
/** This component receipt covers the real encrypted volume and credential process
 * boundary. It deliberately cannot establish service activation or a release gate.
 */
export function verifyBackupVaultCredentialEvidence(records: unknown[], sourceCommit: string, sourceTree: string) {
  const deny = (): never => {
    throw Error('backup_vault_fixture_evidence_unavailable');
  };
  if (
    !Array.isArray(records) ||
    records.length > 256 ||
    !/^[a-f0-9]{40}$/.test(sourceCommit) ||
    !/^[a-f0-9]{40}$/.test(sourceTree)
  )
    deny();
  const matches = records.filter(
    (value) => value && typeof value === 'object' && !Array.isArray(value) && 'backupVaultCredentialHandoff' in value,
  );
  if (matches.length !== 1) deny();
  const value = matches[0] as Record<string, unknown>;
  const required = [
    'actualEncryptedVault',
    'actualInstalledCredentialFiles',
    'actualDefaultOwnerProbe',
    'actualRootDescriptorDuplication',
    'actualPrivateDescriptorInheritance',
    'actualChildClosure',
    'changedMaintenanceDenied',
    'changedPermissionDenied',
    'changedFileDenied',
    'vaultLossDenied',
    'wrongReferenceDenied',
    'syntheticCredentialsOnly',
  ];
  const keys = [
    ...required,
    'backupVaultCredentialHandoff',
    'cases',
    'challenges',
    'heldOwnerChildren',
    'effectChildren',
    'sealedSourceCommit',
    'sealedSourceTree',
    'secretOutput',
    'administratorAuthority',
    'systemdActivation',
    'finalArtifact',
  ];
  if (
    Reflect.ownKeys(value).some((key) => typeof key !== 'string') ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',') ||
    value.backupVaultCredentialHandoff !== 'passed' ||
    value.cases !== 8 ||
    value.challenges !== 82 ||
    value.heldOwnerChildren !== 6 ||
    value.effectChildren !== 2 ||
    required.some((field) => value[field] !== true) ||
    value.sealedSourceCommit !== sourceCommit ||
    value.sealedSourceTree !== sourceTree ||
    value.secretOutput !== false ||
    value.administratorAuthority !== 'fixture' ||
    value.systemdActivation !== 'not_exercised' ||
    value.finalArtifact !== false
  )
    deny();
  return Object.freeze({
    status: 'passed' as const,
    cases: 8,
    challenges: 82,
    finalArtifact: false,
    systemdActivation: 'not_exercised' as const,
  });
}

/** Combine the component with the actual kernel/recovery and interrupted journal
 * run. The caller must register the fixture against the immutable release host;
 * this local gate still cannot claim installed owner or NAS acceptance.
 */
export function verifyBackupCredentialReleaseEvidence(
  records: unknown[],
  identity: Readonly<{ sourceCommit: string; sourceTree: string; hostImage: string; fixtureImage: string }>,
) {
  try {
    if (
      !identity ||
      Object.keys(identity).sort().join(',') !== 'fixtureImage,hostImage,sourceCommit,sourceTree' ||
      !/^sha256:[a-f0-9]{64}$/.test(identity.hostImage) ||
      !/^sha256:[a-f0-9]{64}$/.test(identity.fixtureImage) ||
      identity.hostImage === identity.fixtureImage
    )
      throw Error('identity');
    verifyBackupVaultCredentialEvidence(records, identity.sourceCommit, identity.sourceTree);
    verifyVaultWireEvidence(records, identity.sourceCommit, identity.fixtureImage, 'backup-kernel');
    const journals = records.filter(
      (value) => value && typeof value === 'object' && !Array.isArray(value) && 'encryptedCredentialJournal' in value,
    );
    if (journals.length !== 1) throw Error('journal');
    const journal = journals[0] as Record<string, unknown>;
    if (
      Object.keys(journal).sort().join(',') !==
        [
          'encryptedCredentialJournal',
          'cases',
          'actualKilledWriters',
          'actualCaptureKilledWriters',
          'actualHeadKilledWriters',
          'actualEncryptedVault',
          'compiledProductionQueue',
          'defaultReaderAndBackupOwner',
          'productionMemoryAndStorageOverrides',
          'rootProofBytesRead',
          'oauth',
          'remoteRepository',
          'remoteUpload',
          'syntheticCredentialsOnly',
        ]
          .sort()
          .join(',') ||
      journal.encryptedCredentialJournal !== 'passed' ||
      journal.cases !== 13 ||
      journal.actualKilledWriters !== 8 ||
      journal.actualCaptureKilledWriters !== 4 ||
      journal.actualHeadKilledWriters !== 4 ||
      [
        'actualEncryptedVault',
        'compiledProductionQueue',
        'defaultReaderAndBackupOwner',
        'syntheticCredentialsOnly',
      ].some((key) => journal[key] !== true) ||
      journal.productionMemoryAndStorageOverrides !== false ||
      journal.rootProofBytesRead !== false ||
      journal.oauth !== 'fixture' ||
      journal.remoteRepository !== 'metadata-only-fixture' ||
      journal.remoteUpload !== 'not_exercised'
    )
      throw Error('journal');
    return Object.freeze({
      status: 'passed' as const,
      credentialCases: 8,
      journalCases: 13,
      actualKilledWriters: 8,
      installedAcceptance: false as const,
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private kernel and credential diagnostics never leave the fixed gate error.
    throw Error('backup_credential_release_evidence_unavailable');
  }
}
