import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { digest } from '../domain/contracts.js';
import { deploymentSettings, type DeploymentSettings } from './deployment-settings.js';
import { localTarget } from './target-identity.js';
import { targetBinding, targetCommands, checkedTargetDatabase } from './target-host.js';
import { maintenanceLeaseForOwner, assertMaintenanceLease, type MaintenanceLease } from './maintenance.js';
import { readPrivate, writeAtomic } from './target-state.js';
import { privateConversationDirectory } from './conversation-ownership.js';
import { initializeTargetActionWitness, openTargetActionWitness } from '../actions/host-ownership.js';
import { assertHostExecutionLease, type HostExecutionLease } from '../../../db/host-execution-lease.js';
import { openKnowledgeArtifacts } from '../knowledge/config.js';
import { backupCoordinatedState, type CoordinatedBackupOptions } from './coordinated-backup.js';
import { backupConversations, verifyConversationBackup } from './conversation-backup.js';
import { backupMissionState, verifyMissionBackup } from './mission-backup.js';
import { backupCalendarState, verifyCalendarBackup } from '../calendar/backup.js';
import { backupOperationsState, type RecoveryRelease } from './recovery-manifest.js';
import {
  readBackupNativeInventory as inventory,
  assertBackupNativeWritersStopped as nativeWritersStopped,
} from './target-backup-native.js';

/** Concrete target operation after migration. All code/tooling is prebuilt on the Mac.
 * This private paired backup does not activate a writer, restore a journal or grant model/account permission.
 */
export type ActionBackupAdminLease = {
  native: Database.Database;
  hostLease: HostExecutionLease;
  maintenance: MaintenanceLease;
  check(): Promise<void>;
};
export async function backupTargetActionState(
  input: DeploymentSettings,
  operationId: string,
  admin?: ActionBackupAdminLease,
  recovery?: RecoveryRelease,
) {
  try {
    const settings = deploymentSettings(input),
      binding = targetBinding(settings),
      target = localTarget(settings.stateRoot, settings.installationRoot, settings.dataRoot),
      commands = targetCommands(settings);
    if (digest(target.binding) !== digest(binding) || !/^release-[a-zA-Z0-9_-]{1,120}$/.test(operationId))
      throw new Error('action_backup_identity_required');
    const lease = admin?.maintenance ?? maintenanceLeaseForOwner(settings.stateRoot, binding, operationId),
      central = path.join(settings.dataRoot, 'v2.db');
    const adminCurrent = () => {
      if (!admin) return;
      if (
        admin.native.name !== central ||
        admin.maintenance.purpose !== 'deployment' ||
        !/^release-action-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId)
      )
        throw Error('action_backup_admin_identity_required');
      assertHostExecutionLease(admin.native, admin.hostLease);
      assertMaintenanceLease(settings.stateRoot, binding, lease);
    };
    const quiescent = async () => {
      adminCurrent();
      await admin?.check();
      adminCurrent();
      assertMaintenanceLease(settings.stateRoot, binding, lease);
      const observed = await commands.observe();
      if (
        observed.pid !== 0 ||
        observed.cwd !== settings.installationRoot ||
        !['inactive', 'failed'].includes(observed.activeState) ||
        (await commands.ownedContainers()).length
      )
        throw new Error('target_not_quiescent');
      if (admin) adminCurrent();
      else nativeWritersStopped(central);
      assertMaintenanceLease(settings.stateRoot, binding, lease);
      return {
        generation: lease.generation,
        activeWorkers: 0 as const,
        activeOperations: 0 as const,
        nativeWriters: 0 as const,
        effectsEnabled: false as const,
      };
    };
    await quiescent();
    const native = inventory(settings.dataRoot),
      outer = path.join(settings.stateRoot, 'releases', operationId);
    privateConversationDirectory(outer);
    const receiptRoot = path.join(outer, 'action-state');
    if (!fs.lstatSync(receiptRoot, { throwIfNoEntry: false })) fs.mkdirSync(receiptRoot, { mode: 0o700 });
    privateConversationDirectory(receiptRoot);
    // Initialization belongs to this trusted maintenance operation, never to runtime reconstruction.
    const witness = admin
      ? openTargetActionWitness(settings.stateRoot, digest(binding))
      : initializeTargetActionWitness(settings.stateRoot, digest(binding));
    const artifacts = openKnowledgeArtifacts(settings.stateRoot, [settings.installationRoot, settings.dataRoot]);
    const restrictionFiles = ['state.json', 'maintenance.json', 'model-activation.json']
      .map((name) => path.join(settings.stateRoot, name))
      .filter((file) => !!fs.lstatSync(file, { throwIfNoEntry: false }));
    const owners = path.join(settings.stateRoot, 'conversation-owners');
    if (fs.lstatSync(owners, { throwIfNoEntry: false })) {
      privateConversationDirectory(owners);
      for (const name of fs.readdirSync(owners).sort()) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw new Error('action_backup_owner_invalid');
        restrictionFiles.push(path.join(owners, name));
      }
    }
    const calendar = {
      roots: {
        targetRoot: settings.stateRoot,
        installationRoot: settings.installationRoot,
        dataRoot: settings.dataRoot,
      },
      operationId,
      receiptRoot,
      check: async () => {
        await quiescent();
      },
    };
    await backupConversations(path.join(settings.stateRoot, 'conversations'), receiptRoot);
    await backupMissionState(settings.stateRoot, receiptRoot);
    await backupCalendarState(calendar);
    const client = await checkedTargetDatabase(settings);
    try {
      const options: CoordinatedBackupOptions = {
        client,
        context: {
          scopeId: native.binding.scopeId,
          ownerId: native.binding.ownerId,
          sessionId: native.binding.sessionId,
          agentGroupId: native.binding.agentGroupId,
          ingressId: 'operator-backup-' + operationId,
        },
        databaseFingerprint: settings.databaseFingerprint,
        operationId,
        receiptRoot,
        nativeDatabases: native.databases,
        artifacts,
        restrictionFiles,
        witness,
        quiescent,
      };
      const checkpoint = await backupCoordinatedState(options),
        conversations = await verifyConversationBackup(path.join(settings.stateRoot, 'conversations'), receiptRoot),
        missions = await verifyMissionBackup(settings.stateRoot, receiptRoot),
        calendarReceipt = await verifyCalendarBackup(calendar);
      let operations;
      if (recovery) {
        if (
          !/^release-[a-zA-Z0-9_-]{1,120}$/.test(recovery.releaseId) ||
          !/^[a-f0-9]{64}$/.test(recovery.manifestDigest)
        )
          throw Error('operations_backup_release_required');
        const manifest = await backupOperationsState({
          base: options,
          software: recovery.software,
          externalCheckpoint: { kind: 'application_scope_logical', referenceDigest: checkpoint.remote.sha256 },
        });
        if (
          manifest.coordinatedDigest !== digest(checkpoint) ||
          manifest.backupGeneration !== lease.generation ||
          manifest.admissionRestored !== false ||
          manifest.effectsEnabled !== false
        )
          throw Error('operations_backup_conflict');
        operations = {
          release: {
            releaseId: recovery.releaseId,
            manifestDigest: recovery.manifestDigest,
            software: manifest.software,
          },
          manifestDigest: digest(manifest),
        };
      }
      await quiescent();
      if (digest(inventory(settings.dataRoot)) !== digest(native)) throw new Error('action_backup_native_changed');
      const result = {
        format: 'cos-target-action-backup/v1',
        operationId,
        targetBindingDigest: digest(binding),
        nativeBindingDigest: digest(native.binding),
        checkpointDigest: digest(checkpoint),
        conversationBackupDigest: digest(conversations),
        missionBackupDigest: digest(missions),
        calendarBackupDigest: digest(calendarReceipt),
        journal: { installationDigest: witness.installationDigest, generation: witness.generation },
        nativeDatabases: native.databases.length,
        maintenanceGeneration: lease.generation,
        writerActivated: false,
        ...(operations ? { operations } : {}),
        inputs: {
          context: options.context,
          nativeDatabases: options.nativeDatabases,
          restrictionFiles: options.restrictionFiles,
        },
      };
      const file = path.join(receiptRoot, 'action-backup.json');
      if (fs.lstatSync(file, { throwIfNoEntry: false }) && digest(readPrivate(file)) !== digest(result))
        throw new Error('action_backup_conflict');
      writeAtomic(receiptRoot, 'action-backup.json', result);
      return result;
    } finally {
      await client.end();
    }
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private histories, filesystem paths and database configuration must not enter diagnostics.
    throw new Error('target_action_backup_unavailable');
  }
}
