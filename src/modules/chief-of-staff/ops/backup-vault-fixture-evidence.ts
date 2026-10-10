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
