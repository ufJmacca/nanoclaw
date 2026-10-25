import { verifyMailFixtureReport } from '../../../contracts/chief-of-staff/mail-fixture-report.js';
import { verifyMailVaultFixtureEvidence, verifyMailDraftVaultFixtureEvidence } from './mail-vault-fixture-evidence.js';
import { verifyMailDraftFixtureReport } from '../../../contracts/chief-of-staff/mail-draft-fixture-report.js';
type Identity = { sourceCommit: string; sourceTree: string; fixtureImage: string };
/** Recovery requires both exact schema cases and the full actual encrypted
 * credential composition. A successful exit or token-only archive is insufficient. */
export function verifyMailRecoveryFixtureEvidence(text: string, identity: Identity) {
  return verifyMailProfileRecoveryEvidence(text, identity, false);
}
export function verifyMailDraftRecoveryFixtureEvidence(text: string, identity: Identity) {
  return verifyMailProfileRecoveryEvidence(text, identity, true);
}
function verifyMailProfileRecoveryEvidence(text: string, identity: Identity, drafts: boolean) {
  try {
    if (drafts) verifyMailDraftVaultFixtureEvidence(text, identity, 'draft-recovery-kernel');
    else verifyMailVaultFixtureEvidence(text, identity, 'mail-recovery-kernel');
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
    const checkpointKey = drafts ? 'encryptedMailDraftCheckpoint' : 'encryptedMailCheckpoint',
      credentialKey = drafts ? 'completeMailDraftCredentialRecovery' : 'completeMailCredentialRecovery',
      checkpoint = one(checkpointKey),
      credentials = one(credentialKey),
      sources = drafts ? 14 : 11,
      profiles = drafts ? 4 : 3,
      files = drafts ? 32 : 25;
    match(checkpoint, {
      [checkpointKey]: 'passed',
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
    if (drafts) verifyMailDraftFixtureReport(checkpoint.tap as string, 'checkpoint');
    else verifyMailFixtureReport(checkpoint.tap as string, 'checkpoint');
    match(credentials, {
      [credentialKey]: 'passed',
      sourceCommit: identity.sourceCommit,
      sourceTree: identity.sourceTree,
      actualSources: sources,
      actualProfiles: profiles,
      actualPayloadFiles: files,
      actualScheduledPageSources: drafts ? 10 : 8,
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
    return { actualDatabaseCases: 2, actualSources: sources, actualProfiles: profiles, actualPayloadFiles: files };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private fixture and credential diagnostics do not become release authority.
    throw Error(drafts ? 'mail_draft_recovery_evidence_unavailable' : 'mail_recovery_evidence_unavailable');
  }
}
