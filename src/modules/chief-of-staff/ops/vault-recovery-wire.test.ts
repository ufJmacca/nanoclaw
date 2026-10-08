import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { readVaultRecoveryKey } from './vault-recovery-wire.js';
it('consumes exactly 64 binary bytes and clears received chunks', async () => {
  const chunks = [Buffer.alloc(20, 7), Buffer.alloc(44, 8)];
  const key = await readVaultRecoveryKey(Readable.from(chunks), { assertMemory() {} });
  expect(key.subarray(0, 20).every((byte) => byte === 7)).toBe(true);
  expect(key.subarray(20).every((byte) => byte === 8)).toBe(true);
  expect(chunks.every((chunk) => chunk.every((byte) => byte === 0))).toBe(true);
  key.fill(0);
});
it.each([0, 63, 65, 1024])('denies %i recovery bytes and clears input', async (length) => {
  const chunk = Buffer.alloc(length, 9);
  await expect(readVaultRecoveryKey(Readable.from([chunk]), { assertMemory() {} })).rejects.toThrow(
    'vault_recovery_transport_unavailable',
  );
  expect(chunk.every((byte) => byte === 0)).toBe(true);
});
it('denies missing memory protection before reading', async () => {
  let read = false;
  const stream = new Readable({
    read() {
      read = true;
      this.push(null);
    },
  });
  await expect(
    readVaultRecoveryKey(stream, {
      assertMemory() {
        throw Error('PRIVATE_MEMORY');
      },
    }),
  ).rejects.toThrow('vault_recovery_transport_unavailable');
  expect(read).toBe(false);
});
it('destroys a stalled pipe at the bounded deadline', async () => {
  const stream = new Readable({ read() {} });
  await expect(readVaultRecoveryKey(stream, { assertMemory() {}, deadlineMs: 15 })).rejects.toThrow(
    'vault_recovery_transport_unavailable',
  );
  expect(stream.destroyed).toBe(true);
});
