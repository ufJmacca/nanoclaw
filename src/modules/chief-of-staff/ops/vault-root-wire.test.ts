import { PassThrough, Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { readVaultRootRequest, writeVaultRootRequest, type VaultRootHeader } from './vault-root-wire.js';
function header(): VaultRootHeader {
  const operationId = randomUUID(),
    targetDigest = 'a'.repeat(64);
  return {
    contract: 'cos-vault-root-request/v1',
    configurationDigest: 'b'.repeat(64),
    identity: {
      operationId,
      targetDigest,
      recoveryReference: randomUUID(),
      luksUuid: randomUUID(),
      filesystemUuid: randomUUID(),
    },
    scope: { operationId: randomUUID(), targetDigest, generation: 1 },
    authority: { socket: '/private/owner/authority.sock', token: 'c'.repeat(64) },
  };
}
function frame(value: unknown, key = Buffer.alloc(64, 87)) {
  const text = Buffer.from(JSON.stringify(value)),
    prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(text.length);
  return Buffer.concat([prefix, text, key]);
}
it('frames binary recovery bytes through a private stream, verifies memory before reads and zeros received chunks', async () => {
  const value = header(),
    key = Buffer.alloc(64, 97),
    memory = vi.fn(),
    chunks: Buffer[] = [];
  // A real pipe copies written bytes. This sink models that ownership transfer rather than sharing the sender's buffers.
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await writeVaultRootRequest(stream, value, key, { assertMemory: memory });
  const result = await readVaultRootRequest(Readable.from(chunks), { assertMemory: memory });
  expect(result.header.identity).toEqual(value.identity);
  expect(result.header.scope).toEqual(value.scope);
  expect(result.header.configurationDigest).toBe(value.configurationDigest);
  expect(result.header.authority.socket).toBe(value.authority.socket);
  expect(result.header.authority.token).toBe(value.authority.token);
  expect(result.recovery.equals(key)).toBe(true);
  expect(memory.mock.calls.length).toBeGreaterThan(3);
  result.recovery.fill(0);
  const bytes = frame(value);
  const split = [bytes.subarray(0, 2), bytes.subarray(2, 17), bytes.subarray(17)];
  const decoded = await readVaultRootRequest(Readable.from(split), { assertMemory: () => {} });
  expect(decoded.recovery).toEqual(Buffer.alloc(64, 87));
  expect(bytes.every((byte) => byte === 0)).toBe(true);
  decoded.recovery.fill(0);
});
it.each([
  'truncated-prefix',
  'oversize-header',
  'truncated-key',
  'extra-bytes',
  'bad-json',
  'extra-command',
  'foreign-scope',
  'bad-token',
  'bad-socket',
  'bad-uuid',
])('denies %s without exposing transport data', async (reason) => {
  const value = header();
  let bytes = frame(value);
  if (reason === 'truncated-prefix') bytes = Buffer.alloc(3);
  if (reason === 'oversize-header') {
    bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(4097);
  }
  if (reason === 'truncated-key') bytes = bytes.subarray(0, bytes.length - 1);
  if (reason === 'extra-bytes') bytes = Buffer.concat([bytes, Buffer.from('PRIVATE_EXTRA')]);
  if (reason === 'bad-json') {
    bytes = Buffer.alloc(69, 99);
    bytes.writeUInt32BE(1);
  }
  if (reason === 'extra-command') bytes = frame({ ...value, command: 'PRIVATE_COMMAND' });
  if (reason === 'foreign-scope') bytes = frame({ ...value, scope: { ...value.scope, targetDigest: 'd'.repeat(64) } });
  if (reason === 'bad-token') bytes = frame({ ...value, authority: { ...value.authority, token: 'PRIVATE_TOKEN' } });
  if (reason === 'bad-socket')
    bytes = frame({ ...value, authority: { ...value.authority, socket: '/private/../foreign.sock' } });
  if (reason === 'bad-uuid') bytes = frame({ ...value, identity: { ...value.identity, luksUuid: 'PRIVATE_UUID' } });
  await expect(readVaultRootRequest(Readable.from([bytes]), { assertMemory: () => {} })).rejects.toThrow(
    'vault_root_transport_unavailable',
  );
  expect(bytes.every((byte) => byte === 0)).toBe(true);
});
it('denies memory failure before consuming a secret stream or writing any request bytes', async () => {
  const memory = () => {
      throw Error('PRIVATE_MEMORY');
    },
    stream = new PassThrough();
  await expect(readVaultRootRequest(stream, { assertMemory: memory })).rejects.toThrow(
    'vault_root_transport_unavailable',
  );
  await expect(writeVaultRootRequest(stream, header(), Buffer.alloc(64), { assertMemory: memory })).rejects.toThrow(
    'vault_root_transport_unavailable',
  );
  expect(stream.readableLength).toBe(0);
  stream.destroy();
});
it('closes a stalled private stream at its bounded deadline', async () => {
  const stream = new PassThrough();
  await expect(readVaultRootRequest(stream, { assertMemory: () => {}, deadlineMs: 10 })).rejects.toThrow(
    'vault_root_transport_unavailable',
  );
  expect(stream.destroyed).toBe(true);
});
it('excludes received recovery bytes and the live capability from accidental receipt serialization', async () => {
  const value = header();
  const result = await readVaultRootRequest(Readable.from([frame(value)]), { assertMemory: () => {} });
  expect(JSON.stringify(result)).not.toContain('"recovery"');
  expect(JSON.stringify(result)).not.toContain(value.authority.token);
  expect(result.header.authority.token).toBe(value.authority.token);
  expect(result.recovery).toEqual(Buffer.alloc(64, 87));
  result.recovery.fill(0);
});
