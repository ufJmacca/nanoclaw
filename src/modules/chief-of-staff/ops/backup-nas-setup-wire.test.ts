import { randomUUID } from 'node:crypto';
import { PassThrough, Readable, Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import {
  backupNasSetupScope,
  readBackupNasSetupRequest,
  writeBackupNasSetupRequest,
  type BackupNasSetupRequest,
} from './backup-nas-setup-wire.js';
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
    operationId = randomUUID();
  // Independently encoded expected scope: a vault-only permission must not authorize NAS setup.
  const scope = {
    operationId,
    generation: 4,
    targetDigest: digest({
      contract: 'cos-backup-nas-setup-authority/v1',
      configurationDigest: digest(vault),
      nasDigest: digest(nas),
    }),
  };
  const request: BackupNasSetupRequest = {
    contract: 'cos-backup-nas-setup-request/v1',
    configurationDigest: digest(vault),
    nas,
    scope,
    authority: { socket: '/home/fixture/state/vault-authority/' + randomUUID() + '/proof.sock', token: 'f'.repeat(64) },
  };
  return { vault, nas, operationId, request, memory: vi.fn() };
}
const frame = (value: unknown) => {
  const bytes = Buffer.from(JSON.stringify(value)),
    framed = Buffer.alloc(bytes.length + 4);
  framed.writeUInt32BE(bytes.length);
  bytes.copy(framed, 4);
  return framed;
};
it('binds a fresh setup scope to the complete installed vault configuration and the exact NAS selection', () => {
  const f = fixture(),
    scope = backupNasSetupScope(f.vault, f.nas, f.operationId, 4);
  expect(scope).toEqual(f.request.scope);
  expect(Object.isFrozen(scope)).toBe(true);
  expect(scope.targetDigest).not.toBe(f.vault.identity.targetDigest);
  expect(backupNasSetupScope(f.vault, { ...f.nas, host: '192.168.56.13' }, f.operationId, 4).targetDigest).not.toBe(
    scope.targetDigest,
  );
  expect(
    backupNasSetupScope(
      { ...f.vault, artifact: { ...f.vault.artifact, digest: '9'.repeat(64) } },
      f.nas,
      f.operationId,
      4,
    ).targetDigest,
  ).not.toBe(scope.targetDigest);
});
it('writes one bounded private frame and reads it across chunk boundaries, wiping input buffers and hiding the capability', async () => {
  const f = fixture(),
    chunks: Buffer[] = [];
  const output = new Writable({
    write(bytes, _encoding, done) {
      chunks.push(Buffer.from(bytes));
      done();
    },
  });
  await writeBackupNasSetupRequest(output, f.vault, f.request, { assertMemory: f.memory });
  const bytes = Buffer.concat(chunks);
  expect(bytes.length).toBeLessThanOrEqual(4100);
  const inputs = [Buffer.from(bytes.subarray(0, 2)), Buffer.from(bytes.subarray(2, 9)), Buffer.from(bytes.subarray(9))];
  const request = await readBackupNasSetupRequest(Readable.from(inputs), f.vault, { assertMemory: f.memory });
  expect(request.scope).toEqual(f.request.scope);
  expect(request.nas).toEqual(f.nas);
  expect(request.authority.token).toBe(f.request.authority.token);
  expect(JSON.stringify(request)).not.toContain(f.request.authority.token);
  expect(Object.isFrozen(request)).toBe(true);
  expect(Object.isFrozen(request.authority)).toBe(true);
  expect(inputs.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  const replay: Buffer[] = [];
  await writeBackupNasSetupRequest(
    new Writable({
      write(bytes, _encoding, done) {
        replay.push(Buffer.from(bytes));
        done();
      },
    }),
    f.vault,
    request,
    { assertMemory: f.memory },
  );
  expect(Buffer.concat(replay)).toEqual(bytes);
});
it.each([
  'vault-only',
  'configuration',
  'nas-host',
  'nas-reference',
  'nas-vault',
  'generation',
  'operation',
  'selector',
  'socket-relative',
  'socket-linked',
  'socket-length',
  'token',
  'recovery',
])('refuses request %s before accepting metadata or emitting any bytes', async (reason) => {
  const f = fixture(),
    value = JSON.parse(JSON.stringify(f.request));
  if (reason === 'vault-only') value.scope.targetDigest = f.vault.identity.targetDigest;
  if (reason === 'configuration') value.configurationDigest = '0'.repeat(64);
  if (reason === 'nas-host') value.nas.host = '192.168.56.13';
  if (reason === 'nas-reference') value.nas.credentialReference = randomUUID();
  if (reason === 'nas-vault') value.nas.vaultStateDigest = '0'.repeat(64);
  if (reason === 'generation') value.scope.generation = 2;
  if (reason === 'operation') value.scope.operationId = 'not-an-operation';
  if (reason === 'selector') value.root = '/tmp/foreign';
  if (reason === 'socket-relative') value.authority.socket = 'proof.sock';
  if (reason === 'socket-linked') value.authority.socket = '/home/fixture/../root/proof.sock';
  if (reason === 'socket-length') value.authority.socket = '/' + 'a'.repeat(100);
  if (reason === 'token') value.authority.token = 'PRIVATE_TOKEN';
  if (reason === 'recovery') value.recovery = 'PRIVATE_RECOVERY';
  const inputs = frame(value),
    writes = vi.fn((_bytes, _encoding, done) => done());
  await expect(readBackupNasSetupRequest(Readable.from([inputs]), f.vault, { assertMemory: f.memory })).rejects.toThrow(
    /^backup_nas_setup_transport_unavailable$/,
  );
  expect(inputs.every((byte) => byte === 0)).toBe(true);
  await expect(
    writeBackupNasSetupRequest(new Writable({ write: writes }), f.vault, value, { assertMemory: f.memory }),
  ).rejects.toThrow(/^backup_nas_setup_transport_unavailable$/);
  expect(writes).not.toHaveBeenCalled();
});
it.each(['empty', 'truncated', 'extra', 'oversized', 'zero', 'string', 'memory'])(
  'refuses %s transport and wipes every received buffer',
  async (reason) => {
    const f = fixture();
    let bytes = frame(f.request);
    if (reason === 'empty') bytes = Buffer.alloc(0);
    if (reason === 'truncated') bytes = Buffer.from(bytes.subarray(0, bytes.length - 1));
    if (reason === 'extra') bytes = Buffer.concat([bytes, Buffer.from([1])]);
    if (reason === 'oversized') {
      bytes = Buffer.alloc(4);
      bytes.writeUInt32BE(4097);
    }
    if (reason === 'zero') bytes = Buffer.alloc(4);
    if (reason === 'memory')
      f.memory
        .mockImplementationOnce(() => {})
        .mockImplementation(() => {
          throw Error('PRIVATE_MEMORY');
        });
    const stream = Readable.from([reason === 'string' ? 'PRIVATE_CAPABILITY' : bytes]);
    await expect(readBackupNasSetupRequest(stream, f.vault, { assertMemory: f.memory })).rejects.toThrow(
      /^backup_nas_setup_transport_unavailable$/,
    );
    expect(stream.destroyed).toBe(true);
    if (reason !== 'string') expect(bytes.every((byte) => byte === 0)).toBe(true);
  },
);
it('requires EOF and denies stalled input at the bounded deadline', async () => {
  const f = fixture(),
    stream = new PassThrough();
  stream.write(frame(f.request));
  await expect(readBackupNasSetupRequest(stream, f.vault, { assertMemory: f.memory, deadlineMs: 15 })).rejects.toThrow(
    /^backup_nas_setup_transport_unavailable$/,
  );
  expect(stream.destroyed).toBe(true);
});
it('redacts write errors and does not keep its frame live after write acknowledgement', async () => {
  const f = fixture();
  let observed!: Buffer;
  const stream = new Writable({
    write(bytes, _encoding, done) {
      observed = bytes;
      done(Error('PRIVATE_SOCKET_OR_TOKEN'));
    },
  });
  stream.on('error', () => {});
  await expect(writeBackupNasSetupRequest(stream, f.vault, f.request, { assertMemory: f.memory })).rejects.toThrow(
    /^backup_nas_setup_transport_unavailable$/,
  );
  expect(observed.every((byte) => byte === 0)).toBe(true);
});
