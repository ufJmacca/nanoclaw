import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { digest } from '../domain/contracts.js';
import { SCHEMA_VERSION } from '../store/migrations.js';
import {
  backupCoordinatedState,
  verifyCoordinatedBackup,
  type CoordinatedBackupIdentity,
  type CoordinatedBackupOptions,
  type CoordinatedBackupReceipt,
  type QuiescentCheckpoint,
  type ScopeCheckpoint,
} from './coordinated-backup.js';
import { withDeploymentLock } from './deployment-lock.js';
import { artifactHash } from './release-artifacts.js';
import { readPrivate, writeAtomic } from './target-state.js';

export type RecoverySoftware = {
  sourceCommit: string;
  sourceTree: string;
  hostPayloadSha256: string;
  schemaVersion: number;
  nativeSchemaVersion: number;
};
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
  const { base, software, externalCheckpoint } = options;
  if (
    !software ||
    !exact(software, ['sourceCommit', 'sourceTree', 'hostPayloadSha256', 'schemaVersion', 'nativeSchemaVersion']) ||
    !/^[a-f0-9]{40}$/.test(software.sourceCommit) ||
    !/^[a-f0-9]{40}$/.test(software.sourceTree) ||
    !hex.test(software.hostPayloadSha256) ||
    software.schemaVersion !== SCHEMA_VERSION ||
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
    !identifier.test(base.context.scopeId) ||
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
async function projection(
  options: RecoveryIdentity,
  receipt: CoordinatedBackupReceipt,
  generation: number,
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
  const root = path.join(options.base.receiptRoot, 'coordinated'),
    bytes = fs.readFileSync(path.join(root, 'remote.json'));
  if (
    bytes.length > 64 * 1024 * 1024 ||
    bytes.length !== receipt.remote.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== receipt.remote.sha256
  )
    throw Error('operations_backup_conflict');
  const checkpoint = JSON.parse(bytes.toString('utf8')) as ScopeCheckpoint;
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
    const file = path.join(root, item.file);
    // The foundation verifies paths, permissions and hashes before these read-only inspections.
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cos_operator_denials'").get()) continue;
      const rows = db
        .prepare(
          'SELECT ingress_id AS ingressId,binding_digest AS bindingDigest,payload_digest AS payloadDigest,kind,target,state FROM cos_operator_denials WHERE scope_id=? ORDER BY ingress_id LIMIT 1001',
        )
        .all(checkpoint.scopeId) as NativeDenial[];
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
          (targeted
            ? typeof row.target !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.target)
            : row.target !== null) ||
          (denials.has(row.ingressId) && digest(denials.get(row.ingressId)) !== digest(row))
        )
          throw Error('operations_backup_conflict');
        denials.set(row.ingressId, row);
        if (denials.size > 1000) throw Error('operations_backup_bounds');
      }
    } finally {
      db.close();
    }
    if ((await artifactHash(file, 4 * 1024 * 1024 * 1024)) !== item.sha256) throw Error('operations_backup_changed');
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
      const receipt = await backupCoordinatedState(options.base),
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
