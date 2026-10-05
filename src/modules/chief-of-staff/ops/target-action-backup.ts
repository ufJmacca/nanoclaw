import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { deploymentSettings, type DeploymentSettings } from './deployment-settings.js';
import { localTarget } from './target-identity.js';
import { targetBinding, targetCommands, checkedTargetDatabase } from './target-host.js';
import { maintenanceLeaseForOwner, assertMaintenanceLease } from './maintenance.js';
import { readPrivate, writeAtomic } from './target-state.js';
import { privateConversationDirectory } from './conversation-ownership.js';
import { initializeTargetActionWitness } from '../actions/host-ownership.js';
import { openKnowledgeArtifacts } from '../knowledge/config.js';
import { backupCoordinatedState, type CoordinatedBackupOptions } from './coordinated-backup.js';
import { backupConversations, verifyConversationBackup } from './conversation-backup.js';
import { backupMissionState, verifyMissionBackup } from './mission-backup.js';
import { backupCalendarState, verifyCalendarBackup } from '../calendar/backup.js';

function inventory(dataRoot: string) {
  const central = path.join(dataRoot, 'v2.db'),
    db = new Database(central, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        'SELECT scope_id,agent_group_id,messaging_group_id,session_id,binding FROM cos_identity_boundaries LIMIT 2',
      )
      .all() as Array<Record<string, string>>;
    if (rows.length !== 1) throw new Error('action_backup_binding_required');
    const row = rows[0],
      binding = JSON.parse(row.binding) as CosBinding;
    const ids = [
      'scopeId',
      'ownerId',
      'botId',
      'instanceId',
      'channelId',
      'agentGroupId',
      'messagingGroupId',
      'sessionId',
    ] as const;
    if (
      !binding ||
      Object.keys(binding).length !== 9 ||
      binding.provider !== 'codex' ||
      ids.some((key) => typeof binding[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(binding[key])) ||
      binding.ownerId === binding.botId ||
      binding.scopeId !== row.scope_id ||
      binding.agentGroupId !== row.agent_group_id ||
      binding.sessionId !== row.session_id ||
      binding.messagingGroupId !== row.messaging_group_id
    )
      throw new Error('action_backup_binding_required');
    const sessions = db.prepare('SELECT id,agent_group_id FROM sessions ORDER BY id LIMIT 10001').all() as Array<{
      id: string;
      agent_group_id: string;
    }>;
    if (
      sessions.length > 10000 ||
      !sessions.some((s) => s.id === binding.sessionId && s.agent_group_id === binding.agentGroupId)
    )
      throw new Error('action_backup_binding_required');
    const databases = [central];
    for (const session of sessions) {
      if ([session.id, session.agent_group_id].some((id) => !/^[a-zA-Z0-9_-]{1,200}$/.test(id)))
        throw new Error('unsafe_session_reference');
      for (const suffix of ['', 'cos-v1'])
        for (const name of ['inbound.db', 'outbound.db']) {
          const file = path.join(dataRoot, 'v2-sessions', session.agent_group_id, session.id, suffix, name);
          if (fs.lstatSync(file, { throwIfNoEntry: false })) databases.push(file);
        }
    }
    if (databases.length > 10000 || new Set(databases).size !== databases.length)
      throw new Error('action_backup_bounds');
    return { binding, databases };
  } finally {
    db.close();
  }
}
function nativeWritersStopped(central: string) {
  const db = new Database(central, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT pid FROM host_execution_lease WHERE singleton_id=1').get() as
      | { pid: number }
      | undefined;
    if (row) {
      if (!Number.isSafeInteger(row.pid) || row.pid < 1) throw new Error('target_host_writer_active');
      try {
        process.kill(row.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
        throw error;
      }
      throw new Error('target_host_writer_active');
    }
  } finally {
    db.close();
  }
}
/** Concrete target operation after migration. All code/tooling is prebuilt on the Mac.
 * This private paired backup does not activate a writer, restore a journal or grant model/account permission.
 */
export async function backupTargetActionState(input: DeploymentSettings, operationId: string) {
  try {
    const settings = deploymentSettings(input),
      binding = targetBinding(settings),
      target = localTarget(settings.stateRoot, settings.installationRoot, settings.dataRoot),
      commands = targetCommands(settings);
    if (digest(target.binding) !== digest(binding) || !/^release-[a-zA-Z0-9_-]{1,120}$/.test(operationId))
      throw new Error('action_backup_identity_required');
    const lease = maintenanceLeaseForOwner(settings.stateRoot, binding, operationId),
      central = path.join(settings.dataRoot, 'v2.db');
    const quiescent = async () => {
      assertMaintenanceLease(settings.stateRoot, binding, lease);
      const observed = await commands.observe();
      if (
        observed.pid !== 0 ||
        observed.cwd !== settings.installationRoot ||
        !['inactive', 'failed'].includes(observed.activeState) ||
        (await commands.ownedContainers()).length
      )
        throw new Error('target_not_quiescent');
      nativeWritersStopped(central);
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
    const witness = initializeTargetActionWitness(settings.stateRoot, digest(binding)),
      artifacts = openKnowledgeArtifacts(settings.stateRoot, [settings.installationRoot, settings.dataRoot]);
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
