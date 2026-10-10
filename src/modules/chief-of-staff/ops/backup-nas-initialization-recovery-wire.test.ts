import { randomUUID } from 'node:crypto';
import { PassThrough, Readable, Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { backupNasRecoveryScope } from './backup-nas-recovery-wire.js';
import { backupNasSetupScope, readBackupNasSetupRequest } from './backup-nas-setup-wire.js';
import {
  backupNasInitializationRecoveryScope,
  readBackupNasInitializationRecoveryRequest,
  writeBackupNasInitializationRecoveryRequest,
  type BackupNasInitializationRecoveryRequest,
} from './backup-nas-initialization-recovery-wire.js';
function fixture() {
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    installationRoot: '/home/fixture/app',
    dataRoot: '/home/fixture/app/data',
  };
  const vault = vaultRootConfiguration({
    contract: 'cos-vault-root-config/v2',
    authority: { operationId: randomUUID() },
    identity: {
      operationId: randomUUID(),
      targetDigest: digest(binding),
      recoveryReference: randomUUID(),
      luksUuid: randomUUID(),
      filesystemUuid: randomUUID(),
    },
    target: { binding, lifecycle: 'protected', minimumGeneration: 3 },
    owner: { uid: 1000, gid: 1000, home: '/home/fixture', targetRoot: '/home/fixture/state' },
    artifact: { sourceCommit: 'c'.repeat(40), sourceTree: 'd'.repeat(40), digest: 'e'.repeat(64) },
  });
  const nas = {
      contract: 'cos-backup-nas-root-config/v1' as const,
      host: '192.168.56.12',
      credentialReference: randomUUID(),
      vaultStateDigest: vaultRootStateDigest(vault),
    },
    operationId = randomUUID(),
    resource = { kind: 'closed-underlay' as const, device: 17, inode: 23 };
  const scope = {
    operationId,
    generation: 4,
    targetDigest: digest({
      contract: 'cos-backup-nas-recover-initialization-authority/v1',
      configurationDigest: digest(vault),
      nasDigest: digest(nas),
      resourceDigest: digest(resource),
    }),
  };
  const request: BackupNasInitializationRecoveryRequest = {
    contract: 'cos-backup-nas-recover-initialization-request/v1',
    configurationDigest: digest(vault),
    nas,
    resource,
    scope,
    authority: { socket: '/home/fixture/state/vault-authority/' + randomUUID() + '/proof.sock', token: 'f'.repeat(64) },
  };
  return { vault, nas, resource, operationId, request, memory: vi.fn() };
}
const frame = (value: unknown) => {
  const bytes = Buffer.from(JSON.stringify(value)),
    framed = Buffer.alloc(bytes.length + 4);
  framed.writeUInt32BE(bytes.length);
  bytes.copy(framed, 4);
  bytes.fill(0);
  return framed;
};
it('binds recovering one observed initialization resource to its exact destination and current source without granting installation or vault authority', () => {
  const f = fixture(),
    scope = backupNasInitializationRecoveryScope(f.vault, f.nas, f.resource, f.operationId, 4);
  expect(scope).toEqual(f.request.scope);
  expect(Object.isFrozen(scope)).toBe(true);
  expect(scope.targetDigest).not.toBe(backupNasSetupScope(f.vault, f.nas, f.operationId, 4).targetDigest);
  expect(scope.targetDigest).not.toBe(f.vault.identity.targetDigest);
  expect(
    backupNasInitializationRecoveryScope(
      f.vault,
      { ...f.nas, credentialReference: randomUUID() },
      f.resource,
      f.operationId,
      4,
    ).targetDigest,
  ).not.toBe(scope.targetDigest);
  expect(
    backupNasInitializationRecoveryScope(
      { ...f.vault, artifact: { ...f.vault.artifact, digest: '9'.repeat(64) } },
      f.nas,
      f.resource,
      f.operationId,
      4,
    ).targetDigest,
  ).not.toBe(scope.targetDigest);
});
it('carries only bounded private metadata through EOF, clears every buffer and keeps the live capability out of receipts', async () => {
  const f = fixture(),
    chunks: Buffer[] = [];
  let borrowed!: Buffer;
  await writeBackupNasInitializationRecoveryRequest(
    new Writable({
      write(bytes, _encoding, done) {
        borrowed = bytes;
        chunks.push(Buffer.from(bytes));
        done();
      },
    }),
    f.vault,
    f.request,
    { assertMemory: f.memory },
  );
  expect(borrowed.every((byte) => byte === 0)).toBe(true);
  const bytes = Buffer.concat(chunks),
    inputs = [Buffer.from(bytes.subarray(0, 2)), Buffer.from(bytes.subarray(2))];
  const result = await readBackupNasInitializationRecoveryRequest(Readable.from(inputs), f.vault, {
    assertMemory: f.memory,
  });
  expect(result.scope).toEqual(f.request.scope);
  expect(result.authority.token).toBe(f.request.authority.token);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.authority)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(f.request.authority.token);
  expect(inputs.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  const replay: Buffer[] = [];
  await writeBackupNasInitializationRecoveryRequest(
    new Writable({
      write(bytes, _encoding, done) {
        replay.push(Buffer.from(bytes));
        done();
      },
    }),
    f.vault,
    result,
    { assertMemory: f.memory },
  );
  expect(Buffer.concat(replay)).toEqual(bytes);
  await expect(
    readBackupNasSetupRequest(Readable.from([Buffer.from(bytes)]), f.vault, { assertMemory: f.memory }),
  ).rejects.toThrow(/^backup_nas_setup_transport_unavailable$/);
});
it.each([
  'setup-contract',
  'unmount-contract',
  'unmount-permission',
  'different-resource',
  'missing-resource',
  'resource-path',
  'setup-permission',
  'vault-permission',
  'different-source',
  'different-host',
  'different-reference',
  'stale-generation',
  'invalid-operation',
  'path-selector',
  'pid-selector',
  'plaintext-password',
  'socket-selector',
  'malformed-token',
])('denies %s before admitting recovery or emitting metadata', async (reason) => {
  const f = fixture(),
    value = JSON.parse(JSON.stringify(f.request));
  if (reason === 'unmount-contract') value.contract = 'cos-backup-nas-recover-unmount-request/v1';
  if (reason === 'unmount-permission') value.scope = backupNasRecoveryScope(f.vault, f.nas, f.operationId, 4);
  if (reason === 'different-resource') value.resource.inode = 24;
  if (reason === 'missing-resource') delete value.resource;
  if (reason === 'resource-path') value.resource.path = '/tmp/foreign';
  if (reason === 'setup-contract') value.contract = 'cos-backup-nas-setup-request/v1';
  if (reason === 'setup-permission') value.scope = backupNasSetupScope(f.vault, f.nas, f.operationId, 4);
  if (reason === 'vault-permission') value.scope.targetDigest = f.vault.identity.targetDigest;
  if (reason === 'different-source') value.configurationDigest = '0'.repeat(64);
  if (reason === 'different-host') value.nas.host = '192.168.56.13';
  if (reason === 'different-reference') value.nas.credentialReference = randomUUID();
  if (reason === 'stale-generation') value.scope.generation = 2;
  if (reason === 'invalid-operation') value.scope.operationId = 'not-an-operation';
  if (reason === 'path-selector') value.root = '/tmp/foreign';
  if (reason === 'pid-selector') value.pid = 123;
  if (reason === 'plaintext-password') value.password = 'PRIVATE_PASSWORD';
  if (reason === 'socket-selector') value.authority.socket = '/home/fixture/../root/proof.sock';
  if (reason === 'malformed-token') value.authority.token = 'PRIVATE_TOKEN';
  const input = frame(value),
    writes = vi.fn((_bytes, _encoding, done) => done());
  await expect(
    readBackupNasInitializationRecoveryRequest(Readable.from([input]), f.vault, { assertMemory: f.memory }),
  ).rejects.toThrow(/^backup_nas_initialization_recovery_transport_unavailable$/);
  expect(input.every((byte) => byte === 0)).toBe(true);
  await expect(
    writeBackupNasInitializationRecoveryRequest(new Writable({ write: writes }), f.vault, value, {
      assertMemory: f.memory,
    }),
  ).rejects.toThrow(/^backup_nas_initialization_recovery_transport_unavailable$/);
  expect(writes).not.toHaveBeenCalled();
});
it.each(['extra', 'truncated', 'oversized', 'memory'])(
  'denies %s framing and clears the received bytes',
  async (reason) => {
    const f = fixture();
    let bytes = frame(f.request);
    if (reason === 'extra') bytes = Buffer.concat([bytes, Buffer.from([1])]);
    if (reason === 'truncated') bytes = Buffer.from(bytes.subarray(0, bytes.length - 1));
    if (reason === 'oversized') {
      bytes = Buffer.alloc(4);
      bytes.writeUInt32BE(4097);
    }
    if (reason === 'memory')
      f.memory
        .mockImplementationOnce(() => {})
        .mockImplementation(() => {
          throw Error('PRIVATE_MEMORY');
        });
    const stream = Readable.from([bytes]);
    await expect(
      readBackupNasInitializationRecoveryRequest(stream, f.vault, { assertMemory: f.memory }),
    ).rejects.toThrow(/^backup_nas_initialization_recovery_transport_unavailable$/);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    expect(stream.destroyed).toBe(true);
  },
);
it('refuses stalled metadata even after a complete frame until EOF is observed', async () => {
  const f = fixture(),
    stream = new PassThrough();
  stream.write(frame(f.request));
  await expect(
    readBackupNasInitializationRecoveryRequest(stream, f.vault, { assertMemory: f.memory, deadlineMs: 15 }),
  ).rejects.toThrow(/^backup_nas_initialization_recovery_transport_unavailable$/);
  expect(stream.destroyed).toBe(true);
});
