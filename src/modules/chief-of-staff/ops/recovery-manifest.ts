import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { digest } from '../domain/contracts.js';
import { checkpointSchema } from './checkpoint-schema.js';
import {
  backupCoordinatedState,
  captureCoordinatedState,
  verifyCoordinatedBackup,
  type CoordinatedBackupIdentity,
  type CoordinatedBackupOptions,
  type CoordinatedBackupReceipt,
  type CoordinatedRecoveryIdentity,
  verifyRecoveredCoordinatedState,
  assertCoordinatedRecoveryIdentity,
  type QuiescentCheckpoint,
  type ScopeCheckpoint,
} from './coordinated-backup.js';
import { withDeploymentLock } from './deployment-lock.js';
import { artifactHash } from './release-artifacts.js';
import { readPrivate, writeAtomic } from './target-state.js';
import { validateReleaseManifest } from './release-manifest.js';
import type { BackupSnapshotSink, BackupQueueReceipt } from './backup-queue.js';
import type { BackupRestoreValidationScope } from './backup-restore-workspace.js';

export type RecoverySoftware = {
  sourceCommit: string;
  sourceTree: string;
  hostPayloadSha256: string;
  schemaVersion: number;
  nativeSchemaVersion: number;
};
export type RecoveryRelease = { releaseId: string; manifestDigest: string; software: RecoverySoftware };
/** Project only tested release identity. Neither paths nor arbitrary manifest fields enter portable recovery metadata. */
export function recoveryReleaseForManifest(value: unknown): RecoveryRelease {
  const manifest = validateReleaseManifest(value);
  if (manifest.postgres.minimum !== manifest.postgres.maximum || manifest.sqlite.minimum !== manifest.sqlite.maximum)
    throw Error('operations_backup_schema_incompatible');
  checkpointSchema(manifest.postgres.maximum);
  return {
    releaseId: manifest.releaseId,
    manifestDigest: digest(manifest),
    software: {
      sourceCommit: manifest.source.commit,
      sourceTree: manifest.source.tree,
      hostPayloadSha256: manifest.hostPayloadDigest,
      schemaVersion: manifest.postgres.maximum,
      nativeSchemaVersion: manifest.sqlite.maximum,
    },
  };
}
type ExternalCheckpoint = { kind: 'application_scope_logical'; referenceDigest: string };
type NativeDenial = {
  ingressId: string;
  bindingDigest: string;
  payloadDigest: string;
  kind: string;
  target: string | null;
  state: string;
};
type RecoveryIdentity = {
  base: CoordinatedBackupIdentity;
  software: RecoverySoftware;
  externalCheckpoint: Omit<ExternalCheckpoint, 'referenceDigest'> & { referenceDigest?: string };
};
export type OperationsBackupManifest = {
  format: 'cos-operations-backup/v1';
  operationId: string;
  software: RecoverySoftware;
  backupGeneration: number;
  coordinatedDigest: string;
  contextDigest: string;
  databaseFingerprint: string;
  schemaDigest: string;
  checkpointAt: string;
  externalCheckpoint: ExternalCheckpoint;
  journal: CoordinatedBackupReceipt['journal'];
  revocations: Array<{ sourceId: string; kind: 'revoke' | 'delete'; version: number }>;
  nativeDenials: NativeDenial[];
  admissionRestored: false;
  effectsEnabled: false;
  serverBackupPolicy: 'not_verified';
};
const hex = /^[a-f0-9]{64}$/;
const identifier = /^[a-zA-Z0-9_-]{1,200}$/;
function exact(value: object, fields: string[]) {
  return Object.keys(value).sort().join(',') === fields.sort().join(',');
}
function parameters(options: RecoveryIdentity) {
  portableParameters(options);
  const { base } = options;
  if (
    !path.isAbsolute(base.receiptRoot) ||
    path.resolve(base.receiptRoot) !== base.receiptRoot ||
    fs.realpathSync(base.receiptRoot) !== base.receiptRoot
  )
    throw Error('invalid_operations_backup');
  const stat = fs.lstatSync(base.receiptRoot);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    throw Error('invalid_operations_backup');
  return path.join(base.receiptRoot, base.operationId + '.operations.json');
}
type PortableRecoveryIdentity = Omit<RecoveryIdentity, 'base'> & { base: CoordinatedRecoveryIdentity };
function portableParameters(options: PortableRecoveryIdentity) {
  const { base, software, externalCheckpoint } = options;
  if (
    !software ||
    !exact(software, ['sourceCommit', 'sourceTree', 'hostPayloadSha256', 'schemaVersion', 'nativeSchemaVersion']) ||
    !/^[a-f0-9]{40}$/.test(software.sourceCommit) ||
    !/^[a-f0-9]{40}$/.test(software.sourceTree) ||
    !hex.test(software.hostPayloadSha256) ||
    (base.schemaVersion !== undefined && base.schemaVersion !== software.schemaVersion) ||
    !Number.isSafeInteger(software.nativeSchemaVersion) ||
    software.nativeSchemaVersion < 1 ||
    !externalCheckpoint ||
    !exact(
      externalCheckpoint,
      externalCheckpoint.referenceDigest === undefined ? ['kind'] : ['kind', 'referenceDigest'],
    ) ||
    externalCheckpoint.kind !== 'application_scope_logical' ||
    (externalCheckpoint.referenceDigest !== undefined && !hex.test(externalCheckpoint.referenceDigest)) ||
    !/^[a-zA-Z0-9_-]{1,160}$/.test(base.operationId) ||
    !identifier.test(base.context.scopeId)
  )
    throw Error('invalid_operations_backup');
  checkpointSchema(software.schemaVersion);
}
function epoch(value: QuiescentCheckpoint) {
  if (
    !value ||
    !exact(value, ['generation', 'activeWorkers', 'activeOperations', 'nativeWriters', 'effectsEnabled']) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    value.activeWorkers !== 0 ||
    value.activeOperations !== 0 ||
    value.nativeWriters !== 0 ||
    value.effectsEnabled !== false
  )
    throw Error('operations_backup_not_quiescent');
  return value;
}
type StreamProjection = {
  remote?: { bytes: number; sha256: string; checkpoint: ScopeCheckpoint };
  sqlite: Map<string, { bytes: number; sha256: string; rows: NativeDenial[] }>;
};
function mergeNativeDenials(denials: Map<string, NativeDenial>, rows: NativeDenial[]) {
  if (rows.length > 1000) throw Error('operations_backup_bounds');
  for (const row of rows) {
    const targeted = ['cancel_mission', 'revoke_source', 'disable_connector'].includes(row.kind);
    if (
      typeof row.ingressId !== 'string' ||
      !identifier.test(row.ingressId) ||
      !hex.test(row.bindingDigest) ||
      !hex.test(row.payloadDigest) ||
      ![
        'pause_admission',
        'pause_automation',
        'stop_scope',
        'cancel_mission',
        'revoke_source',
        'disable_connector',
      ].includes(row.kind) ||
      !['recorded', 'reconciled', 'denied'].includes(row.state) ||
      (targeted ? typeof row.target !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.target) : row.target !== null) ||
      (denials.has(row.ingressId) && digest(denials.get(row.ingressId)) !== digest(row))
    )
      throw Error('operations_backup_conflict');
    if (!denials.has(row.ingressId)) denials.set(row.ingressId, Object.freeze({ ...row }));
    if (denials.size > 1000) throw Error('operations_backup_bounds');
  }
}
function denialRows(db: Database.Database, scopeId: string): NativeDenial[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cos_operator_denials'").get()) return [];
  return db
    .prepare(
      'SELECT ingress_id AS ingressId,binding_digest AS bindingDigest,payload_digest AS payloadDigest,kind,target,state FROM cos_operator_denials WHERE scope_id=? ORDER BY ingress_id LIMIT 1001',
    )
    .all(scopeId) as NativeDenial[];
}
async function projection(
  options: RecoveryIdentity,
  receipt: CoordinatedBackupReceipt,
  generation: number,
  captured?: StreamProjection,
): Promise<OperationsBackupManifest> {
  if (
    receipt.operationId !== options.base.operationId ||
    receipt.schemaVersion !== options.software.schemaVersion ||
    receipt.admissionRestored !== false ||
    receipt.remote.file !== 'remote.json' ||
    (options.externalCheckpoint.referenceDigest !== undefined &&
      receipt.remote.sha256 !== options.externalCheckpoint.referenceDigest) ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    receipt.barrierDigest !==
      digest(epoch({ generation, activeWorkers: 0, activeOperations: 0, nativeWriters: 0, effectsEnabled: false }))
  )
    throw Error('operations_backup_conflict');
  const root = path.join(options.base.receiptRoot, 'coordinated');
  let checkpoint: ScopeCheckpoint;
  if (captured) {
    if (
      !captured.remote ||
      captured.remote.bytes !== receipt.remote.bytes ||
      captured.remote.sha256 !== receipt.remote.sha256 ||
      captured.sqlite.size !== receipt.sqlite.length
    )
      throw Error('operations_backup_conflict');
    checkpoint = captured.remote.checkpoint;
  } else {
    const bytes = fs.readFileSync(path.join(root, 'remote.json'));
    try {
      if (
        bytes.length > 64 * 1024 * 1024 ||
        bytes.length !== receipt.remote.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== receipt.remote.sha256
      )
        throw Error('operations_backup_conflict');
      checkpoint = JSON.parse(bytes.toString('utf8')) as ScopeCheckpoint;
    } finally {
      bytes.fill(0);
    }
  }
  if (
    checkpoint.format !== 'cos-scoped-checkpoint/v1' ||
    checkpoint.scopeId !== options.base.context.scopeId ||
    checkpoint.databaseFingerprint !== receipt.databaseFingerprint ||
    checkpoint.schemaVersion !== receipt.schemaVersion ||
    checkpoint.schemaDigest !== receipt.schemaDigest ||
    !Number.isFinite(Date.parse(checkpoint.at)) ||
    !Array.isArray(checkpoint.rows?.revocation_tombstones) ||
    checkpoint.rows.revocation_tombstones.length > 10000
  )
    throw Error('operations_backup_conflict');
  const revocations = checkpoint.rows.revocation_tombstones
    .map((row) => {
      if (
        row.scope_id !== checkpoint.scopeId ||
        typeof row.source_id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(row.source_id) ||
        !['revoke', 'delete'].includes(row.kind as string) ||
        !Number.isSafeInteger(row.version) ||
        Number(row.version) < 1
      )
        throw Error('operations_backup_conflict');
      return { sourceId: row.source_id, kind: row.kind as 'revoke' | 'delete', version: row.version as number };
    })
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  if (new Set(revocations.map((r) => r.sourceId)).size !== revocations.length)
    throw Error('operations_backup_conflict');
  const denials = new Map<string, NativeDenial>();
  for (const item of receipt.sqlite) {
    let rows: NativeDenial[];
    const file = path.join(root, item.file);
    if (captured) {
      const value = captured.sqlite.get(item.file);
      if (!value || value.bytes !== item.bytes || value.sha256 !== item.sha256)
        throw Error('operations_backup_conflict');
      rows = value.rows;
    } else {
      // The foundation verifies paths, permissions and hashes before these read-only inspections.
      const db = new Database(file, { readonly: true, fileMustExist: true });
      try {
        rows = denialRows(db, checkpoint.scopeId);
      } finally {
        db.close();
      }
    }
    mergeNativeDenials(denials, rows);
    if (!captured && (await artifactHash(file, 4 * 1024 * 1024 * 1024)) !== item.sha256)
      throw Error('operations_backup_changed');
  }
  return {
    format: 'cos-operations-backup/v1',
    operationId: receipt.operationId,
    software: options.software,
    backupGeneration: generation,
    coordinatedDigest: digest(receipt),
    contextDigest: receipt.contextDigest,
    databaseFingerprint: receipt.databaseFingerprint,
    schemaDigest: receipt.schemaDigest,
    checkpointAt: checkpoint.at,
    externalCheckpoint: { kind: 'application_scope_logical', referenceDigest: receipt.remote.sha256 },
    journal: receipt.journal,
    revocations,
    nativeDenials: [...denials.values()].sort((a, b) => a.ingressId.localeCompare(b.ingressId)),
    admissionRestored: false,
    effectsEnabled: false,
    serverBackupPolicy: 'not_verified',
  };
}
/** Verify immutable recovery evidence offline. It neither restores state nor admits archived permissions. */
/** Recompute the forensic recovery projection directly from owned recovered
 * snapshots. Archived denials, journals and revocations never become live authority. */
export async function verifyRecoveredOperationsState(
  options: PortableRecoveryIdentity,
  scope: BackupRestoreValidationScope,
  entries: BackupQueueReceipt['files'],
  generation: number,
): Promise<{ coordinated: ReturnType<typeof verifyRecoveredCoordinatedState>; operations: OperationsBackupManifest }> {
  const captured: StreamProjection = { sqlite: new Map() };
  try {
    scope.assertCurrent();
    portableParameters(options);
    const configuration = () =>
        digest({
          software: options.software,
          externalCheckpoint: options.externalCheckpoint,
          operationId: options.base.operationId,
          context: options.base.context,
          databaseFingerprint: options.base.databaseFingerprint,
          nativeDatabases: options.base.nativeDatabases,
          restrictionFiles: options.base.restrictionFiles,
          artifactsRoot: options.base.artifacts.root,
          journal: {
            installationDigest: options.base.witness.installationDigest,
            generation: options.base.witness.generation,
          },
          generation,
        }),
      initial = configuration(),
      coordinated = verifyRecoveredCoordinatedState(options.base, scope, entries),
      receipt = coordinated.receipt,
      receiptDigest = digest(receipt),
      checkpointDigest = digest(coordinated.checkpoint);
    const current = () => {
      scope.assertCurrent();
      portableParameters(options);
      assertCoordinatedRecoveryIdentity(options.base);
      if (configuration() !== initial || digest(receipt) !== receiptDigest) throw Error('operations_recovery_changed');
    };
    current();
    captured.remote = {
      bytes: receipt.remote.bytes,
      sha256: receipt.remote.sha256,
      checkpoint: coordinated.checkpoint,
    };
    for (const item of receipt.sqlite) {
      current();
      const file = 'coordinated/' + item.file,
        actual = scope.inspectFile(file);
      if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256) throw Error('operations_recovery_changed');
      const rows = scope.withFileBytes(file, 64 * 1024 ** 2, (bytes) => {
        const db = new Database(bytes, { readonly: true });
        try {
          if (db.pragma('quick_check', { simple: true }) !== 'ok') throw Error('operations_recovery_invalid');
          return denialRows(db, options.base.context.scopeId);
        } finally {
          db.close();
        }
      });
      captured.sqlite.set(item.file, { bytes: item.bytes, sha256: item.sha256, rows });
      current();
    }
    const manifest = scope.withFileBytes(
      options.base.operationId + '.operations.json',
      1024 ** 2,
      (bytes) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as OperationsBackupManifest,
    );
    const expected = await projection(
      { ...options, base: { ...options.base, receiptRoot: scope.directory } },
      receipt,
      generation,
      captured,
    );
    current();
    if (digest(manifest) !== digest(expected) || digest(coordinated.checkpoint) !== checkpointDigest)
      throw Error('operations_recovery_changed');
    return { coordinated, operations: expected };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Native denials, revocation details and recovered diagnostic data remain private.
    throw Error('operations_recovery_check_unavailable');
  } finally {
    captured.remote = undefined;
    captured.sqlite.clear();
  }
}
export async function verifyOperationsBackup(options: RecoveryIdentity): Promise<OperationsBackupManifest> {
  try {
    const file = parameters(options),
      manifest = readPrivate<OperationsBackupManifest>(file, 1024 * 1024),
      receipt = await verifyCoordinatedBackup(options.base),
      expected = await projection(options, receipt, manifest.backupGeneration);
    if (
      digest(manifest) !== digest(expected) ||
      digest(await verifyCoordinatedBackup(options.base)) !== digest(receipt)
    )
      throw Error('operations_backup_conflict');
    return manifest;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Backup contents, private paths and database diagnostics are not public errors.
    throw Error('operations_backup_verification_unavailable');
  }
}
/** Pair the existing coordinated snapshot with software and deny markers under its unchanged quiescent generation. */
export async function backupOperationsState(
  options: Omit<RecoveryIdentity, 'base'> & { base: CoordinatedBackupOptions },
): Promise<OperationsBackupManifest> {
  try {
    const file = parameters(options);
    return await withDeploymentLock(path.join(options.base.receiptRoot, '.operations.lock'), async () => {
      const before = epoch(await options.base.quiescent());
      if (fs.lstatSync(file, { throwIfNoEntry: false })) {
        const prior = await verifyOperationsBackup(options);
        if (
          prior.backupGeneration !== before.generation ||
          digest(epoch(await options.base.quiescent())) !== digest(before)
        )
          throw Error('operations_backup_changed');
        return prior;
      }
      const receipt = await backupCoordinatedState({ ...options.base, schemaVersion: options.software.schemaVersion }),
        checked = await verifyCoordinatedBackup(options.base);
      if (digest(receipt) !== digest(checked)) throw Error('operations_backup_changed');
      const manifest = await projection(options, receipt, before.generation);
      if (digest(epoch(await options.base.quiescent())) !== digest(before)) throw Error('operations_backup_changed');
      writeAtomic(options.base.receiptRoot, path.basename(file), manifest);
      if (digest(epoch(await options.base.quiescent())) !== digest(before)) throw Error('operations_backup_changed');
      return await verifyOperationsBackup(options);
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- The fixed failure leaves admission closed and never discloses checkpoint content.
    throw Error('operations_backup_unavailable');
  }
}

/** Capture the portable recovery manifest from the exact buffers emitted by the
 * coordinated producer. The caller holds maintenance and an admitted vault queue
 * sink. No staging file, SQLite temporary database or saved permission is used.
 */
export async function captureOperationsState(
  options: Omit<RecoveryIdentity, 'base'> & { base: CoordinatedBackupOptions },
  sink: BackupSnapshotSink,
): Promise<{ checkpoint: CoordinatedBackupReceipt; operations: OperationsBackupManifest }> {
  const captured: StreamProjection = { sqlite: new Map() };
  const canonicalDenials = new Map<string, NativeDenial>();
  try {
    parameters(options);
    const identity = () =>
      digest({
        software: options.software,
        externalCheckpoint: options.externalCheckpoint,
        operationId: options.base.operationId,
        receiptRoot: options.base.receiptRoot,
        context: options.base.context,
        databaseFingerprint: options.base.databaseFingerprint,
        schemaVersion: options.base.schemaVersion,
        nativeDatabases: options.base.nativeDatabases,
        restrictionFiles: options.base.restrictionFiles,
      });
    const configurationDigest = identity();
    const current = () => {
      parameters(options);
      if (identity() !== configurationDigest) throw Error('operations_capture_changed');
    };
    const before = Object.freeze({ ...epoch(await options.base.quiescent()) });
    current();
    const sameEpoch = async () => {
      current();
      if (digest(epoch(await options.base.quiescent())) !== digest(before)) throw Error('operations_capture_changed');
      current();
    };
    const checkpoint = await captureCoordinatedState(
      { ...options.base, schemaVersion: options.software.schemaVersion },
      {
        write(name, bytes) {
          current();
          if (!Buffer.isBuffer(bytes) || bytes.length > 64 * 1024 * 1024) throw Error('operations_capture_bounds');
          const identity = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
          if (name === 'coordinated/remote.json') {
            if (captured.remote) throw Error('operations_capture_duplicate');
            const value = JSON.parse(bytes.toString('utf8')) as ScopeCheckpoint;
            if (
              !value ||
              !Array.isArray(value.rows?.revocation_tombstones) ||
              value.rows.revocation_tombstones.length > 10000
            )
              throw Error('operations_capture_bounds');
            // Preserve only the bounded recovery projection; private row bodies are not retained.
            captured.remote = {
              ...identity,
              checkpoint: {
                format: value.format,
                scopeId: value.scopeId,
                schemaVersion: value.schemaVersion,
                schemaDigest: value.schemaDigest,
                databaseFingerprint: value.databaseFingerprint,
                at: value.at,
                columns: {},
                rows: {
                  revocation_tombstones: value.rows.revocation_tombstones.map((row) => ({
                    scope_id: row.scope_id,
                    source_id: row.source_id,
                    kind: row.kind,
                    version: row.version,
                  })),
                },
              },
            };
          } else if (/^coordinated\/sqlite\/(?:0|[1-9][0-9]*)\/native\.sqlite$/.test(name)) {
            const file = name.slice('coordinated/'.length);
            if (captured.sqlite.has(file) || captured.sqlite.size >= 4096 || bytes.length < 512)
              throw Error('operations_capture_bounds');
            const db = new Database(bytes, { readonly: true });
            try {
              if (db.pragma('quick_check', { simple: true }) !== 'ok') throw Error('operations_capture_invalid');
              const rows = denialRows(db, options.base.context.scopeId);
              mergeNativeDenials(canonicalDenials, rows);
              captured.sqlite.set(file, { ...identity, rows: rows.map((row) => canonicalDenials.get(row.ingressId)!) });
            } finally {
              db.close();
            }
          }
          sink.write(name, bytes);
        },
      },
    );
    await sameEpoch();
    const operations = await projection(options, checkpoint, before.generation, captured);
    await sameEpoch();
    const bytes = Buffer.from(JSON.stringify(operations) + '\n');
    try {
      if (bytes.length > 1024 ** 2) throw Error('operations_capture_bounds');
      sink.write(options.base.operationId + '.operations.json', bytes);
    } finally {
      bytes.fill(0);
    }
    await sameEpoch();
    return { checkpoint, operations };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Captured database contents, private paths and sink diagnostics stay private.
    throw Error('operations_capture_unavailable');
  } finally {
    captured.remote = undefined;
    captured.sqlite.clear();
    canonicalDenials.clear();
  }
}
