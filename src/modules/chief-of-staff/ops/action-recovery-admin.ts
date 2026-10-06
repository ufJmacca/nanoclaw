/** Owner-run recovery evidence. This restores only a test scope and isolated forensic bytes, never live admission. */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { CosBinding } from '../../../cos-boundary.js';
import { assertHostExecutionLease, type HostExecutionLease } from '../../../db/host-execution-lease.js';
import { digest, type Context } from '../domain/contracts.js';
import { openTargetActionWitness } from '../actions/host-ownership.js';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import { verifyCalendarBackup } from '../calendar/backup.js';
import { connectChecked } from '../store/preflight.js';
import { parseDatabaseConfig } from '../store/config.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../store/migrations.js';
import { localTarget } from './target-identity.js';
import { targetBinding } from './target-host.js';
import { deploymentSettings, type DeploymentSettings } from './deployment-settings.js';
import { activeMaintenanceLease, assertMaintenanceLease } from './maintenance.js';
import { backupTargetActionState } from './target-action-backup.js';
import { verifyConversationBackup } from './conversation-backup.js';
import { verifyMissionBackup } from './mission-backup.js';
import {
  verifyCoordinatedBackup,
  restoreCoordinatedSandbox,
  verifyCoordinatedLocalSandbox,
  restoreCoordinatedTestScope,
  verifyCoordinatedSandbox,
  type CoordinatedBackupIdentity,
  type CoordinatedRestoreProof,
} from './coordinated-backup.js';
import { writeAtomic } from './target-state.js';
import { recoveryReleaseForManifest, verifyOperationsBackup, type RecoveryRelease } from './recovery-manifest.js';
import {
  readCalendarAdminJson as readJson,
  calendarAdminDirectory as directory,
  calendarAdminOperation as operation,
} from './calendar-admin.js';
export type ActionRecoveryArguments =
  | { command: 'action-backup'; scopeId: string; requestId: string; settingsFile: string }
  | { command: 'operations-backup'; scopeId: string; requestId: string; settingsFile: string }
  | { command: 'action-restore-check'; scopeId: string; requestId: string; backupOperationId: string }
  | {
      command: 'operations-restore-check';
      scopeId: string;
      requestId: string;
      backupOperationId: string;
      settingsFile: string;
    };
export function isActionRecoveryCommand(args: { command: string }): args is ActionRecoveryArguments {
  return ['action-backup', 'action-restore-check', 'operations-backup', 'operations-restore-check'].includes(
    args.command,
  );
}
export function parseActionRecoveryArguments(args: string[]): ActionRecoveryArguments {
  const invalid = () => Error('invalid_admin_arguments'),
    backup = ['action-backup', 'operations-backup'].includes(args[0]),
    operationsRestore = args[0] === 'operations-restore-check';
  if (!isActionRecoveryCommand({ command: args[0] }) || args.length !== (operationsRestore ? 9 : 7)) throw invalid();
  const allowed = [
      '--scope',
      '--request-id',
      backup ? '--settings' : '--backup-release',
      ...(operationsRestore ? ['--settings'] : []),
    ],
    values: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || values[args[i]] !== undefined || !args[i + 1]) throw invalid();
    values[args[i]] = args[i + 1];
  }
  const scopeId = values['--scope'],
    requestId = values['--request-id'];
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(scopeId ?? '') ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId ?? '')
  )
    throw invalid();
  if (!backup) {
    const backupOperationId = values['--backup-release'];
    if (!/^release-[a-zA-Z0-9_-]{1,120}$/.test(backupOperationId ?? '')) throw invalid();
    if (!operationsRestore) return { command: 'action-restore-check', scopeId, requestId, backupOperationId };
    const settingsFile = values['--settings'];
    if (
      !settingsFile ||
      !path.isAbsolute(settingsFile) ||
      path.resolve(settingsFile) !== settingsFile ||
      /[\0\r\n]/.test(settingsFile)
    )
      throw invalid();
    return { command: 'operations-restore-check', scopeId, requestId, backupOperationId, settingsFile };
  }
  const settingsFile = values['--settings'];
  if (
    !settingsFile ||
    !path.isAbsolute(settingsFile) ||
    path.resolve(settingsFile) !== settingsFile ||
    /[\0\r\n]/.test(settingsFile)
  )
    throw invalid();
  return {
    command: args[0] === 'operations-backup' ? 'operations-backup' : 'action-backup',
    scopeId,
    requestId,
    settingsFile,
  };
}
type Options = {
  args: ActionRecoveryArguments;
  env: NodeJS.ProcessEnv;
  roots: CalendarStorageRoots;
  binding: CosBinding;
  native: Database.Database;
  hostLease: HostExecutionLease;
  check(): Promise<void>;
  assertAuthority(): void;
};
const fields = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function recordedRelease(settings: DeploymentSettings, id: string | null, current = false): RecoveryRelease {
  if (!id || !/^release-[a-zA-Z0-9_-]{1,120}$/.test(id)) throw Error('action_recovery_unavailable');
  const release = recoveryReleaseForManifest(readJson(path.join(settings.releaseRoot, id, 'release.json'))),
    deployment = readJson(path.join(settings.stateRoot, 'releases', id, 'deployment.json'));
  if (!deployment || typeof deployment !== 'object' || Array.isArray(deployment))
    throw Error('action_recovery_unavailable');
  const receipt = deployment as Record<string, unknown>;
  if (
    release.releaseId !== id ||
    receipt.version !== 1 ||
    receipt.releaseId !== id ||
    receipt.manifestDigest !== release.manifestDigest ||
    receipt.bindingDigest !== digest(targetBinding(settings)) ||
    !Array.isArray(receipt.completed) ||
    !receipt.completed.includes('source') ||
    !receipt.completed.includes('artifacts') ||
    !['in_progress', 'failed', 'health_failed', 'rolled_back', 'reopening', 'healthy', 'superseded'].includes(
      String(receipt.status),
    ) ||
    (current &&
      (receipt.status !== 'healthy' ||
        receipt.pending !== null ||
        receipt.completed.join(',') !== 'source,artifacts,quiesce,backup,migrate,activate,health'))
  )
    throw Error('action_recovery_unavailable');
  return release;
}
export async function runActionRecoveryAdmin(options: Options): Promise<Record<string, unknown>> {
  try {
    return await recovery(options);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Source data, backup paths and database credentials remain private, including cleanup failures.
    throw Error('action_recovery_unavailable');
  }
}
async function recovery(o: Options): Promise<Record<string, unknown>> {
  const { args, roots, binding } = o;
  if (
    args.scopeId !== binding.scopeId ||
    binding.provider !== 'codex' ||
    o.native.name !== path.join(roots.dataRoot, 'v2.db')
  )
    throw Error('context_binding_changed');
  await o.check();
  assertHostExecutionLease(o.native, o.hostLease);
  const target = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot),
    installationDigest = digest(target.binding),
    maintenance = activeMaintenanceLease(roots.targetRoot, target.binding),
    witness = openTargetActionWitness(roots.targetRoot, installationDigest);
  if (maintenance.purpose !== 'deployment') throw Error('action_recovery_unavailable');
  const check = async () => {
    await o.check();
    o.assertAuthority();
    assertHostExecutionLease(o.native, o.hostLease);
    assertMaintenanceLease(roots.targetRoot, target.binding, maintenance);
    if (
      digest(localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot).binding) !== installationDigest ||
      openTargetActionWitness(roots.targetRoot, installationDigest).generation !== witness.generation
    )
      throw Error('action_recovery_unavailable');
  };
  const base = { scope_id: binding.scopeId, paused: true, writer_enabled: false, live_model: 'not_invoked' };
  if (args.command === 'action-backup' || args.command === 'operations-backup') {
    const settings = deploymentSettings(readJson(args.settingsFile));
    if (settings.stateRoot !== roots.targetRoot || digest(targetBinding(settings)) !== installationDigest)
      throw Error('action_recovery_unavailable');
    const operationId = 'release-action-' + args.requestId;
    const release =
      args.command === 'operations-backup' ? recordedRelease(settings, target.releaseId, true) : undefined;
    if (release && release.releaseId !== target.releaseId) throw Error('action_recovery_unavailable');
    operation(roots, args.requestId, { command: args.command, binding, settingsDigest: digest(settings) });
    directory(directory(roots.targetRoot, 'releases'), operationId);
    const result = await backupTargetActionState(
      settings,
      operationId,
      {
        native: o.native,
        hostLease: o.hostLease,
        maintenance,
        check,
      },
      release,
    );
    await check();
    if (
      result.operationId !== operationId ||
      result.targetBindingDigest !== installationDigest ||
      result.nativeBindingDigest !== digest(binding) ||
      result.journal.generation !== witness.generation ||
      result.writerActivated !== false
    )
      throw Error('action_recovery_unavailable');
    if (
      release &&
      (!result.operations ||
        digest(result.operations.release) !== digest(release) ||
        !hash(result.operations.manifestDigest))
    )
      throw Error('action_recovery_unavailable');
    return {
      ...base,
      status: 'backup_verified_paused',
      backup_operation_id: operationId,
      target_backup_digest: digest(result),
      ...(release ? { operations_manifest_digest: result.operations!.manifestDigest } : {}),
    };
  }
  const receiptRoot = path.join(roots.targetRoot, 'releases', args.backupOperationId, 'action-state'),
    headerFile = path.join(receiptRoot, 'action-backup.json'),
    header = readJson(headerFile),
    context: Context = {
      scopeId: binding.scopeId,
      ownerId: binding.ownerId,
      agentGroupId: binding.agentGroupId,
      sessionId: binding.sessionId,
      ingressId: 'operator-backup-' + args.backupOperationId,
    };
  const operationsPresent =
    !!header && typeof header === 'object' && 'operations' in header && header.operations !== undefined;
  if (
    !fields(header, [
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
      ...(operationsPresent ? ['operations'] : []),
    ]) ||
    header.format !== 'cos-target-action-backup/v1' ||
    header.operationId !== args.backupOperationId ||
    header.targetBindingDigest !== installationDigest ||
    header.nativeBindingDigest !== digest(binding) ||
    header.writerActivated !== false ||
    !Number.isSafeInteger(header.nativeDatabases) ||
    Number(header.nativeDatabases) < 1 ||
    Number(header.nativeDatabases) > 10000 ||
    !Number.isSafeInteger(header.maintenanceGeneration) ||
    Number(header.maintenanceGeneration) < 1 ||
    Number(header.maintenanceGeneration) > maintenance.generation ||
    digest(header.journal) !== digest({ installationDigest, generation: witness.generation }) ||
    !fields(header.inputs, ['context', 'nativeDatabases', 'restrictionFiles']) ||
    digest(header.inputs.context) !== digest(context)
  )
    throw Error('action_recovery_unavailable');
  let operationsRelease: RecoveryRelease | undefined;
  let operationsSettings: DeploymentSettings | undefined;
  if (args.command === 'operations-restore-check') {
    const settings = deploymentSettings(readJson(args.settingsFile));
    if (
      settings.stateRoot !== roots.targetRoot ||
      digest(targetBinding(settings)) !== installationDigest ||
      !fields(header.operations, ['release', 'manifestDigest']) ||
      !fields(header.operations.release, ['releaseId', 'manifestDigest', 'software']) ||
      !hash(header.operations.manifestDigest) ||
      typeof header.operations.release.releaseId !== 'string' ||
      !/^release-[a-zA-Z0-9_-]{1,120}$/.test(header.operations.release.releaseId)
    )
      throw Error('action_recovery_unavailable');
    operationsRelease = recordedRelease(settings, header.operations.release.releaseId);
    operationsSettings = settings;
    if (digest(operationsRelease) !== digest(header.operations.release)) throw Error('action_recovery_unavailable');
  } else if (header.operations !== undefined) throw Error('action_recovery_unavailable');
  const inputs = header.inputs;
  if (
    !Array.isArray(inputs.nativeDatabases) ||
    inputs.nativeDatabases.length !== header.nativeDatabases ||
    inputs.nativeDatabases[0] !== path.join(roots.dataRoot, 'v2.db') ||
    inputs.nativeDatabases.some(
      (file) => typeof file !== 'string' || !file.startsWith(roots.dataRoot + '/') || path.resolve(file) !== file,
    ) ||
    !Array.isArray(inputs.restrictionFiles) ||
    inputs.restrictionFiles.length > 4096 ||
    inputs.restrictionFiles.some(
      (file) => typeof file !== 'string' || !file.startsWith(roots.targetRoot + '/') || path.resolve(file) !== file,
    )
  )
    throw Error('action_recovery_unavailable');
  const identity: CoordinatedBackupIdentity = {
      context,
      operationId: args.backupOperationId,
      receiptRoot,
      databaseFingerprint: target.binding.databaseFingerprint,
      nativeDatabases: inputs.nativeDatabases as string[],
      restrictionFiles: inputs.restrictionFiles as string[],
      artifacts: { root: path.join(roots.targetRoot, 'knowledge', 'artifacts') },
      witness,
    },
    headerDigest = digest(header);
  const current = async () => {
    await check();
    if (digest(readJson(headerFile)) !== headerDigest) throw Error('action_recovery_unavailable');
    if (
      operationsRelease &&
      operationsSettings &&
      digest(recordedRelease(operationsSettings, operationsRelease.releaseId)) !== digest(operationsRelease)
    )
      throw Error('action_recovery_unavailable');
  };
  const baseline = async () => {
    const checkpoint = await verifyCoordinatedBackup(identity),
      conversations = await verifyConversationBackup(path.join(roots.targetRoot, 'conversations'), receiptRoot),
      missions = await verifyMissionBackup(roots.targetRoot, receiptRoot),
      calendar = await verifyCalendarBackup({
        roots,
        operationId: args.backupOperationId,
        receiptRoot,
        check: current,
      });
    if (
      digest(checkpoint) !== header.checkpointDigest ||
      digest(conversations) !== header.conversationBackupDigest ||
      digest(missions) !== header.missionBackupDigest ||
      digest(calendar) !== header.calendarBackupDigest
    )
      throw Error('action_recovery_unavailable');
    if (operationsRelease) {
      const manifest = await verifyOperationsBackup({
        base: identity,
        software: operationsRelease.software,
        externalCheckpoint: { kind: 'application_scope_logical', referenceDigest: checkpoint.remote.sha256 },
      });
      if (
        manifest.coordinatedDigest !== digest(checkpoint) ||
        manifest.backupGeneration !== header.maintenanceGeneration ||
        !fields(header.operations, ['release', 'manifestDigest']) ||
        digest(manifest) !== header.operations.manifestDigest
      )
        throw Error('action_recovery_unavailable');
    }
    await current();
    return checkpoint;
  };
  const checkpoint = await baseline(),
    journal = operation(roots, args.requestId, {
      command: args.command,
      binding,
      backupOperationId: args.backupOperationId,
      targetBackupDigest: headerDigest,
    }),
    destination = path.join(journal.root, 'local-sandbox'),
    client = await connectChecked(o.env, 'test', 'migration');
  try {
    const sandbox = {
      client,
      config: parseDatabaseConfig(o.env, 'test', 'migration'),
      testTargetId: o.env.COS_TEST_TARGET_ID ?? '',
    };
    if (!fs.lstatSync(destination, { throwIfNoEntry: false }))
      await restoreCoordinatedSandbox(
        {
          ...identity,
          quiescent: async () => {
            await current();
            return {
              generation: maintenance.generation,
              activeWorkers: 0,
              activeOperations: 0,
              nativeWriters: 0,
              effectsEnabled: false,
            };
          },
        },
        destination,
      );
    await verifyCoordinatedLocalSandbox(identity, destination);
    await current();
    const restored = await restoreCoordinatedTestScope(identity, journal.root, sandbox, current),
      checked = await verifyCoordinatedSandbox(identity, destination, sandbox);
    const { scopeId, ownerId, agentGroupId, sessionId } = context;
    if (
      !fields(checked, [
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
      checked.format !== 'cos-coordinated-restore-proof/v1' ||
      checked.checkpointDigest !== digest(checkpoint) ||
      checked.scopeIdentityDigest !== digest({ scopeId, ownerId, agentGroupId, sessionId }) ||
      checked.databaseFingerprint !== identity.databaseFingerprint ||
      !hash(checked.sandboxDatabaseFingerprint) ||
      checked.sandboxDatabaseFingerprint === identity.databaseFingerprint ||
      checked.sandboxDatabaseFingerprint !== restored.sandboxDatabaseFingerprint ||
      checked.sandboxSeparated !== true ||
      checked.testMarkerDigest !== digest(sandbox.testTargetId) ||
      checked.schemaVersion !== SCHEMA_VERSION ||
      checked.schemaDigest !== digest(MIGRATIONS.map(({ version, checksum }) => ({ version, checksum }))) ||
      checked.restoredStateDigest !== restored.restoredStateDigest ||
      checked.sqliteCount !== identity.nativeDatabases.length ||
      digest(checked.journal) !== digest(checkpoint.journal) ||
      checked.admissionRestored !== false ||
      checked.eventJournalRestored !== false ||
      !Number.isFinite(Date.parse(checked.verifiedAt)) ||
      new Date(checked.verifiedAt).toISOString() !== checked.verifiedAt ||
      Date.parse(checked.verifiedAt) > Date.now() + 2000
    )
      throw Error('action_recovery_unavailable');
    const proofFile = path.join(journal.root, 'proof.json');
    let proof: CoordinatedRestoreProof = checked;
    if (fs.lstatSync(proofFile, { throwIfNoEntry: false })) {
      const prior = readJson(proofFile) as CoordinatedRestoreProof;
      if (
        digest({ ...prior, verifiedAt: checked.verifiedAt }) !== digest(checked) ||
        !Number.isFinite(Date.parse(prior.verifiedAt)) ||
        new Date(prior.verifiedAt).toISOString() !== prior.verifiedAt ||
        Date.parse(prior.verifiedAt) > Date.now() + 2000
      )
        throw Error('action_recovery_unavailable');
      proof = prior;
    }
    await baseline();
    await current();
    const root = directory(path.join(roots.targetRoot, 'actions'), 'restore-proofs'),
      proofDigest = digest(proof),
      final = path.join(root, proofDigest + '.json');
    if (fs.lstatSync(final, { throwIfNoEntry: false }) && digest(readJson(final)) !== proofDigest)
      throw Error('action_recovery_unavailable');
    writeAtomic(journal.root, 'proof.json', proof);
    writeAtomic(root, proofDigest + '.json', proof);
    await current();
    return {
      ...base,
      status: 'restore_verified_paused',
      backup_operation_id: args.backupOperationId,
      target_backup_digest: headerDigest,
      proof_digest: proofDigest,
      sandbox_separated: true,
      ...(operationsRelease
        ? {
            operations_manifest_digest: (header.operations as { manifestDigest: string }).manifestDigest,
            recovery_software: operationsRelease.software,
            admission_restored: false,
            effects_enabled: false,
          }
        : {}),
    };
  } finally {
    await client.end();
  }
}
