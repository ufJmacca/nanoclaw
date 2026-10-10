import { describe, expect, it } from 'vitest';
import { verifyBackupVaultCredentialEvidence } from './backup-vault-fixture-evidence.js';

const source = 'a'.repeat(40),
  tree = 'b'.repeat(40);
const evidence = {
  backupVaultCredentialHandoff: 'passed',
  cases: 8,
  challenges: 82,
  heldOwnerChildren: 6,
  effectChildren: 2,
  actualEncryptedVault: true,
  actualInstalledCredentialFiles: true,
  actualDefaultOwnerProbe: true,
  actualRootDescriptorDuplication: true,
  actualPrivateDescriptorInheritance: true,
  actualChildClosure: true,
  changedMaintenanceDenied: true,
  changedPermissionDenied: true,
  changedFileDenied: true,
  vaultLossDenied: true,
  wrongReferenceDenied: true,
  sealedSourceCommit: source,
  sealedSourceTree: tree,
  syntheticCredentialsOnly: true,
  secretOutput: false,
  administratorAuthority: 'fixture',
  systemdActivation: 'not_exercised',
  finalArtifact: false,
};
describe('encrypted-vault credential fixture evidence', () => {
  it('accepts the complete component check without claiming installed activation', () => {
    expect(verifyBackupVaultCredentialEvidence([evidence], source, tree)).toEqual({
      status: 'passed',
      cases: 8,
      challenges: 82,
      finalArtifact: false,
      systemdActivation: 'not_exercised',
    });
  });
  it.each([
    'actualEncryptedVault',
    'actualDefaultOwnerProbe',
    'actualPrivateDescriptorInheritance',
    'actualChildClosure',
    'vaultLossDenied',
  ])('refuses a missing actual %s check', (field) => {
    expect(() => verifyBackupVaultCredentialEvidence([{ ...evidence, [field]: false }], source, tree)).toThrow(
      'backup_vault_fixture_evidence_unavailable',
    );
  });
  it('refuses different sealed source or tree', () => {
    expect(() => verifyBackupVaultCredentialEvidence([evidence], 'c'.repeat(40), tree)).toThrow();
    expect(() => verifyBackupVaultCredentialEvidence([evidence], source, 'd'.repeat(40))).toThrow();
  });
  it('refuses incomplete counts, duplicate results and missing results', () => {
    for (const records of [[{ ...evidence, cases: 7 }], [{ ...evidence, challenges: 81 }], [evidence, evidence], []])
      expect(() => verifyBackupVaultCredentialEvidence(records, source, tree)).toThrow();
  });
  it('refuses a component receipt claiming a final artifact or service activation', () => {
    expect(() => verifyBackupVaultCredentialEvidence([{ ...evidence, finalArtifact: true }], source, tree)).toThrow();
    expect(() =>
      verifyBackupVaultCredentialEvidence([{ ...evidence, systemdActivation: 'passed' }], source, tree),
    ).toThrow();
  });
  it('refuses secret output or unexpected result fields', () => {
    expect(() => verifyBackupVaultCredentialEvidence([{ ...evidence, secretOutput: true }], source, tree)).toThrow();
    expect(() =>
      verifyBackupVaultCredentialEvidence([{ ...evidence, privateDiagnostic: 'unexpected' }], source, tree),
    ).toThrow();
  });
});
