import path from 'node:path';
import Database from 'better-sqlite3';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import type { ActionWitness } from '../actions/witness.js';
import { assertCoordinatedRecoveryIdentity, type CoordinatedRecoveryIdentity } from './coordinated-backup.js';
import { deploymentSettings, type DeploymentSettings } from './deployment-settings.js';
import { type RecoveryRelease, verifyRecoveredOperationsState } from './recovery-manifest.js';
import { targetBinding } from './target-host.js';
import { readBackupNativeIdentity, backupNativeDatabaseCandidates } from './target-backup-native.js';
import { verifyRecoveredPrivateHistory } from './private-history-backup.js';
import { verifyRecoveredCalendarState, verifyRecoveredForensicTree } from './backup-recovered-tree.js';
import type { BackupQueueReceipt } from './backup-queue.js';
import type { BackupRestoreValidationScope } from './backup-restore-workspace.js';
export type RecoveredCaptureHeader = {
  contract: 'cos-target-vault-capture/v1';
  operationId: string;
  queueOperationId: string;
  targetBindingDigest: string;
  nativeBindingDigest: string;
  journal: { installationDigest: string; generation: string };
  maintenanceGeneration: number;
  nativeDatabases: number;
  checkpointDigest: string;
  conversationDigest: string;
  missionDigest: string;
  calendarDigest: string;
  effectsDigest: string;
  backupCredentialsDigest: string;
  credentialJournalsDigest: string;
  inputs: Pick<CoordinatedRecoveryIdentity, 'context' | 'nativeDatabases' | 'restrictionFiles'> & {
    artifactsRoot: string;
  };
  operations: { release: RecoveryRelease; manifestDigest: string };
  writerActivated: false;
  admissionRestored: false;
};
export type RecoveredTargetVaultIdentity = {
  settings: DeploymentSettings;
  binding: CosBinding;
  witness: ActionWitness;
  queueOperationId: string;
  recovery: RecoveryRelease;
  expectedSnapshotDigest?: string;
  current(): void;
};
const hex = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const exact = (value: unknown, fields: string[]) =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === fields.sort().join(',');
const stableBinding = ({ sessionId: _sessionId, ...binding }: CosBinding) => binding;
/** Validate a complete recovered capture through owned files. Current owner,
 * installation and journal authority must be supplied by the admitted caller.
 * Historical generations, sessions, leases and credentials remain evidence. */
export async function verifyRecoveredTargetVaultState(
  options: RecoveredTargetVaultIdentity,
  scope: BackupRestoreValidationScope,
  entries: BackupQueueReceipt['files'],
): Promise<
  Awaited<ReturnType<typeof verifyRecoveredOperationsState>> & {
    header: RecoveredCaptureHeader;
    snapshotDigest: string;
    credentialsActivated: false;
    writerActivated: false;
  }
> {
  try {
    const settings = deploymentSettings(options.settings),
      bindingDigest = digest(targetBinding(settings));
    const configuration = () =>
      digest({
        settings: options.settings,
        binding: options.binding,
        queueOperationId: options.queueOperationId,
        recovery: options.recovery,
        expectedSnapshotDigest: options.expectedSnapshotDigest ?? null,
        witness: {
          root: options.witness.root,
          installationDigest: options.witness.installationDigest,
          generation: options.witness.generation,
        },
      });
    const initial = configuration(),
      entriesDigest = digest(entries),
      caller = options.current;
    const identity: { base?: CoordinatedRecoveryIdentity } = {};
    const current = () => {
      scope.assertCurrent();
      if (typeof caller !== 'function' || options.current !== caller) throw Error('recovery_caller_changed');
      caller();
      if (configuration() !== initial) throw Error('recovery_identity_changed');
      if (identity.base) assertCoordinatedRecoveryIdentity(identity.base);
      scope.assertCurrent();
    };
    current();
    if (
      !uuid.test(options.queueOperationId) ||
      options.witness.root !== path.join(settings.stateRoot, 'actions', 'effects') ||
      options.witness.installationDigest !== bindingDigest ||
      !exact(options.binding, [
        'scopeId',
        'ownerId',
        'botId',
        'instanceId',
        'channelId',
        'agentGroupId',
        'messagingGroupId',
        'provider',
        'sessionId',
      ]) ||
      typeof options.binding.sessionId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,200}$/.test(options.binding.sessionId) ||
      !exact(options.recovery, ['releaseId', 'manifestDigest', 'software']) ||
      !/^[a-zA-Z0-9_-]{1,160}$/.test(options.recovery.releaseId) ||
      !hex.test(options.recovery.manifestDigest) ||
      (options.expectedSnapshotDigest !== undefined && !hex.test(options.expectedSnapshotDigest)) ||
      !Array.isArray(entries) ||
      entries.length > 4096 ||
      new Set(entries.map((item) => item.name)).size !== entries.length
    )
      throw Error('recovery_identity_invalid');
    const checkedScope: BackupRestoreValidationScope = {
        directory: scope.directory,
        assertCurrent: current,
        assertPayloadCurrent: scope.assertPayloadCurrent,
        ensureDirectory: scope.ensureDirectory,
        inspectFile: scope.inspectFile,
        withFileBytes: scope.withFileBytes,
      },
      listed = new Map(entries.map((item) => [item.name, item]));
    const read = <T>(name: string): T => {
      current();
      const entry = listed.get(name);
      if (
        !entry ||
        !exact(entry, ['name', 'bytes', 'sha256']) ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        entry.bytes > 1024 ** 2 ||
        !hex.test(entry.sha256)
      )
        throw Error('recovery_metadata_bounds');
      const actual = scope.inspectFile(name);
      if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw Error('recovery_metadata_changed');
      const value = scope.withFileBytes(
        name,
        1024 ** 2,
        (bytes) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T,
      );
      current();
      return value;
    };
    const header = read<RecoveredCaptureHeader>('state-capture.json'),
      snapshotDigest = digest(header);
    if (
      !exact(header, [
        'contract',
        'operationId',
        'queueOperationId',
        'targetBindingDigest',
        'nativeBindingDigest',
        'journal',
        'maintenanceGeneration',
        'nativeDatabases',
        'checkpointDigest',
        'conversationDigest',
        'missionDigest',
        'calendarDigest',
        'effectsDigest',
        'backupCredentialsDigest',
        'credentialJournalsDigest',
        'inputs',
        'operations',
        'writerActivated',
        'admissionRestored',
      ]) ||
      header.contract !== 'cos-target-vault-capture/v1' ||
      typeof header.operationId !== 'string' ||
      !(
        header.operationId === 'release-action-' + options.queueOperationId ||
        (header.operationId.startsWith('release-backup-') &&
          uuid.test(header.operationId.slice('release-backup-'.length)))
      ) ||
      header.queueOperationId !== options.queueOperationId ||
      header.targetBindingDigest !== bindingDigest ||
      !hex.test(header.nativeBindingDigest) ||
      digest(header.journal) !==
        digest({ installationDigest: options.witness.installationDigest, generation: options.witness.generation }) ||
      !Number.isSafeInteger(header.maintenanceGeneration) ||
      header.maintenanceGeneration < 1 ||
      !Number.isSafeInteger(header.nativeDatabases) ||
      header.nativeDatabases < 1 ||
      header.nativeDatabases > 4096 ||
      header.writerActivated !== false ||
      header.admissionRestored !== false ||
      !exact(header.inputs, ['context', 'nativeDatabases', 'restrictionFiles', 'artifactsRoot']) ||
      !exact(header.operations, ['release', 'manifestDigest']) ||
      digest(header.operations.release) !== digest(options.recovery) ||
      (options.expectedSnapshotDigest !== undefined && snapshotDigest !== options.expectedSnapshotDigest)
    )
      throw Error('recovery_header_changed');
    const inputs = header.inputs;
    if (
      !Array.isArray(inputs.nativeDatabases) ||
      inputs.nativeDatabases.length !== header.nativeDatabases ||
      new Set(inputs.nativeDatabases).size !== inputs.nativeDatabases.length ||
      inputs.nativeDatabases[0] !== path.join(settings.dataRoot, 'v2.db') ||
      !Array.isArray(inputs.restrictionFiles) ||
      inputs.restrictionFiles.length > 4096 ||
      new Set(inputs.restrictionFiles).size !== inputs.restrictionFiles.length ||
      inputs.artifactsRoot !== path.join(settings.stateRoot, 'knowledge', 'artifacts')
    )
      throw Error('recovery_inputs_changed');
    const native = scope.withFileBytes('coordinated/sqlite/0/native.sqlite', 64 * 1024 ** 2, (bytes) => {
      current();
      const db = new Database(bytes, { readonly: true });
      try {
        if (db.pragma('quick_check', { simple: true }) !== 'ok') throw Error('recovery_native_invalid');
        return readBackupNativeIdentity(db);
      } finally {
        db.close();
      }
    });
    if (
      digest(native.binding) !== header.nativeBindingDigest ||
      digest(stableBinding(native.binding)) !== digest(stableBinding(options.binding)) ||
      digest(inputs.context) !==
        digest({
          scopeId: native.binding.scopeId,
          ownerId: native.binding.ownerId,
          agentGroupId: native.binding.agentGroupId,
          sessionId: native.binding.sessionId,
          ingressId: 'operator-backup-' + header.operationId,
        })
    )
      throw Error('recovery_binding_changed');
    const candidates = backupNativeDatabaseCandidates(settings.dataRoot, native.sessions),
      selected = new Set(inputs.nativeDatabases);
    if (digest(candidates.filter((file) => selected.has(file))) !== digest(inputs.nativeDatabases))
      throw Error('recovery_native_selection_changed');
    const allowedRestrictions = ['state.json', 'maintenance.json', 'model-activation.json'].map((name) =>
      path.join(settings.stateRoot, name),
    );
    let ownerFiles = false,
      previousOwner = '',
      previousFixed = -1;
    for (const file of inputs.restrictionFiles) {
      const fixed = allowedRestrictions.indexOf(file);
      if (fixed >= 0) {
        if (ownerFiles || fixed <= previousFixed) throw Error('recovery_restriction_selection');
        previousFixed = fixed;
      } else {
        const prefix = path.join(settings.stateRoot, 'conversation-owners') + '/',
          name = typeof file === 'string' && file.startsWith(prefix) ? file.slice(prefix.length) : '';
        if (!name.endsWith('.json') || !uuid.test(name.slice(0, -5)) || name <= previousOwner)
          throw Error('recovery_restriction_selection');
        ownerFiles = true;
        previousOwner = name;
      }
    }
    const base: CoordinatedRecoveryIdentity = {
      context: inputs.context,
      operationId: header.operationId,
      databaseFingerprint: settings.databaseFingerprint,
      nativeDatabases: inputs.nativeDatabases,
      restrictionFiles: inputs.restrictionFiles,
      artifacts: { root: inputs.artifactsRoot },
      witness: options.witness,
    };
    identity.base = base;
    current();
    const components: Array<[string, string]> = [
      ['coordinated/manifest.json', header.checkpointDigest],
      ['conversation-backup/receipt.json', header.conversationDigest],
      ['mission-backup/receipt.json', header.missionDigest],
      ['calendar-capture-receipt.json', header.calendarDigest],
      ['effects.capture.json', header.effectsDigest],
      ['vault-backup-credentials.capture.json', header.backupCredentialsDigest],
      ['vault-journals.capture.json', header.credentialJournalsDigest],
      [header.operationId + '.operations.json', header.operations.manifestDigest],
    ];
    const metadataNames = new Set(['state-capture.json', ...components.map(([name]) => name)]),
      prefixes = [
        'coordinated/',
        'conversation-backup/',
        'mission-backup/',
        'calendar-state/',
        'effects/',
        'vault-backup-credentials/',
        'vault-journals/',
      ];
    for (const entry of entries)
      if (!metadataNames.has(entry.name) && !prefixes.some((prefix) => entry.name.startsWith(prefix)))
        throw Error('recovery_unselected_file');
    for (const [name, sha256] of components)
      if (typeof sha256 !== 'string' || !hex.test(sha256) || digest(read(name)) !== sha256)
        throw Error('recovery_component_changed');
    const stateIndex = inputs.restrictionFiles.indexOf(path.join(settings.stateRoot, 'state.json')),
      maintenanceIndex = inputs.restrictionFiles.indexOf(path.join(settings.stateRoot, 'maintenance.json'));
    if (stateIndex < 0 || maintenanceIndex < 0) throw Error('recovery_capture_barrier_missing');
    const archivedState = read<Record<string, unknown>>('coordinated/restrictions/' + stateIndex + '.json'),
      archivedMaintenance = read<Record<string, unknown>>('coordinated/restrictions/' + maintenanceIndex + '.json');
    if (
      !exact(archivedMaintenance, ['version', 'nonce', 'owner', 'generation', 'purpose', 'bindingDigest', 'phase']) ||
      archivedMaintenance.version !== 1 ||
      typeof archivedMaintenance.nonce !== 'string' ||
      !uuid.test(archivedMaintenance.nonce) ||
      typeof archivedMaintenance.owner !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,160}$/.test(archivedMaintenance.owner) ||
      archivedMaintenance.generation !== header.maintenanceGeneration ||
      archivedMaintenance.purpose !== 'deployment' ||
      archivedMaintenance.bindingDigest !== bindingDigest ||
      archivedMaintenance.phase !== 'quiescent' ||
      (header.operationId.startsWith('release-backup-') &&
        (archivedMaintenance.owner !== header.operationId || archivedMaintenance.nonce !== header.queueOperationId)) ||
      !archivedState ||
      archivedState.lifecycle !== 'protected' ||
      archivedState.maintenance !== true ||
      archivedState.maintenanceId !== archivedMaintenance.nonce ||
      archivedState.generation !== header.maintenanceGeneration ||
      digest(archivedState.binding) !== bindingDigest
    )
      throw Error('recovery_capture_barrier_changed');
    const recovered = await verifyRecoveredOperationsState(
      { base, software: options.recovery.software, externalCheckpoint: { kind: 'application_scope_logical' } },
      checkedScope,
      entries,
      header.maintenanceGeneration,
    );
    current();
    if (
      digest(recovered.coordinated.receipt) !== header.checkpointDigest ||
      digest(recovered.operations) !== header.operations.manifestDigest
    )
      throw Error('recovery_component_changed');
    if (
      recovered.coordinated.receipt.barrierDigest !==
      digest({
        generation: header.maintenanceGeneration,
        activeWorkers: 0,
        activeOperations: 0,
        nativeWriters: 0,
        effectsEnabled: false,
      })
    )
      throw Error('recovery_capture_barrier_changed');
    if (
      digest(
        verifyRecoveredPrivateHistory(
          checkedScope,
          entries,
          path.join(settings.stateRoot, 'conversations'),
          'conversation',
        ),
      ) !== header.conversationDigest ||
      digest(verifyRecoveredPrivateHistory(checkedScope, entries, settings.stateRoot, 'mission')) !==
        header.missionDigest ||
      digest(
        verifyRecoveredCalendarState(checkedScope, entries, {
          targetRoot: settings.stateRoot,
          operationId: header.operationId,
        }),
      ) !== header.calendarDigest
    )
      throw Error('recovery_component_changed');
    for (const [prefix, sha256] of [
      ['effects', header.effectsDigest],
      ['vault-backup-credentials', header.backupCredentialsDigest],
      ['vault-journals', header.credentialJournalsDigest],
    ] as const)
      if (digest(verifyRecoveredForensicTree(checkedScope, entries, prefix)) !== sha256)
        throw Error('recovery_component_changed');
    const effectsOwner = read('effects/owner.json');
    if (
      digest(effectsOwner) !==
      digest({
        format: 'cos-action-witness-owner/v1',
        installationDigest: options.witness.installationDigest,
        generation: options.witness.generation,
      })
    )
      throw Error('recovery_journal_identity_changed');
    for (const [name, sha256] of components)
      if (digest(read(name)) !== sha256) throw Error('recovery_component_changed');
    if (
      digest(read('state-capture.json')) !== snapshotDigest ||
      digest(header) !== snapshotDigest ||
      digest(entries) !== entriesDigest
    )
      throw Error('recovery_header_changed');
    current();
    return { ...recovered, header, snapshotDigest, credentialsActivated: false, writerActivated: false };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Recovered private state and current target, journal and credential diagnostics stay in the trusted process.
    throw Error('target_vault_recovery_check_unavailable');
  }
}
