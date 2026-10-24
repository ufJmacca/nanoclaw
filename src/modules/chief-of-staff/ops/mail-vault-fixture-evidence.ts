import { verifyVaultWireEvidence } from './vault-fixture-evidence.js';
type Identity = { sourceCommit: string; sourceTree: string; fixtureImage: string };
/** This credential gate consumes the distinct, successful kernel run. Source
 * unit tests or the ordinary mail database report cannot establish this proof. */
export function verifyMailVaultFixtureEvidence(
  text: string,
  identity: Identity,
  mode: 'mail-credentials-kernel' | 'mail-recovery-kernel' = 'mail-credentials-kernel',
): { credentialGeneration: 2; journalEvents: 3; deniedDirectoryCases: 7 } {
  return verifyMailProfileVaultEvidence(text, identity, mode, false);
}
export function verifyMailDraftVaultFixtureEvidence(
  text: string,
  identity: Identity,
  mode: 'draft-credentials-kernel' | 'draft-recovery-kernel' = 'draft-credentials-kernel',
): { credentialGeneration: 2; journalEvents: 3; deniedDirectoryCases: 7 } {
  return verifyMailProfileVaultEvidence(text, identity, mode, true);
}
function verifyMailProfileVaultEvidence(
  text: string,
  identity: Identity,
  mode: 'mail-credentials-kernel' | 'mail-recovery-kernel' | 'draft-credentials-kernel' | 'draft-recovery-kernel',
  drafts: boolean,
): { credentialGeneration: 2; journalEvents: 3; deniedDirectoryCases: 7 } {
  const deny = (): never => {
    throw Error(drafts ? 'mail_draft_vault_evidence_unavailable' : 'mail_vault_evidence_unavailable');
  };
  try {
    if (!/^[a-f0-9]{40}$/.test(identity.sourceTree) || Buffer.byteLength(text) > 2 * 1024 ** 2) deny();
    const lines = text.trim().split('\n');
    if (lines.length > 256 || !text.endsWith('\n')) deny();
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    if (records.some((record) => !record || Array.isArray(record) || typeof record !== 'object' || 'code' in record))
      deny();
    verifyVaultWireEvidence(records, identity.sourceCommit, identity.fixtureImage, mode);
    const one = (key: string, value?: string) => {
      const found = records.filter((record) => key in record && (value === undefined || record[key] === value));
      if (found.length !== 1) return deny();
      return found[0];
    };
    const matches = (record: Record<string, unknown>, expected: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(expected)) if (record[key] !== value) deny();
    };
    matches(one('rootOrchestration'), { managerActivation: 'modeled', targetLeases: 'not_exercised' });
    matches(one('contract', drafts ? 'cos-g05-draft-vault-fixture/v1' : 'cos-g04-mail-vault-fixture/v1'), {
      sourceCommit: identity.sourceCommit,
      sourceTree: identity.sourceTree,
      compiledProductionPayload: true,
      actualKernelVault: true,
      actualMemoryProtection: true,
      storageOverrides: false,
      memoryOverrides: false,
      journalOverrides: false,
      ownerCredentialsUsed: false,
      oauthTransport: 'fixture',
      setupAuthority: 'fixture',
      liveAccountAcceptance: false,
      installedAcceptance: false,
      ...(drafts ? { credentialProfile: 'mail_draft_writer' } : {}),
    });
    const stages = {
      install: {
        separateClient: true,
        retryPreserved: true,
        credentialGeneration: 2,
        actualEncryptedJournal: true,
        journalEvents: 3,
        deniedCrossAccount: true,
        denialPreserved: true,
        ...(drafts ? { readerProfilePreserved: true, readerOnlyScope: true, readerJournalEvents: 1 } : {}),
      },
      directory_races: { deniedCases: 7, replacementWrites: 0 },
      unrelated_worker_mount: {
        actualKernelChange: true,
        actualNamespaceBind: true,
        namespaceRootObserved: true,
        credentialsUsableAcrossNamespaceChanges: true,
        sameHeldMailHost: true,
        credentialsUsableMountedAndUnmounted: true,
        ownerCredentialsUsed: false,
      },
      mount_loss: {
        heldHostDenied: true,
        tokenDenied: true,
        denialWriteDenied: true,
        journalDenied: true,
        setupDenied: true,
        closeSettled: true,
      },
      recovered: { credentialsPreserved: true, denialPreserved: true, journalPreserved: true },
      unavailable: { openDenied: true, setupDenied: true, plaintextWrites: 0 },
    };
    if (records.filter((record) => 'mailVaultStage' in record).length !== Object.keys(stages).length) deny();
    for (const [stage, expected] of Object.entries(stages)) matches(one('mailVaultStage', stage), expected);
    return { credentialGeneration: 2, journalEvents: 3, deniedDirectoryCases: 7 };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Reports may contain private diagnostics; consumers expose only a fixed category.
    return deny();
  }
}
