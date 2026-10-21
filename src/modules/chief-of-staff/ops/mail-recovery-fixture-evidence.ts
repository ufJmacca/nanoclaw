import { verifyMailFixtureReport } from '../../../contracts/chief-of-staff/mail-fixture-report.js';
import { verifyMailVaultFixtureEvidence } from './mail-vault-fixture-evidence.js';
type Identity = { sourceCommit: string; sourceTree: string; fixtureImage: string };
/** Recovery requires both exact schema cases and the full actual encrypted
 * credential composition. A successful exit or token-only archive is insufficient. */
export function verifyMailRecoveryFixtureEvidence(text: string, identity: Identity) {
  try {
    verifyMailVaultFixtureEvidence(text, identity, 'mail-recovery-kernel');
    const records = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const one = (key: string) => {
      const matching = records.filter((record) => key in record);
      if (matching.length !== 1) throw Error('recovery_record');
      return matching[0];
    };
    const match = (record: Record<string, unknown>, expected: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(expected)) if (record[key] !== value) throw Error('recovery_field');
    };
    const checkpoint = one('encryptedMailCheckpoint'),
      credentials = one('completeMailCredentialRecovery');
    match(checkpoint, {
      encryptedMailCheckpoint: 'passed',
      sourceCommit: identity.sourceCommit,
      sourceTree: identity.sourceTree,
      actualDatabaseCases: 2,
      actualKernelVault: true,
      actualPinnedStaging: true,
      actualMemoryProtection: true,
      compiledProductionPayload: true,
      sourceOverrides: false,
      databaseProfile: 'test',
      databaseTls: 'verify-full',
      runtimeProfileUsed: false,
      ownerCredentialsUsed: false,
      liveAccountAcceptance: false,
      installedAcceptance: false,
    });
    verifyMailFixtureReport(checkpoint.tap as string, 'checkpoint');
    match(credentials, {
      completeMailCredentialRecovery: 'passed',
      sourceCommit: identity.sourceCommit,
      sourceTree: identity.sourceTree,
      actualSources: 11,
      actualProfiles: 3,
      actualPayloadFiles: 25,
      actualScheduledPageSources: 8,
      actualFixedProducer: true,
      actualPinnedRestic: true,
      actualEncryptedJournal: true,
      actualKernelWriter: true,
      actualIsolatedRestore: true,
      actualMemoryProtection: true,
      actualKernelVault: true,
      productionStorageOverrides: false,
      productionMemoryOverrides: false,
      offlinePendingPreserved: true,
      repeatedUploadReconciled: true,
      unchangedPageReused: true,
      pendingRetired: false,
      completeArchiveStaged: false,
      protectedAuthorityUnchanged: true,
      restoredAuthorityActivated: false,
      privateWorkspaceRemoved: true,
      targetAndServiceAdmission: 'fixture',
      repositoryAdmission: 'fixture',
      liveNasAcceptance: false,
      ownerCredentialsUsed: false,
      liveAccountAcceptance: false,
      installedAcceptance: false,
      compiledProductionPayload: true,
    });
    return { actualDatabaseCases: 2, actualSources: 11, actualProfiles: 3, actualPayloadFiles: 25 };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private fixture and credential diagnostics do not become release authority.
    throw Error('mail_recovery_evidence_unavailable');
  }
}
