import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { SCHEMA_VERSION } from '../store/migrations.js';
import { openTargetActionWitness } from '../actions/host-ownership.js';
import { captureCalendarState } from '../calendar/backup.js';
import { assertHostExecutionLease } from '../../../db/host-execution-lease.js';
import { deploymentSettings, type DeploymentSettings } from './deployment-settings.js';
import { localTarget } from './target-identity.js';
import { targetBinding, targetCommands, checkedTargetDatabase } from './target-host.js';
import { assertMaintenanceLease, maintenanceLeaseForOwner } from './maintenance.js';
import { readPrivate } from './target-state.js';
import { readBackupNativeInventory, assertBackupNativeWritersStopped } from './target-backup-native.js';
import type { ActionBackupAdminLease } from './target-action-backup.js';
import { captureOperationsState, type RecoveryRelease } from './recovery-manifest.js';
import { openKnowledgeArtifacts } from '../knowledge/config.js';
import { capturePrivateHistory } from './private-history-backup.js';
import { createVaultBackupQueue, type BackupSnapshotSink } from './backup-queue.js';
import { verifyVaultMemory } from './vault-memory.js';
import { withVaultDirectory, verifyVaultStorage } from './vault-storage.js';
import { BACKUP_LIMITS } from './backup-policy.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const pinned = (fd: number) => '/proc/self/fd/' + fd;
const nameValid = (name: string) =>
  Buffer.byteLength(name) <= 192 &&
  name.split('/').length <= 8 &&
  name.split('/').every((part) => /^(?:[A-Za-z0-9]|\.cos-)[A-Za-z0-9_.-]*$/.test(part));
const identity = (stat: fs.Stats) =>
  digest({
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  });

/** Private file handles remain pinned through each read. These are forensic bytes;
 * the receiver must never install archived journals or leases over live authority.
 */
async function captureTree(
  source: string,
  prefix: string,
  sink: BackupSnapshotSink,
  check: () => Promise<void>,
  current: () => void,
) {
  const directories: string[] = [],
    files: Array<{ name: string; bytes: number; sha256: string }> = [];
  let total = 0,
    entries = 0;
  const visit = async (directory: string, relative = '') => {
    await check();
    const alias = /^\/proc\/self\/fd\/\d+$/.test(directory);
    const fd = fs.openSync(
      directory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (alias ? 0 : fs.constants.O_NOFOLLOW),
    );
    try {
      const initial = fs.fstatSync(fd);
      if (
        !initial.isDirectory() ||
        initial.uid !== process.getuid?.() ||
        (initial.mode & 0o7777) !== 0o700 ||
        initial.nlink < 2
      )
        throw Error('unsafe_capture_directory');
      const stable = () => {
        current();
        if (identity(fs.fstatSync(fd)) !== identity(initial) || identity(fs.statSync(directory)) !== identity(initial))
          throw Error('capture_directory_changed');
      };
      stable();
      for (const name of fs.readdirSync(pinned(fd)).sort()) {
        if (++entries > 4096) throw Error('capture_bounds');
        const relativeName = relative ? relative + '/' + name : name;
        if (!nameValid(prefix + '/' + relativeName)) throw Error('capture_name');
        const file = path.join(pinned(fd), name),
          before = fs.lstatSync(file);
        if (before.uid !== initial.uid || before.dev !== initial.dev || before.isSymbolicLink())
          throw Error('unsafe_capture_file');
        if (before.isDirectory()) {
          directories.push(relativeName);
          await visit(file, relativeName);
        } else {
          if (
            !before.isFile() ||
            before.nlink !== 1 ||
            (before.mode & 0o7777) !== 0o600 ||
            !Number.isSafeInteger(before.size) ||
            before.size < 0 ||
            before.size > BACKUP_LIMITS.credentials
          )
            throw Error('unsafe_capture_file');
          const held = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK),
            buffer = Buffer.alloc(65536),
            hash = createHash('sha256');
          let position = 0;
          try {
            if (identity(fs.fstatSync(held)) !== identity(before)) throw Error('capture_file_changed');
            do {
              current();
              stable();
              const count = fs.readSync(held, buffer, 0, Math.min(buffer.length, before.size - position), position);
              if (!count && position !== before.size) throw Error('capture_short_read');
              total += count;
              if (total > BACKUP_LIMITS.staging) throw Error('capture_bounds');
              hash.update(buffer.subarray(0, count));
              sink.write(prefix + '/' + relativeName, buffer.subarray(0, count));
              buffer.fill(0);
              position += count;
              if (
                identity(fs.fstatSync(held)) !== identity(before) ||
                identity(fs.lstatSync(file)) !== identity(before)
              )
                throw Error('capture_file_changed');
            } while (position < before.size);
            files.push({ name: relativeName, bytes: position, sha256: hash.digest('hex') });
          } finally {
            buffer.fill(0);
            fs.closeSync(held);
          }
        }
        stable();
        await check();
        stable();
      }
      stable();
    } finally {
      fs.closeSync(fd);
    }
  };
  await visit(source);
  const receipt = { contract: 'cos-private-tree-capture/v1', prefix, bytes: total, files, directories };
  const bytes = Buffer.from(JSON.stringify(receipt) + '\n');
  try {
    if (bytes.length > 1024 ** 2) throw Error('capture_bounds');
    current();
    sink.write(prefix + '.capture.json', bytes);
  } finally {
    bytes.fill(0);
  }
  await check();
  return receipt;
}

/** Concrete G02 capture. The enclosing owner or deployment operation supplies its
 * current native/maintenance authority. All writes use the default encrypted queue;
 * this operation has no NAS dependency and does not restart or resume anything.
 */
export async function captureTargetVaultState(
  input: DeploymentSettings,
  operationId: string,
  admin: ActionBackupAdminLease | undefined,
  recovery: RecoveryRelease,
) {
  try {
    verifyVaultMemory();
    if (process.platform !== 'linux' || process.arch !== 'arm64' || !process.getuid?.()) throw Error('owner_required');
    const settings = deploymentSettings(input),
      binding = targetBinding(settings),
      roots = {
        targetRoot: settings.stateRoot,
        installationRoot: settings.installationRoot,
        dataRoot: settings.dataRoot,
      };
    const target = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot),
      targetDigest = digest(target),
      recoveryDigest = digest(recovery);
    if (
      target.lifecycle !== 'protected' ||
      !target.maintenance ||
      !target.releaseId ||
      digest(target.binding) !== digest(binding) ||
      !/^release-[a-zA-Z0-9_-]{1,120}$/.test(operationId) ||
      !recovery ||
      Object.keys(recovery).sort().join(',') !== 'manifestDigest,releaseId,software' ||
      !/^release-[a-zA-Z0-9_-]{1,120}$/.test(recovery.releaseId) ||
      !/^[a-f0-9]{64}$/.test(recovery.manifestDigest) ||
      !recovery.software ||
      Object.keys(recovery.software).sort().join(',') !==
        'hostPayloadSha256,nativeSchemaVersion,schemaVersion,sourceCommit,sourceTree' ||
      !/^[a-f0-9]{40}$/.test(recovery.software.sourceCommit) ||
      !/^[a-f0-9]{40}$/.test(recovery.software.sourceTree) ||
      !/^[a-f0-9]{64}$/.test(recovery.software.hostPayloadSha256) ||
      recovery.software.schemaVersion !== SCHEMA_VERSION ||
      !Number.isSafeInteger(recovery.software.nativeSchemaVersion) ||
      recovery.software.nativeSchemaVersion < 1
    )
      throw Error('capture_identity');
    const maintenance = admin?.maintenance ?? maintenanceLeaseForOwner(roots.targetRoot, binding, operationId),
      central = path.join(settings.dataRoot, 'v2.db');
    const queueOperationId = admin ? operationId.slice('release-action-'.length) : maintenance.nonce;
    if (
      !uuid.test(queueOperationId) ||
      maintenance.purpose !== 'deployment' ||
      (admin && !operationId.startsWith('release-action-'))
    )
      throw Error('capture_identity');
    const native = readBackupNativeInventory(settings.dataRoot),
      witness = openTargetActionWitness(roots.targetRoot, digest(binding)),
      commands = targetCommands(settings);
    const current = () => {
      verifyVaultMemory();
      if (
        digest(localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot)) !== targetDigest ||
        digest(recovery) !== recoveryDigest
      )
        throw Error('capture_identity_changed');
      assertMaintenanceLease(roots.targetRoot, binding, maintenance);
      if (admin) {
        if (admin.native.name !== central) throw Error('capture_native_changed');
        assertHostExecutionLease(admin.native, admin.hostLease);
      } else assertBackupNativeWritersStopped(central);
      if (
        digest(readBackupNativeInventory(settings.dataRoot)) !== digest(native) ||
        openTargetActionWitness(roots.targetRoot, digest(binding)).generation !== witness.generation
      )
        throw Error('capture_native_changed');
      const db = new Database(central, { readonly: true, fileMustExist: true });
      try {
        const rows = db.prepare('SELECT paused FROM cos_identity_boundaries LIMIT 2').all() as Array<{
          paused: number;
        }>;
        if (rows.length !== 1 || rows[0].paused !== 1) throw Error('capture_pause_required');
      } finally {
        db.close();
      }
    };
    const quiescent = async () => {
      current();
      await admin?.check();
      current();
      const observed = await commands.observe();
      if (
        observed.pid !== 0 ||
        observed.cwd !== settings.installationRoot ||
        !['inactive', 'failed'].includes(observed.activeState) ||
        (await commands.ownedContainers()).length
      )
        throw Error('capture_not_quiescent');
      current();
      return {
        generation: maintenance.generation,
        activeWorkers: 0 as const,
        activeOperations: 0 as const,
        nativeWriters: 0 as const,
        effectsEnabled: false as const,
      };
    };
    const check = async () => {
      await quiescent();
    };
    await check();
    verifyVaultStorage(roots);
    const queue = createVaultBackupQueue(roots);
    let snapshotDigest: string | undefined, operationsDigest: string | undefined;
    const queued = await queue.capture('state', queueOperationId, async (output) => {
      const sink: BackupSnapshotSink = {
        write(name, bytes) {
          current();
          output.write(name, bytes);
          current();
        },
      };
      const conversations = await capturePrivateHistory(
        path.join(roots.targetRoot, 'conversations'),
        sink,
        'conversation',
      );
      await check();
      const missions = await capturePrivateHistory(roots.targetRoot, sink, 'mission');
      await check();
      const effects = await captureTree(witness.root, 'effects', sink, check, current);
      const credentials = await withVaultDirectory(roots, 'backup-credentials', (directory) =>
        captureTree(directory, 'vault-backup-credentials', sink, check, current),
      );
      const journals = await withVaultDirectory(roots, 'journals', (directory) =>
        captureTree(directory, 'vault-journals', sink, check, current),
      );
      // Identity-only receipt root: these capture functions create no files here.
      const receiptRoot = path.join(roots.targetRoot, 'actions');
      const calendar = await captureCalendarState({ roots, operationId, receiptRoot, check }, sink);
      await check();
      const client = await checkedTargetDatabase(settings);
      let captured;
      try {
        const restrictions = ['state.json', 'maintenance.json', 'model-activation.json']
          .map((name) => path.join(roots.targetRoot, name))
          .filter((file) => !!fs.lstatSync(file, { throwIfNoEntry: false }));
        const owners = path.join(roots.targetRoot, 'conversation-owners');
        if (fs.lstatSync(owners, { throwIfNoEntry: false }))
          for (const name of fs.readdirSync(owners).sort()) {
            if (!uuid.test(name.slice(0, -5)) || !name.endsWith('.json')) throw Error('capture_owner_invalid');
            restrictions.push(path.join(owners, name));
          }
        captured = await captureOperationsState(
          {
            base: {
              client,
              context: {
                scopeId: native.binding.scopeId,
                ownerId: native.binding.ownerId,
                agentGroupId: native.binding.agentGroupId,
                sessionId: native.binding.sessionId,
                ingressId: 'operator-backup-' + operationId,
              },
              databaseFingerprint: settings.databaseFingerprint,
              operationId,
              receiptRoot,
              nativeDatabases: native.databases,
              artifacts: openKnowledgeArtifacts(roots.targetRoot, [roots.installationRoot, roots.dataRoot]),
              restrictionFiles: restrictions,
              witness,
              quiescent,
            },
            software: recovery.software,
            externalCheckpoint: { kind: 'application_scope_logical' },
          },
          sink,
        );
      } finally {
        await client.end();
      }
      await check();
      operationsDigest = digest(captured.operations);
      const header = {
        contract: 'cos-target-vault-capture/v1',
        operationId,
        queueOperationId,
        targetBindingDigest: digest(binding),
        nativeBindingDigest: digest(native.binding),
        journal: { installationDigest: witness.installationDigest, generation: witness.generation },
        maintenanceGeneration: maintenance.generation,
        nativeDatabases: native.databases.length,
        checkpointDigest: digest(captured.checkpoint),
        conversationDigest: digest(conversations),
        missionDigest: digest(missions),
        calendarDigest: digest(calendar),
        effectsDigest: digest(effects),
        backupCredentialsDigest: digest(credentials),
        credentialJournalsDigest: digest(journals),
        operations: { release: recovery, manifestDigest: operationsDigest },
        writerActivated: false,
        admissionRestored: false,
      };
      const bytes = Buffer.from(JSON.stringify(header) + '\n');
      try {
        if (bytes.length > 1024 ** 2) throw Error('capture_bounds');
        sink.write('state-capture.json', bytes);
      } finally {
        bytes.fill(0);
      }
      snapshotDigest = digest(header);
      await check();
    });
    await check();
    const base = {
      operationId,
      queueOperationId: queued.operationId,
      targetBindingDigest: digest(binding),
      nativeBindingDigest: digest(native.binding),
      journal: { installationDigest: witness.installationDigest, generation: witness.generation },
      writerActivated: false,
      admissionRestored: false,
    };
    if (queued.status === 'skipped_pending') {
      const receipts = await queue.pending('state'),
        pending = receipts.find((value) => value.operationId === queued.operationId);
      if (!pending) throw Error('capture_slot_changed');
      await check();
      return { ...base, status: 'skipped_pending' as const, slotState: pending.state };
    }
    if (!snapshotDigest || !operationsDigest) throw Error('capture_missing');
    await queue.withPending('state', queueOperationId, async (directory) => {
      await check();
      if (digest(readPrivate(path.join(directory, 'state-capture.json'), 1024 ** 2)) !== snapshotDigest)
        throw Error('capture_changed');
      await check();
    });
    await check();
    return {
      ...base,
      status: 'queued' as const,
      snapshotDigest,
      operations: { release: recovery, manifestDigest: operationsDigest },
    };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Capture buffers, filesystem names, database and queue diagnostics stay private.
    throw Error('target_vault_capture_unavailable');
  }
}
