import { describe, expect, it } from 'vitest';
import {
  verifyBackupVaultCredentialEvidence,
  verifyBackupCredentialReleaseEvidence,
} from './backup-vault-fixture-evidence.js';

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

const identity = {
  sourceCommit: source,
  sourceTree: tree,
  hostImage: 'sha256:' + 'c'.repeat(64),
  fixtureImage: 'sha256:' + 'd'.repeat(64),
};
const releaseRecords = () => [
  { vaultFixtureImage: identity.fixtureImage, sourceCommit: source, mode: 'backup-kernel' },
  evidence,
  { rootRecoveryWire: 'passed', liveOwnerProof: 'verified', realRecoverySlot: 'verified', recoveryKeyOnDisk: false },
  { rootOrchestration: 'passed' },
  {
    kernelVault: 'passed',
    volumeBytes: 1073741824,
    bootKeyRemoved: true,
    recoveredCanary: true,
    wrongKeyDenied: true,
    mountRaceDenied: true,
    plaintextFallback: false,
    memoryProtection: 'verified',
    recoveryKeyOnDisk: false,
    keychainRecovery: 'verified',
  },
  {
    encryptedCredentialJournal: 'passed',
    cases: 13,
    actualKilledWriters: 8,
    actualCaptureKilledWriters: 4,
    actualHeadKilledWriters: 4,
    actualEncryptedVault: true,
    compiledProductionQueue: true,
    defaultReaderAndBackupOwner: true,
    productionMemoryAndStorageOverrides: false,
    rootProofBytesRead: false,
    oauth: 'fixture',
    remoteRepository: 'metadata-only-fixture',
    remoteUpload: 'not_exercised',
    syntheticCredentialsOnly: true,
  },
];
it('requires real kernel recovery, the credential process boundary and all journal interruptions for the local release gate', () => {
  expect(verifyBackupCredentialReleaseEvidence(releaseRecords(), identity)).toEqual({
    status: 'passed',
    credentialCases: 8,
    journalCases: 13,
    actualKilledWriters: 8,
    installedAcceptance: false,
  });
});
it.each([
  'component-only',
  'missing-journal',
  'duplicate',
  'mode',
  'source',
  'host',
  'kernel',
  'wire',
  'killed-writers',
  'journal-count',
  'override',
  'remote-claim',
])('refuses %s credential release evidence', (change) => {
  const rows: Record<string, unknown>[] = releaseRecords(),
    selected = { ...identity };
  if (change === 'component-only') rows.splice(0, rows.length, evidence);
  if (change === 'missing-journal') rows.pop();
  if (change === 'duplicate') rows.push(rows[5]);
  if (change === 'mode') rows[0].mode = 'kernel';
  if (change === 'source') selected.sourceTree = 'f'.repeat(40);
  if (change === 'host') selected.hostImage = selected.fixtureImage;
  if (change === 'kernel') rows[4].memoryProtection = 'not_exercised';
  if (change === 'wire') rows[2].realRecoverySlot = 'fixture';
  if (change === 'killed-writers') rows[5].actualKilledWriters = 7;
  if (change === 'journal-count') rows[5].cases = 12;
  if (change === 'override') rows[5].productionMemoryAndStorageOverrides = true;
  if (change === 'remote-claim') rows[5].remoteUpload = 'passed';
  expect(() => verifyBackupCredentialReleaseEvidence(rows, selected)).toThrow(
    'backup_credential_release_evidence_unavailable',
  );
});
