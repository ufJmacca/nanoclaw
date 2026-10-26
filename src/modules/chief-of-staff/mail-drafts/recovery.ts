import fs from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import type { PoolConfig } from 'pg';
import { digest } from '../domain/contracts.js';
import { deploymentSettings } from '../ops/deployment-settings.js';
import { targetBinding } from '../ops/target-host.js';
import type { RecoveredTargetVaultIdentity } from '../ops/backup-recovered-state.js';
import { restoreTargetVaultBackupTestScope } from '../ops/backup-target-restore.js';
import type { RecoveryRelease } from '../ops/recovery-manifest.js';
import { checkpointSchema } from '../ops/checkpoint-schema.js';
import { contextGenerationPattern, privateConversationDirectory } from '../ops/conversation-ownership.js';
import { readPrivate } from '../ops/target-state.js';
import { BACKUP_LIMITS } from '../ops/backup-policy.js';
import { readTargetDraftOwner } from './host-ownership.js';
import type { DraftJournal } from './journal.js';
import { parseMailDraftHostGrant, type MailDraftHostGrant } from './profile.js';
import {
  restoreMailDraftCredentialBaseline,
  validMailDraftCredentialRecoveryIdentity,
  type MailDraftCredentialRecoveryIdentity,
} from './credential-recovery.js';

type StateProof = {
  repositoryId: string;
  snapshotId: string;
  archiveSha256: string;
  archiveBytes: number;
  queueOperationId: string;
  requestId: string;
  snapshotDigest: string;
  checkpointDigest: string;
  sourceDatabaseFingerprint: string;
  sandboxDatabaseFingerprint: string;
  restoredStateDigest: string;
  inserted: boolean;
  schemaVersion: 20 | 21;
  schemaDigest: string;
  admissionRestored: false;
  eventJournalRestored: false;
  credentialsActivated: false;
  writerActivated: false;
};
type CredentialProof = Awaited<ReturnType<typeof restoreMailDraftCredentialBaseline>>;
export type MailDraftRecoveryProof = {
  format: 'cos-mail-draft-recovery/v1';
  installationDigest: string;
  nativeBindingDigest: string;
  contextDigest: string;
  journalGeneration: string;
  selection: MailDraftCredentialRecoveryIdentity;
  backupOperationId: string;
  release: RecoveryRelease;
  state: StateProof;
  credentials: CredentialProof;
  verifiedAt: string;
  admissionRestored: false;
  draftJournalRestored: false;
  writerActivated: false;
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const fields = (value: unknown, names: string[]): value is Record<string, unknown> =>
  object(value) && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && contextGenerationPattern.test(value);
const instant = (value: unknown): value is string =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value &&
  Date.parse(value) <= Date.now() + 2000;
const contextIdentity = ({
  scopeId,
  ownerId,
  agentGroupId,
  sessionId,
}: MailDraftHostGrant | RecoveredTargetVaultIdentity['binding']) => ({ scopeId, ownerId, agentGroupId, sessionId });
function stateValid(value: unknown): value is StateProof {
  return (
    fields(value, [
      'repositoryId',
      'snapshotId',
      'archiveSha256',
      'archiveBytes',
      'queueOperationId',
      'requestId',
      'snapshotDigest',
      'checkpointDigest',
      'sourceDatabaseFingerprint',
      'sandboxDatabaseFingerprint',
      'restoredStateDigest',
      'inserted',
      'schemaVersion',
      'schemaDigest',
      'admissionRestored',
      'eventJournalRestored',
      'credentialsActivated',
      'writerActivated',
    ]) &&
    uuid(value.queueOperationId) &&
    uuid(value.requestId) &&
    value.queueOperationId !== value.requestId &&
    [
      value.snapshotDigest,
      value.checkpointDigest,
      value.sourceDatabaseFingerprint,
      value.sandboxDatabaseFingerprint,
      value.restoredStateDigest,
      value.repositoryId,
      value.snapshotId,
      value.archiveSha256,
    ].every(hash) &&
    value.sourceDatabaseFingerprint !== value.sandboxDatabaseFingerprint &&
    Number.isSafeInteger(value.archiveBytes) &&
    Number(value.archiveBytes) > 0 &&
    Number(value.archiveBytes) <= BACKUP_LIMITS.staging &&
    typeof value.inserted === 'boolean' &&
    (value.schemaVersion === 20 || value.schemaVersion === 21) &&
    value.schemaDigest === checkpointSchema(value.schemaVersion).digest &&
    value.admissionRestored === false &&
    value.eventJournalRestored === false &&
    value.credentialsActivated === false &&
    value.writerActivated === false
  );
}
function credentialValid(value: unknown, selection: MailDraftCredentialRecoveryIdentity): value is CredentialProof {
  return (
    fields(value, [
      'format',
      'ownerDigest',
      'selectionDigest',
      'captureOperationId',
      'requestId',
      'setDigest',
      'sourceCount',
      'fileCount',
      'snapshotId',
      'archiveSha256',
      'archiveBytes',
      'verifiedAt',
      'credentialsActivated',
      'admissionRestored',
      'draftJournalRestored',
      'writerActivated',
    ]) &&
    value.format === 'cos-mail-draft-credential-restore/v1' &&
    value.selectionDigest === digest(selection) &&
    [value.ownerDigest, value.selectionDigest, value.setDigest, value.snapshotId, value.archiveSha256].every(hash) &&
    uuid(value.captureOperationId) &&
    uuid(value.requestId) &&
    Number.isSafeInteger(value.sourceCount) &&
    Number(value.sourceCount) >= 4 &&
    Number(value.sourceCount) <= 1024 &&
    Number.isSafeInteger(value.fileCount) &&
    Number(value.fileCount) >= 10 &&
    Number(value.fileCount) <= 4096 &&
    Number.isSafeInteger(value.archiveBytes) &&
    Number(value.archiveBytes) > 0 &&
    Number(value.archiveBytes) <= BACKUP_LIMITS.credentials + 2 * 1024 ** 2 &&
    instant(value.verifiedAt) &&
    value.credentialsActivated === false &&
    value.admissionRestored === false &&
    value.draftJournalRestored === false &&
    value.writerActivated === false
  );
}
function proofValid(value: unknown): value is MailDraftRecoveryProof {
  if (
    !fields(value, [
      'format',
      'installationDigest',
      'nativeBindingDigest',
      'contextDigest',
      'journalGeneration',
      'selection',
      'backupOperationId',
      'release',
      'state',
      'credentials',
      'verifiedAt',
      'admissionRestored',
      'draftJournalRestored',
      'writerActivated',
    ]) ||
    value.format !== 'cos-mail-draft-recovery/v1' ||
    ![value.installationDigest, value.nativeBindingDigest, value.contextDigest].every(hash) ||
    !uuid(value.journalGeneration) ||
    !validMailDraftCredentialRecoveryIdentity(value.selection as MailDraftCredentialRecoveryIdentity) ||
    !stateValid(value.state) ||
    !credentialValid(value.credentials, value.selection as MailDraftCredentialRecoveryIdentity) ||
    value.backupOperationId !== 'release-action-' + value.state.queueOperationId ||
    !instant(value.verifiedAt) ||
    value.admissionRestored !== false ||
    value.draftJournalRestored !== false ||
    value.writerActivated !== false ||
    !fields(value.release, ['releaseId', 'manifestDigest', 'software']) ||
    typeof value.release.releaseId !== 'string' ||
    !/^release-[a-zA-Z0-9_-]{1,120}$/.test(value.release.releaseId) ||
    !hash(value.release.manifestDigest) ||
    !fields(value.release.software, [
      'sourceCommit',
      'sourceTree',
      'hostPayloadSha256',
      'schemaVersion',
      'nativeSchemaVersion',
    ])
  )
    return false;
  const software = value.release.software;
  return (
    typeof software.sourceCommit === 'string' &&
    /^[a-f0-9]{40}$/.test(software.sourceCommit) &&
    typeof software.sourceTree === 'string' &&
    /^[a-f0-9]{40}$/.test(software.sourceTree) &&
    hash(software.hostPayloadSha256) &&
    software.schemaVersion === value.state.schemaVersion &&
    software.nativeSchemaVersion === 22
  );
}
function journalCurrent(root: string, installation: string, journal: DraftJournal): void {
  const owner = readTargetDraftOwner(root, installation);
  if (
    journal.root !== path.join(root, 'mail-drafts/effects') ||
    journal.installationDigest !== installation ||
    journal.generation !== owner.journalGeneration
  )
    throw Error('draft_history_changed');
  journal.assertCurrent();
}
/** Trusted owner composition only. The real encrypted state importer enforces separate marked
 * SQL custody and preservation. The second real restore verifies the entire current credential set.
 * Neither archive can replace this installation's independently owned draft effect history. */
export async function produceMailDraftRecoveryProof(input: {
  target: RecoveredTargetVaultIdentity;
  journal: DraftJournal;
  selection: MailDraftCredentialRecoveryIdentity;
  stateRequestId: string;
  credentialCaptureOperationId: string;
  credentialRequestId: string;
  sandbox: { client: pg.Client; config: PoolConfig; testTargetId: string };
  checkDatabase(): Promise<void>;
}): Promise<MailDraftRecoveryProof> {
  try {
    const target = input.target,
      settings = deploymentSettings(target.settings),
      installation = digest(targetBinding(settings)),
      selection = structuredClone(input.selection),
      caller = target.current,
      databaseCheck = input.checkDatabase,
      client = input.sandbox.client,
      journal = input.journal,
      schemaVersion = target.recovery.software.schemaVersion,
      roots = {
        targetRoot: settings.stateRoot,
        installationRoot: settings.installationRoot,
        dataRoot: settings.dataRoot,
      },
      configuration = () =>
        digest({
          settings: input.target.settings,
          binding: input.target.binding,
          queueOperationId: input.target.queueOperationId,
          recovery: input.target.recovery,
          expectedSnapshotDigest: input.target.expectedSnapshotDigest,
          selection: input.selection,
          stateRequestId: input.stateRequestId,
          credentialCaptureOperationId: input.credentialCaptureOperationId,
          credentialRequestId: input.credentialRequestId,
          sandbox: { config: input.sandbox.config, testTargetId: input.sandbox.testTargetId },
        }),
      initial = configuration();
    if (
      !validMailDraftCredentialRecoveryIdentity(selection) ||
      selection.scopeId !== target.binding.scopeId ||
      !uuid(input.stateRequestId) ||
      !uuid(input.credentialCaptureOperationId) ||
      !uuid(input.credentialRequestId) ||
      !hash(target.expectedSnapshotDigest) ||
      (schemaVersion !== 20 && schemaVersion !== 21) ||
      target.recovery.software.nativeSchemaVersion !== 22 ||
      typeof caller !== 'function' ||
      typeof databaseCheck !== 'function'
    )
      throw Error('draft_recovery_identity_invalid');
    const current = () => {
        if (
          input.target !== target ||
          target.current !== caller ||
          input.checkDatabase !== databaseCheck ||
          input.sandbox.client !== client ||
          input.journal !== journal ||
          configuration() !== initial
        )
          throw Error('draft_recovery_identity_changed');
        caller();
        journalCurrent(settings.stateRoot, installation, journal);
      },
      check = async () => {
        current();
        await databaseCheck();
        current();
      };
    current();
    const recovered = await restoreTargetVaultBackupTestScope(
      { ...target, current },
      input.stateRequestId,
      input.sandbox,
      check,
    );
    current();
    const restored = recovered.validation,
      remote = recovered.remote;
    if (
      remote.contract !== 'cos-backup-remote-restore/v1' ||
      remote.kind !== 'state' ||
      remote.operationId !== target.queueOperationId
    )
      throw Error('draft_state_restore_unconfirmed');
    const state = {
      repositoryId: remote.repositoryId,
      snapshotId: remote.snapshotId,
      archiveSha256: remote.archiveSha256,
      archiveBytes: remote.archiveBytes,
      queueOperationId: target.queueOperationId,
      requestId: input.stateRequestId,
      snapshotDigest: restored.snapshotDigest,
      checkpointDigest: restored.checkpointDigest,
      sourceDatabaseFingerprint: settings.databaseFingerprint,
      sandboxDatabaseFingerprint: restored.sandboxDatabaseFingerprint,
      restoredStateDigest: restored.restoredStateDigest,
      inserted: restored.inserted,
      schemaVersion,
      schemaDigest: checkpointSchema(schemaVersion).digest,
      admissionRestored: restored.admissionRestored,
      eventJournalRestored: restored.eventJournalRestored,
      credentialsActivated: restored.credentialsActivated,
      writerActivated: restored.writerActivated,
    };
    if (
      restored.format !== 'cos-sandbox-scope-restore/v1' ||
      !stateValid(state) ||
      state.snapshotDigest !== target.expectedSnapshotDigest
    )
      throw Error('draft_state_restore_unconfirmed');
    const credentials = await restoreMailDraftCredentialBaseline(roots, {
      identity: selection,
      captureOperationId: input.credentialCaptureOperationId,
      requestId: input.credentialRequestId,
      assertAuthority: current,
    });
    current();
    if (
      credentials.captureOperationId !== input.credentialCaptureOperationId ||
      credentials.requestId !== input.credentialRequestId
    )
      throw Error('draft_credential_restore_unconfirmed');
    const proof: MailDraftRecoveryProof = {
      format: 'cos-mail-draft-recovery/v1',
      installationDigest: installation,
      nativeBindingDigest: digest(target.binding),
      contextDigest: digest(contextIdentity(target.binding)),
      journalGeneration: journal.generation,
      selection,
      backupOperationId: 'release-action-' + target.queueOperationId,
      release: structuredClone(target.recovery),
      state,
      credentials,
      verifiedAt: new Date().toISOString(),
      admissionRestored: false,
      draftJournalRestored: false,
      writerActivated: false,
    };
    if (!proofValid(proof)) throw Error('draft_recovery_proof_invalid');
    await check();
    return structuredClone(proof);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Current owner, database, encrypted restore and credential diagnostics never enter runtime responses.
    throw Error('mail_draft_recovery_unavailable');
  }
}
/** Offline installed proof pin. The only producer above calls both actual restore paths;
 * runtime accepts this metadata only when the independent host grant and SQL policy seal its hash.
 * A restored checkpoint, archive or shaped JSON alone cannot create that host/SQL authority. */
export function readMailDraftRecoveryProof(
  root: string,
  installation: string,
  journal: DraftJournal,
  grant: MailDraftHostGrant,
): MailDraftRecoveryProof {
  try {
    parseMailDraftHostGrant(grant);
    journalCurrent(root, installation, journal);
    const directory = path.join(root, 'mail-drafts/restore-proofs');
    privateConversationDirectory(directory);
    const file = path.join(directory, grant.binding.recoveryProofDigest + '.json'),
      stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file) throw Error('draft_recovery_file_unsafe');
    const proof = readPrivate<unknown>(file);
    if (
      !proofValid(proof) ||
      digest(proof) !== grant.binding.recoveryProofDigest ||
      proof.installationDigest !== installation ||
      proof.nativeBindingDigest !== grant.binding.nativeBindingDigest ||
      proof.contextDigest !== digest(contextIdentity(grant)) ||
      proof.journalGeneration !== journal.generation ||
      grant.binding.journalGeneration !== journal.generation ||
      proof.backupOperationId !== grant.backupOperationId ||
      proof.state.snapshotDigest !== grant.targetBackupDigest ||
      proof.selection.scopeId !== grant.scopeId ||
      proof.selection.writerBindingId !== grant.id ||
      proof.selection.readerBindingId !== grant.binding.readerBindingId ||
      proof.selection.writerReference !== grant.binding.credentialReference ||
      proof.selection.mailboxDigest !== grant.binding.mailboxDigest ||
      proof.selection.writerClientDigest !== grant.binding.writerClientDigest ||
      proof.selection.readerClientDigest !== grant.binding.readerClientDigest
    )
      throw Error('draft_recovery_grant_changed');
    journalCurrent(root, installation, journal);
    return structuredClone(proof);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private proof, retained context and history paths are never returned to the model.
    throw Error('mail_draft_recovery_unavailable');
  }
}
