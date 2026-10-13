import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { SCHEMA_VERSION } from '../store/migrations.js';
import type { CoordinatedBackupOptions, CoordinatedBackupReceipt } from './coordinated-backup.js';
import { captureOperationsState, verifyRecoveredOperationsState, type RecoverySoftware } from './recovery-manifest.js';
import { withIsolatedBackupRestore } from './backup-restore-workspace.js';
import { ActionWitness, initializeActionWitness } from '../actions/witness.js';
const f = vi.hoisted(() => ({ capture: vi.fn(), legacy: vi.fn(), recovered: vi.fn(), current: vi.fn() }));
vi.mock('./coordinated-backup.js', () => ({
  captureCoordinatedState: f.capture,
  backupCoordinatedState: f.legacy,
  verifyCoordinatedBackup: f.legacy,
  verifyRecoveredCoordinatedState: f.recovered,
  assertCoordinatedRecoveryIdentity: f.current,
}));
const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-recovery-capture-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const snapshot = {
    format: 'cos-scoped-checkpoint/v1',
    scopeId: 'scope',
    schemaVersion: SCHEMA_VERSION,
    schemaDigest: 'e'.repeat(64),
    databaseFingerprint: 'd'.repeat(64),
    at: '2026-10-11T00:00:00.000Z',
    rows: {
      revocation_tombstones: [
        { scope_id: 'scope', source_id: 'source', kind: 'revoke', version: 2, private_prose: 'PRIVATE_SOURCE_PROSE' },
      ],
    },
  };
  const db = new Database(':memory:');
  db.exec('CREATE TABLE cos_operator_denials(scope_id,ingress_id,binding_digest,payload_digest,kind,target,state)');
  db.prepare('INSERT INTO cos_operator_denials VALUES(?,?,?,?,?,?,?)').run(
    'scope',
    'control',
    'a'.repeat(64),
    'b'.repeat(64),
    'revoke_source',
    'source',
    'recorded',
  );
  db.prepare('INSERT INTO cos_operator_denials VALUES(?,?,?,?,?,?,?)').run(
    'foreign',
    'foreign',
    'a'.repeat(64),
    'b'.repeat(64),
    'revoke_source',
    'foreign',
    'recorded',
  );
  const native = db.serialize();
  db.close();
  const remote = Buffer.from(JSON.stringify(snapshot) + '\n');
  const entry = (file: string, bytes: Buffer) => ({
    file,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  let generation = 7;
  const base = {
    receiptRoot: root,
    operationId: 'capture-fixture',
    context: { scopeId: 'scope' },
    quiescent: async () => ({
      generation,
      activeWorkers: 0,
      activeOperations: 0,
      nativeWriters: 0,
      effectsEnabled: false,
    }),
  } as unknown as CoordinatedBackupOptions;
  const software: RecoverySoftware = {
    sourceCommit: '1'.repeat(40),
    sourceTree: '2'.repeat(40),
    hostPayloadSha256: '3'.repeat(64),
    schemaVersion: SCHEMA_VERSION,
    nativeSchemaVersion: 22,
  };
  const receipt: CoordinatedBackupReceipt = {
    format: 'cos-coordinated-backup/v1',
    operationId: base.operationId,
    contextDigest: 'a'.repeat(64),
    inputsDigest: 'b'.repeat(64),
    databaseFingerprint: 'd'.repeat(64),
    schemaVersion: SCHEMA_VERSION,
    schemaDigest: 'e'.repeat(64),
    barrierDigest: digest({
      generation,
      activeWorkers: 0,
      activeOperations: 0,
      nativeWriters: 0,
      effectsEnabled: false,
    }),
    admissionRestored: false,
    journal: { installationDigest: 'f'.repeat(64), generation: 'fixture' },
    remote: entry('remote.json', remote),
    sqlite: [entry('sqlite/0/native.sqlite', native)],
    artifacts: [],
    restrictions: [],
  };
  const emit = (sink: { write(name: string, bytes: Buffer): void }) => {
    sink.write('coordinated/remote.json', remote);
    sink.write('coordinated/sqlite/0/native.sqlite', native);
  };
  f.capture.mockImplementation(async (_base, sink) => {
    emit(sink);
    return receipt;
  });
  const output = new Map<string, Buffer>();
  const sink = { write: (name: string, bytes: Buffer) => output.set(name, Buffer.from(bytes)) };
  return {
    root,
    base,
    software,
    snapshot,
    remote,
    native,
    receipt,
    emit,
    sink,
    output,
    changeEpoch: () => {
      generation++;
    },
    options: { base, software, externalCheckpoint: { kind: 'application_scope_logical' as const } },
  };
}
it('captures a portable recovery manifest directly with the exact streamed database snapshots', async () => {
  const s = fixture(),
    result = await captureOperationsState(s.options, s.sink);
  expect(result.checkpoint).toEqual(s.receipt);
  expect(result.operations).toMatchObject({
    format: 'cos-operations-backup/v1',
    backupGeneration: 7,
    coordinatedDigest: digest(s.receipt),
    admissionRestored: false,
    effectsEnabled: false,
  });
  expect(result.operations.revocations).toEqual([{ sourceId: 'source', kind: 'revoke', version: 2 }]);
  expect(result.operations.nativeDenials).toHaveLength(1);
  const bytes = s.output.get('capture-fixture.operations.json')!;
  expect(JSON.parse(bytes.toString())).toEqual(result.operations);
  expect(bytes.toString()).not.toContain('PRIVATE_SOURCE_PROSE');
  expect(bytes.toString()).not.toContain('foreign');
  expect(fs.readdirSync(s.root)).toEqual([]);
  expect(f.legacy).not.toHaveBeenCalled();
});
async function recoverFixture(change?: (s: ReturnType<typeof fixture>) => void, guard: () => void = () => {}) {
  const s = fixture(),
    capture = await captureOperationsState(s.options, s.sink);
  const owner = initializeActionWitness(s.root + '/live-journal', 'f'.repeat(64));
  s.options.base = {
    ...s.base,
    databaseFingerprint: s.receipt.databaseFingerprint,
    nativeDatabases: [s.root + '/live-native.db'],
    restrictionFiles: [],
    artifacts: { root: s.root + '/live-artifacts' } as CoordinatedBackupOptions['artifacts'],
    witness: new ActionWitness(s.root + '/live-journal', 'f'.repeat(64), owner.generation),
  };
  change?.(s);
  f.recovered.mockReturnValue({
    receipt: s.receipt,
    checkpoint: s.snapshot,
    nativeDatabasesVerified: 1,
    admissionRestored: false,
    eventJournalRestored: false,
  });
  const stage = s.root + '/isolated-stage';
  fs.mkdirSync(stage, { mode: 0o700 });
  const fd = fs.openSync(stage, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let error: unknown;
  try {
    const result = await withIsolatedBackupRestore(
      '/proc/self/fd/' + fd,
      '5f74b367-fd8f-449c-a832-dbe40cff9ae3',
      262144,
      guard,
      async (scope) => {
        const entries = [];
        for (const [name, bytes] of s.output) {
          const file = await scope.sink.open(name, bytes.length);
          for (let i = 0; i < bytes.length; i += 65536) await file.write(bytes.subarray(i, i + 65536));
          await file.close();
          entries.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        }
        try {
          return await verifyRecoveredOperationsState(s.options, scope, entries, 7);
        } catch (caught) {
          error = caught;
          throw caught;
        }
      },
    );
    return { s, capture, result, stage };
  } catch (caught) {
    if (error) throw error;
    throw caught;
  } finally {
    fs.closeSync(fd);
  }
}
it('recomputes recovery instructions from owned recovered bytes without importing native denials or tombstones', async () => {
  const { s, capture, result, stage } = await recoverFixture();
  expect(result.operations).toEqual(capture.operations);
  expect(result.operations.nativeDenials).toHaveLength(1);
  expect(result.operations.revocations).toEqual([{ sourceId: 'source', kind: 'revoke', version: 2 }]);
  expect(result.operations.effectsEnabled).toBe(false);
  expect(result.operations.admissionRestored).toBe(false);
  expect(JSON.stringify(result.operations)).not.toContain('PRIVATE_SOURCE_PROSE');
  expect(JSON.stringify(result.operations)).not.toContain('foreign');
  expect(fs.readdirSync(stage)).toEqual([]);
  expect(f.legacy).not.toHaveBeenCalled();
  expect(s.output.has('capture-fixture.operations.json')).toBe(true);
});
it.each([
  'revocations',
  'denials',
  'software',
  'generation',
  'admission',
  'effects',
  'external-checkpoint',
  'unknown-field',
])('refuses altered recovery instructions %s even when authenticated as archive bytes', async (reason) => {
  await expect(
    recoverFixture((s) => {
      const file = 'capture-fixture.operations.json',
        value = JSON.parse(s.output.get(file)!.toString());
      if (reason === 'revocations') value.revocations = [];
      if (reason === 'denials') value.nativeDenials = [];
      if (reason === 'software') value.software.sourceCommit = '9'.repeat(40);
      if (reason === 'generation') value.backupGeneration = 8;
      if (reason === 'admission') value.admissionRestored = true;
      if (reason === 'effects') value.effectsEnabled = true;
      if (reason === 'external-checkpoint') value.externalCheckpoint.referenceDigest = '9'.repeat(64);
      if (reason === 'unknown-field') value.activateCredential = true;
      s.output.set(file, Buffer.from(JSON.stringify(value) + '\n'));
    }),
  ).rejects.toThrow(/^operations_recovery_check_unavailable$/);
});
it('refuses a coordinated receipt changed while its native recovery projection is awaited', async () => {
  let fired = false;
  await expect(
    recoverFixture(undefined, () => {
      if (!fired && f.recovered.mock.results.length) {
        fired = true;
        const proof = f.recovered.mock.results.at(-1)!.value;
        proof.receipt.contextDigest = '0'.repeat(64);
      }
    }),
  ).rejects.toThrow(/^operations_recovery_check_unavailable$/);
});
it('refreshes independent journal admission after the recovery projection is awaited', async () => {
  let queued = false;
  await expect(
    recoverFixture(undefined, () => {
      if (!queued && f.recovered.mock.results.length) {
        queued = true;
        queueMicrotask(() => {
          f.current.mockImplementation(() => {
            throw Error('PRIVATE_JOURNAL_CHANGED');
          });
        });
      }
    }),
  ).rejects.toThrow(/^operations_recovery_check_unavailable$/);
});
it('rejects missing and mismatched native snapshot bytes before publishing recovery metadata', async () => {
  const s = fixture();
  for (const mode of ['missing', 'changed']) {
    f.capture.mockImplementation(async (_base, sink) => {
      sink.write('coordinated/remote.json', s.remote);
      if (mode === 'changed') sink.write('coordinated/sqlite/0/native.sqlite', s.native);
      return { ...s.receipt, sqlite: [{ ...s.receipt.sqlite[0], sha256: '0'.repeat(64) }] };
    });
    await expect(captureOperationsState(s.options, s.sink)).rejects.toThrow('operations_capture_unavailable');
    expect(s.output.has('capture-fixture.operations.json')).toBe(false);
  }
});
it('rejects duplicate captured database channels', async () => {
  const s = fixture();
  f.capture.mockImplementation(async (_base, sink) => {
    s.emit(sink);
    sink.write('coordinated/remote.json', s.remote);
    return s.receipt;
  });
  await expect(captureOperationsState(s.options, s.sink)).rejects.toThrow('operations_capture_unavailable');
});
it('refuses a foreign scope or a changed remote snapshot hash', async () => {
  const s = fixture();
  f.capture.mockImplementation(async (_base, sink) => {
    sink.write('coordinated/remote.json', Buffer.from(JSON.stringify({ ...s.snapshot, scopeId: 'foreign' })));
    sink.write('coordinated/sqlite/0/native.sqlite', s.native);
    return s.receipt;
  });
  await expect(captureOperationsState(s.options, s.sink)).rejects.toThrow('operations_capture_unavailable');
  f.capture.mockImplementation(async (_base, sink) => {
    s.emit(sink);
    return { ...s.receipt, remote: { ...s.receipt.remote, sha256: '0'.repeat(64) } };
  });
  await expect(captureOperationsState(s.options, s.sink)).rejects.toThrow('operations_capture_unavailable');
});
it('refuses a changed quiescence epoch and leaves captured bytes as incomplete evidence', async () => {
  const s = fixture();
  f.capture.mockImplementation(async (_base, sink) => {
    s.emit(sink);
    s.changeEpoch();
    return s.receipt;
  });
  await expect(captureOperationsState(s.options, s.sink)).rejects.toThrow('operations_capture_unavailable');
  expect(s.output.has('capture-fixture.operations.json')).toBe(false);
});
it('checks the epoch after publishing and never acknowledges a revoked capture', async () => {
  const s = fixture();
  await expect(
    captureOperationsState(s.options, {
      write(name, bytes) {
        s.sink.write(name, bytes);
        if (name.endsWith('.operations.json')) s.changeEpoch();
      },
    }),
  ).rejects.toThrow('operations_capture_unavailable');
});
it('refuses incompatible software before reading snapshot data', async () => {
  const s = fixture();
  await expect(
    captureOperationsState({ ...s.options, software: { ...s.software, schemaVersion: SCHEMA_VERSION + 1 } }, s.sink),
  ).rejects.toThrow('operations_capture_unavailable');
  expect(f.capture).not.toHaveBeenCalled();
});
it('closes an invalid SQLite snapshot and hides sink diagnostics', async () => {
  const s = fixture();
  f.capture.mockImplementation(async (_base, sink) => {
    sink.write('coordinated/sqlite/0/native.sqlite', Buffer.from('PRIVATE_INVALID_DATABASE'));
    return s.receipt;
  });
  await expect(captureOperationsState(s.options, s.sink)).rejects.toThrow('operations_capture_unavailable');
  f.capture.mockImplementation(async (_base, sink) => {
    s.emit(sink);
    return s.receipt;
  });
  await expect(
    captureOperationsState(s.options, {
      write() {
        throw Error('PRIVATE_SINK_DIAGNOSTIC');
      },
    }),
  ).rejects.toThrow('operations_capture_unavailable');
});
it('refuses changed recovery software while the producer is awaited', async () => {
  const s = fixture();
  f.capture.mockImplementation(async (_base, sink) => {
    s.emit(sink);
    s.options.software.sourceCommit = '9'.repeat(40);
    return s.receipt;
  });
  await expect(captureOperationsState(s.options, s.sink)).rejects.toThrow('operations_capture_unavailable');
  expect(s.output.has('capture-fixture.operations.json')).toBe(false);
});
it('retains the original quiescent epoch even when a caller reuses a mutable observation', async () => {
  const s = fixture();
  const shared = {
    generation: 7,
    activeWorkers: 0 as const,
    activeOperations: 0 as const,
    nativeWriters: 0 as const,
    effectsEnabled: false as const,
  };
  s.base.quiescent = async () => shared;
  f.capture.mockImplementation(async (_base, sink) => {
    s.emit(sink);
    shared.generation++;
    return { ...s.receipt, barrierDigest: digest(shared) };
  });
  await expect(captureOperationsState(s.options, s.sink)).rejects.toThrow('operations_capture_unavailable');
  expect(s.output.has('capture-fixture.operations.json')).toBe(false);
});
