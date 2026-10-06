import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import type { CoordinatedBackupOptions, CoordinatedBackupReceipt } from './coordinated-backup.js';
import { SCHEMA_VERSION } from '../store/migrations.js';
import { digest } from '../domain/contracts.js';
import { backupOperationsState, verifyOperationsBackup, type RecoverySoftware } from './recovery-manifest.js';
const foundation = vi.hoisted(() => ({ backup: vi.fn(), verify: vi.fn() }));
vi.mock('./coordinated-backup.js', () => ({
  backupCoordinatedState: foundation.backup,
  verifyCoordinatedBackup: foundation.verify,
}));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-s11-recovery-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const operationId = 'backup-generation',
    backup = path.join(root, 'coordinated');
  fs.mkdirSync(backup, { mode: 0o700 });
  fs.mkdirSync(path.join(backup, 'sqlite'), { mode: 0o700 });
  fs.mkdirSync(path.join(backup, 'sqlite', '0'), { mode: 0o700 });
  const remote = {
    format: 'cos-scoped-checkpoint/v1',
    scopeId: 'scope',
    schemaVersion: SCHEMA_VERSION,
    schemaDigest: 'e'.repeat(64),
    databaseFingerprint: 'd'.repeat(64),
    at: '2026-10-06T00:00:00.000Z',
    rows: {
      revocation_tombstones: [
        {
          scope_id: 'scope',
          source_id: 'source',
          kind: 'revoke',
          version: 2,
          provenance: { private: 'PRIVATE_REVOKED_PROSE' },
        },
      ],
    },
  };
  fs.writeFileSync(path.join(backup, 'remote.json'), JSON.stringify(remote), { mode: 0o600 });
  const native = new Database(path.join(backup, 'sqlite/0/native.sqlite'));
  native.exec('CREATE TABLE cos_operator_denials(scope_id,ingress_id,binding_digest,payload_digest,kind,target,state)');
  const insert = native.prepare('INSERT INTO cos_operator_denials VALUES(?,?,?,?,?,?,?)');
  insert.run('scope', 'control', 'a'.repeat(64), 'b'.repeat(64), 'revoke_source', 'source', 'reconciled');
  insert.run('foreign', 'foreign', 'a'.repeat(64), 'b'.repeat(64), 'revoke_source', 'foreign-source', 'recorded');
  native.close();
  fs.chmodSync(path.join(backup, 'sqlite/0/native.sqlite'), 0o600);
  const entry = (file: string) => {
    const bytes = fs.readFileSync(path.join(backup, file));
    return { file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  };
  const receipt = {
    format: 'cos-coordinated-backup/v1',
    operationId,
    contextDigest: 'a'.repeat(64),
    inputsDigest: 'b'.repeat(64),
    databaseFingerprint: 'd'.repeat(64),
    schemaVersion: SCHEMA_VERSION,
    schemaDigest: 'e'.repeat(64),
    barrierDigest: digest({
      generation: 7,
      activeWorkers: 0,
      activeOperations: 0,
      nativeWriters: 0,
      effectsEnabled: false,
    }),
    admissionRestored: false,
    journal: { installationDigest: 'f'.repeat(64), generation: 'fixture-generation' },
    remote: entry('remote.json'),
    sqlite: [entry('sqlite/0/native.sqlite')],
    artifacts: [],
    restrictions: [],
  } as CoordinatedBackupReceipt;
  foundation.backup.mockResolvedValue(receipt);
  foundation.verify.mockResolvedValue(receipt);
  const quiescent = vi.fn(async () => ({
    generation: 7,
    activeWorkers: 0 as const,
    activeOperations: 0 as const,
    nativeWriters: 0 as const,
    effectsEnabled: false as const,
  }));
  const base = {
    receiptRoot: root,
    operationId,
    context: { scopeId: 'scope' },
    quiescent,
  } as unknown as CoordinatedBackupOptions;
  const software: RecoverySoftware = {
    sourceCommit: '1'.repeat(40),
    sourceTree: '2'.repeat(40),
    hostPayloadSha256: '3'.repeat(64),
    schemaVersion: SCHEMA_VERSION,
    nativeSchemaVersion: 22,
  };
  return {
    root,
    base,
    software,
    receipt,
    options: {
      base,
      software,
      externalCheckpoint: { kind: 'application_scope_logical' as const, referenceDigest: receipt.remote.sha256 },
    },
  };
}
it('S11-T03/T05 a coordinated recovery manifest pairs software/schema/generation and scoped tombstones without credentials or revocation prose', async () => {
  const f = fixture(),
    manifest = await backupOperationsState(f.options);
  expect(manifest).toMatchObject({
    format: 'cos-operations-backup/v1',
    software: f.software,
    backupGeneration: 7,
    coordinatedDigest: digest(f.receipt),
    admissionRestored: false,
    effectsEnabled: false,
    serverBackupPolicy: 'not_verified',
  });
  expect(manifest.revocations).toEqual([{ sourceId: 'source', kind: 'revoke', version: 2 }]);
  expect(manifest.nativeDenials).toEqual([
    {
      ingressId: 'control',
      bindingDigest: 'a'.repeat(64),
      payloadDigest: 'b'.repeat(64),
      kind: 'revoke_source',
      target: 'source',
      state: 'reconciled',
    },
  ]);
  expect(JSON.stringify(manifest)).not.toContain('PRIVATE');
  expect(JSON.stringify(manifest)).not.toContain('foreign-source');
  expect(await verifyOperationsBackup(f.options)).toEqual(manifest);
});
it('S11-T03 mismatched software/schema, changed manifests and credential fields cannot become accepted recovery evidence', async () => {
  const f = fixture();
  await expect(
    backupOperationsState({ ...f.options, software: { ...f.software, schemaVersion: SCHEMA_VERSION + 1 } }),
  ).rejects.toThrow('operations_backup_unavailable');
  expect(foundation.backup).not.toHaveBeenCalled();
  await expect(
    backupOperationsState({
      ...f.options,
      software: { ...f.software, password: 'PRIVATE_SECRET' } as RecoverySoftware,
    }),
  ).rejects.toThrow('operations_backup_unavailable');
  const manifest = await backupOperationsState(f.options);
  await expect(
    verifyOperationsBackup({ ...f.options, software: { ...f.software, sourceCommit: '9'.repeat(40) } }),
  ).rejects.toThrow('operations_backup_verification_unavailable');
  fs.writeFileSync(
    path.join(f.root, 'backup-generation.operations.json'),
    JSON.stringify({ ...manifest, backupGeneration: 8 }),
    { mode: 0o600 },
  );
  await expect(verifyOperationsBackup(f.options)).rejects.toThrow('operations_backup_verification_unavailable');
});
it('S11-PG02 captures a new logical checkpoint without requiring its future checksum in advance', async () => {
  const f = fixture();
  const manifest = await backupOperationsState({
    ...f.options,
    externalCheckpoint: { kind: 'application_scope_logical' },
  });
  expect(manifest.externalCheckpoint).toEqual(f.options.externalCheckpoint);
  f.base.quiescent = vi.fn().mockRejectedValue(Error('PRIVATE_OFFLINE'));
  expect(
    await verifyOperationsBackup({ ...f.options, externalCheckpoint: { kind: 'application_scope_logical' } }),
  ).toEqual(manifest);
  expect(f.base.quiescent).not.toHaveBeenCalled();
});
it('S11-T03 rejects a changed maintenance generation and preserves an immutable published manifest on conflicting replay', async () => {
  const f = fixture(),
    first = await backupOperationsState(f.options),
    file = path.join(f.root, f.base.operationId + '.operations.json');
  const bytes = fs.readFileSync(file);
  f.base.quiescent = vi.fn(async () => ({
    generation: 8,
    activeWorkers: 0 as const,
    activeOperations: 0 as const,
    nativeWriters: 0 as const,
    effectsEnabled: false as const,
  }));
  await expect(backupOperationsState(f.options)).rejects.toThrow('operations_backup_unavailable');
  expect(fs.readFileSync(file)).toEqual(bytes);
  expect(await verifyOperationsBackup(f.options)).toEqual(first);
});
