import { Readable, Writable, PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { digest } from '../domain/contracts.js';
import { readVaultInstallRequest, writeVaultInstallRequest } from './vault-install-wire.js';
function request() {
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    installationRoot: '/home/fixture/app',
    dataRoot: '/home/fixture/app/data',
  };
  return {
    contract: 'cos-vault-root-install-request/v1' as const,
    releaseId: 'release-cccccccccccc-20261008000000',
    configuration: {
      contract: 'cos-vault-root-config/v2' as const,
      authority: { operationId: randomUUID() },
      identity: {
        operationId: randomUUID(),
        targetDigest: digest(binding),
        recoveryReference: randomUUID(),
        luksUuid: randomUUID(),
        filesystemUuid: randomUUID(),
      },
      target: { binding, lifecycle: 'protected' as const, minimumGeneration: 3 },
      owner: { uid: 1000, gid: 1000, home: '/home/fixture', targetRoot: '/home/fixture/.config/nanoclaw-cos/state' },
      artifact: { sourceCommit: 'c'.repeat(40), sourceTree: 'd'.repeat(40), digest: 'e'.repeat(64) },
    },
    authority: { socket: '/home/fixture/private/proof.sock', token: 'f'.repeat(64) },
  };
}
function frame(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value)),
    prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
}
it('carries only bounded private installation metadata, clears chunks and excludes the capability from receipts', async () => {
  const value = request(),
    chunks: Buffer[] = [];
  const sink = new Writable({
    write(bytes, _encoding, done) {
      chunks.push(Buffer.from(bytes));
      done();
    },
  });
  await writeVaultInstallRequest(sink, value, { assertMemory() {} });
  const result = await readVaultInstallRequest(Readable.from(chunks), { assertMemory() {} });
  expect(result.configuration).toEqual(value.configuration);
  expect(result.authority.token).toBe(value.authority.token);
  expect(JSON.stringify(result)).not.toContain(value.authority.token);
  expect(Object.isFrozen(result.configuration.authority)).toBe(true);
  expect(chunks.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
});
it.each(['command', 'release', 'legacy-config', 'token', 'socket', 'truncated', 'extra', 'oversize'])(
  'denies %s installation input with one fixed error',
  async (reason) => {
    const value = request();
    let bytes = frame(value);
    if (reason === 'command') bytes = frame({ ...value, command: 'PRIVATE_COMMAND' });
    if (reason === 'release') bytes = frame({ ...value, releaseId: '../foreign' });
    if (reason === 'legacy-config')
      bytes = frame({ ...value, configuration: { ...value.configuration, contract: 'cos-vault-root-config/v1' } });
    if (reason === 'token') bytes = frame({ ...value, authority: { ...value.authority, token: 'PRIVATE_CAPABILITY' } });
    if (reason === 'socket')
      bytes = frame({ ...value, authority: { ...value.authority, socket: '/home/fixture/../foreign.sock' } });
    if (reason === 'truncated') bytes = bytes.subarray(0, bytes.length - 1);
    if (reason === 'extra') bytes = Buffer.concat([bytes, Buffer.from('PRIVATE_EXTRA')]);
    if (reason === 'oversize') {
      bytes = Buffer.alloc(4);
      bytes.writeUInt32BE(16385);
    }
    await expect(readVaultInstallRequest(Readable.from([bytes]), { assertMemory() {} })).rejects.toThrow(
      'vault_install_transport_unavailable',
    );
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  },
);
it('closes a stalled private metadata pipe at its bounded deadline', async () => {
  const stream = new PassThrough();
  await expect(readVaultInstallRequest(stream, { assertMemory() {}, deadlineMs: 10 })).rejects.toThrow(
    'vault_install_transport_unavailable',
  );
  expect(stream.destroyed).toBe(true);
});
it('checks memory before consuming or writing metadata', async () => {
  const stream = new PassThrough(),
    controls = {
      assertMemory() {
        throw Error('PRIVATE_MEMORY');
      },
    };
  await expect(readVaultInstallRequest(stream, controls)).rejects.toThrow('vault_install_transport_unavailable');
  await expect(writeVaultInstallRequest(stream, request(), controls)).rejects.toThrow(
    'vault_install_transport_unavailable',
  );
  expect(stream.readableLength).toBe(0);
});
