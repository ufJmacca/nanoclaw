import fs from 'node:fs';
import path from 'node:path';
import { digest, type Context } from '../domain/contracts.js';
import { readPrivate } from '../ops/target-state.js';
import { privateConversationDirectory, contextGenerationPattern } from '../ops/conversation-ownership.js';
import { verifyCoordinatedBackup, type CoordinatedRestoreProof } from '../ops/coordinated-backup.js';
import { verifyConversationBackup } from '../ops/conversation-backup.js';
import { verifyMissionBackup } from '../ops/mission-backup.js';
import { verifyCalendarWriterBackup } from '../calendar/backup.js';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../store/migrations.js';
import { validWriterBinding, type ActionWriterBinding } from './binding.js';
import type { ActionWitness } from './witness.js';
import { openTargetActionWitness } from './host-ownership.js';

export type ActionHostGrant = Pick<Context, 'scopeId' | 'ownerId' | 'agentGroupId' | 'sessionId'> & {
  id: string;
  credentialReference: string;
  backupOperationId: string;
  targetBackupDigest: string;
  writeEnabled: boolean;
  binding: ActionWriterBinding;
};
export type ActionHostProfile = {
  format: 'cos-action-host/v1';
  installationDigest: string;
  journalGeneration: string;
  grants: ActionHostGrant[];
};
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const fields = (value: unknown, names: string[]): value is Record<string, unknown> =>
  record(value) && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const identity = ({ scopeId, ownerId, agentGroupId, sessionId }: ActionHostGrant) => ({
  scopeId,
  ownerId,
  agentGroupId,
  sessionId,
});
function privateJson<T>(file: string): T {
  privateConversationDirectory(path.dirname(file));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file) throw new Error('unsafe_action_profile');
  return readPrivate<T>(file);
}
function validGrant(value: unknown): value is ActionHostGrant {
  if (
    !fields(value, [
      'scopeId',
      'ownerId',
      'agentGroupId',
      'sessionId',
      'id',
      'credentialReference',
      'backupOperationId',
      'targetBackupDigest',
      'writeEnabled',
      'binding',
    ])
  )
    return false;
  return (
    ['scopeId', 'ownerId', 'agentGroupId', 'sessionId'].every((key) => id(value[key])) &&
    typeof value.id === 'string' &&
    contextGenerationPattern.test(value.id) &&
    typeof value.credentialReference === 'string' &&
    contextGenerationPattern.test(value.credentialReference) &&
    typeof value.backupOperationId === 'string' &&
    /^release-[a-zA-Z0-9_-]{1,120}$/.test(value.backupOperationId) &&
    hash(value.targetBackupDigest) &&
    typeof value.writeEnabled === 'boolean' &&
    validWriterBinding(value.binding) &&
    value.binding.provider === 'google' &&
    value.binding.credentialGeneration === value.credentialReference
  );
}
/** No tokens or mutable provider endpoints are allowed in this private consent profile. */
export function readActionHostProfile(
  targetRoot: string,
  installationDigest: string,
  journalGeneration: string,
): ActionHostProfile {
  try {
    if (openTargetActionWitness(targetRoot, installationDigest).generation !== journalGeneration)
      throw new Error('unsafe_action_profile');
    const value = privateJson<unknown>(path.join(targetRoot, 'actions', 'writer-profile.json'));
    if (
      !fields(value, ['format', 'installationDigest', 'journalGeneration', 'grants']) ||
      value.format !== 'cos-action-host/v1' ||
      value.installationDigest !== installationDigest ||
      value.journalGeneration !== journalGeneration ||
      !Array.isArray(value.grants) ||
      !value.grants.length ||
      value.grants.length > 20 ||
      !value.grants.every(validGrant) ||
      new Set(value.grants.map((g) => g.id)).size !== value.grants.length ||
      new Set(value.grants.map((g) => g.credentialReference)).size !== value.grants.length
    )
      throw new Error('unsafe_action_profile');
    return value as ActionHostProfile;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Configuration and path diagnostics stay behind one fixed private boundary.
    throw new Error('action_profile_unavailable');
  }
}
/** Full baseline validation at host connection. Subsequent requests pin these private proof/configuration digests.
 * Archived credentials are verified inside protected storage and never returned or used for execution.
 * This contacts no provider and restores no historical authority.
 */
export async function verifyActionGrantRecovery(
  roots: CalendarStorageRoots,
  grant: ActionHostGrant,
  witness: ActionWitness,
  databaseFingerprint: string,
  inspect?: StorageInspection,
): Promise<CoordinatedRestoreProof> {
  try {
    if (!validGrant(grant) || !hash(databaseFingerprint)) throw new Error('unsafe_action_profile');
    const receiptRoot = path.join(roots.targetRoot, 'releases', grant.backupOperationId, 'action-state'),
      target = privateJson<Record<string, unknown>>(path.join(receiptRoot, 'action-backup.json')),
      proof = privateJson<CoordinatedRestoreProof>(
        path.join(roots.targetRoot, 'actions', 'restore-proofs', grant.binding.restoreProofDigest + '.json'),
      ),
      journal = { installationDigest: witness.installationDigest, generation: witness.generation };
    if (
      !fields(target, [
        'format',
        'operationId',
        'targetBindingDigest',
        'nativeBindingDigest',
        'checkpointDigest',
        'conversationBackupDigest',
        'missionBackupDigest',
        'calendarBackupDigest',
        'journal',
        'nativeDatabases',
        'maintenanceGeneration',
        'writerActivated',
        'inputs',
      ]) ||
      target.format !== 'cos-target-action-backup/v1' ||
      digest(target) !== grant.targetBackupDigest ||
      target.operationId !== grant.backupOperationId ||
      target.targetBindingDigest !== witness.installationDigest ||
      target.nativeBindingDigest !== grant.binding.bindingDigest ||
      digest(target.journal) !== digest(journal) ||
      target.writerActivated !== false ||
      !Number.isSafeInteger(target.maintenanceGeneration) ||
      Number(target.maintenanceGeneration) < 1 ||
      !Number.isSafeInteger(target.nativeDatabases) ||
      Number(target.nativeDatabases) < 1 ||
      Number(target.nativeDatabases) > 10000
    )
      throw new Error('action_recovery_proof_invalid');
    const input = target.inputs;
    if (
      !fields(input, ['context', 'nativeDatabases', 'restrictionFiles']) ||
      !fields(input.context, ['scopeId', 'ownerId', 'agentGroupId', 'sessionId', 'ingressId']) ||
      digest(input.context) !==
        digest({ ...identity(grant), ingressId: 'operator-backup-' + grant.backupOperationId }) ||
      !Array.isArray(input.nativeDatabases) ||
      input.nativeDatabases.length !== target.nativeDatabases ||
      !input.nativeDatabases.every(
        (file) => typeof file === 'string' && file.startsWith(roots.dataRoot + '/') && path.resolve(file) === file,
      ) ||
      input.nativeDatabases[0] !== path.join(roots.dataRoot, 'v2.db') ||
      !Array.isArray(input.restrictionFiles) ||
      !input.restrictionFiles.every(
        (file) => typeof file === 'string' && file.startsWith(roots.targetRoot + '/') && path.resolve(file) === file,
      )
    )
      throw new Error('action_recovery_proof_invalid');
    const checkpoint = await verifyCoordinatedBackup({
      context: input.context as Context,
      operationId: grant.backupOperationId,
      databaseFingerprint,
      receiptRoot,
      nativeDatabases: input.nativeDatabases as string[],
      restrictionFiles: input.restrictionFiles as string[],
      artifacts: { root: path.join(roots.targetRoot, 'knowledge', 'artifacts') },
      witness,
    });
    const schemaDigest = digest(MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })));
    if (
      !fields(proof, [
        'format',
        'checkpointDigest',
        'scopeIdentityDigest',
        'databaseFingerprint',
        'sandboxDatabaseFingerprint',
        'sandboxSeparated',
        'testMarkerDigest',
        'schemaVersion',
        'schemaDigest',
        'restoredStateDigest',
        'sqliteCount',
        'journal',
        'admissionRestored',
        'eventJournalRestored',
        'verifiedAt',
      ]) ||
      proof.format !== 'cos-coordinated-restore-proof/v1' ||
      digest(proof) !== grant.binding.restoreProofDigest ||
      proof.checkpointDigest !== digest(checkpoint) ||
      target.checkpointDigest !== digest(checkpoint) ||
      proof.scopeIdentityDigest !== digest(identity(grant)) ||
      proof.schemaVersion !== SCHEMA_VERSION ||
      proof.schemaDigest !== schemaDigest ||
      checkpoint.schemaVersion !== SCHEMA_VERSION ||
      checkpoint.schemaDigest !== schemaDigest ||
      proof.databaseFingerprint !== checkpoint.databaseFingerprint ||
      proof.databaseFingerprint !== databaseFingerprint ||
      !hash(proof.databaseFingerprint) ||
      !hash(proof.sandboxDatabaseFingerprint) ||
      proof.sandboxSeparated !== true ||
      proof.sandboxDatabaseFingerprint === proof.databaseFingerprint ||
      !hash(proof.testMarkerDigest) ||
      !hash(proof.restoredStateDigest) ||
      proof.sqliteCount !== target.nativeDatabases ||
      digest(proof.journal) !== digest(journal) ||
      digest(checkpoint.journal) !== digest(journal) ||
      checkpoint.contextDigest !== digest(input.context) ||
      proof.admissionRestored !== false ||
      proof.eventJournalRestored !== false ||
      typeof proof.verifiedAt !== 'string' ||
      !Number.isFinite(Date.parse(proof.verifiedAt)) ||
      new Date(proof.verifiedAt).toISOString() !== proof.verifiedAt ||
      Date.parse(proof.verifiedAt) > Date.now() + 2000
    )
      throw new Error('action_recovery_proof_invalid');
    const conversations = await verifyConversationBackup(path.join(roots.targetRoot, 'conversations'), receiptRoot),
      missions = await verifyMissionBackup(roots.targetRoot, receiptRoot),
      calendar = await verifyCalendarWriterBackup(
        {
          roots,
          operationId: grant.backupOperationId,
          receiptRoot,
          inspect,
          check: async () => {
            const current = openTargetActionWitness(roots.targetRoot, witness.installationDigest);
            if (current.generation !== witness.generation) throw new Error('action_recovery_proof_invalid');
          },
        },
        { scopeId: grant.scopeId, bindingId: grant.id, reference: grant.credentialReference },
      );
    if (
      !calendar.present ||
      digest(conversations) !== target.conversationBackupDigest ||
      digest(missions) !== target.missionBackupDigest ||
      digest(calendar) !== target.calendarBackupDigest
    )
      throw new Error('action_recovery_proof_invalid');
    if (
      digest(privateJson(path.join(receiptRoot, 'action-backup.json'))) !== grant.targetBackupDigest ||
      digest(
        privateJson(
          path.join(roots.targetRoot, 'actions', 'restore-proofs', grant.binding.restoreProofDigest + '.json'),
        ),
      ) !== grant.binding.restoreProofDigest
    )
      throw new Error('action_recovery_proof_invalid');
    if (openTargetActionWitness(roots.targetRoot, witness.installationDigest).generation !== witness.generation)
      throw new Error('action_recovery_proof_invalid');
    return proof;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Backups may contain account, source and credential data; no nested diagnostics escape.
    throw new Error('action_recovery_proof_unavailable');
  }
}
/** Cheap per-request pin after the full baseline check; no archive content or credentials are returned. */
export function actionRecoveryPinCurrent(targetRoot: string, grant: ActionHostGrant): boolean {
  try {
    return (
      validGrant(grant) &&
      digest(
        privateJson(path.join(targetRoot, 'releases', grant.backupOperationId, 'action-state', 'action-backup.json')),
      ) === grant.targetBackupDigest &&
      digest(
        privateJson(path.join(targetRoot, 'actions', 'restore-proofs', grant.binding.restoreProofDigest + '.json')),
      ) === grant.binding.restoreProofDigest
    );
    // eslint-disable-next-line no-catch-all/no-catch-all -- Lost/corrupt private pin records deny provider admission without exposing diagnostics.
  } catch {
    return false;
  }
}
