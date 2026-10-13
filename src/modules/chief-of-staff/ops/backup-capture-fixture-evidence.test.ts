import { expect, it } from 'vitest';
import { verifyBackupCaptureFixtureEvidence } from './backup-capture-fixture-evidence.js';
const identity = {
  sourceCommit: 'a'.repeat(40),
  sourceTree: 'b'.repeat(40),
  hostImage: 'sha256:' + 'c'.repeat(64),
  fixtureImage: 'sha256:' + 'd'.repeat(64),
};
const records = () => [
  { vaultFixtureImage: identity.fixtureImage, sourceCommit: identity.sourceCommit, mode: 'backup-capture-kernel' },
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
    encryptedPostgresCapture: 'passed',
    actualDatabaseCases: 6,
    actualKernelVault: true,
    actualPinnedStaging: true,
    actualMemoryProtection: true,
    compiledProductionPayload: true,
    actualScheduledAndManualCapture: true,
    actualCompleteImport: true,
    privateTemporaryRootsRemoved: true,
    runtimeProfileUsed: false,
    sourceOverrides: false,
    ownerCredentialsUsed: false,
    targetAndServiceAdmission: 'fixture',
    innerStorageAdmission: 'fixture',
    outerStorageAdmission: 'actual_kernel',
    sealedSourceCommit: identity.sourceCommit,
    sealedSourceTree: identity.sourceTree,
    installedAcceptance: false,
    finalArtifact: false,
  },
];
it('requires the actual encrypted kernel and all six compiled separate-database capture/import cases', () => {
  expect(verifyBackupCaptureFixtureEvidence(records(), identity)).toEqual({
    status: 'passed',
    actualDatabaseCases: 6,
    actualKernelVault: true,
    installedAcceptance: false,
  });
});
it.each([
  'missing',
  'duplicate',
  'source',
  'tree',
  'host',
  'kernel',
  'mode',
  'database-count',
  'staging',
  'memory',
  'runtime',
  'override',
  'cleanup',
  'installed-claim',
  'modeled-outer-storage',
])('refuses %s complete capture evidence', (change) => {
  const value: Record<string, unknown>[] = records(),
    selected = { ...identity };
  if (change === 'missing') value.pop();
  if (change === 'duplicate') value.push(value[4]);
  if (change === 'source') selected.sourceCommit = 'f'.repeat(40);
  if (change === 'tree') selected.sourceTree = 'f'.repeat(40);
  if (change === 'host') selected.hostImage = selected.fixtureImage;
  if (change === 'kernel') value[3].kernelVault = 'failed';
  if (change === 'mode') value[0].mode = 'backup-kernel';
  if (change === 'database-count') value[4].actualDatabaseCases = 5;
  if (change === 'staging') value[4].actualPinnedStaging = false;
  if (change === 'memory') value[4].actualMemoryProtection = false;
  if (change === 'runtime') value[4].runtimeProfileUsed = true;
  if (change === 'override') value[4].sourceOverrides = true;
  if (change === 'cleanup') value[4].privateTemporaryRootsRemoved = false;
  if (change === 'installed-claim') value[4].installedAcceptance = true;
  if (change === 'modeled-outer-storage') value[4].outerStorageAdmission = 'fixture';
  expect(() => verifyBackupCaptureFixtureEvidence(value, selected)).toThrow(
    'backup_capture_release_evidence_unavailable',
  );
});
