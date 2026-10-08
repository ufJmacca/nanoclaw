import type { Readable } from 'node:stream';
import { verifyVaultMemory } from './vault-memory.js';
/** Raw Keychain output arrives only on a private pipe. The caller owns and clears the returned bytes. */
export async function readVaultRecoveryKey(
  stream: Readable,
  controls: { assertMemory?(): void; deadlineMs?: number } = {},
): Promise<Buffer> {
  let key: Buffer | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory;
    memory();
    const deadline = controls.deadlineMs ?? 15000;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 15000) throw Error('invalid_recovery_deadline');
    key = Buffer.alloc(64);
    timer = setTimeout(() => stream.destroy(Error('vault_recovery_transport_unavailable')), deadline);
    let offset = 0;
    for await (const chunk of stream) {
      try {
        memory();
        if (!Buffer.isBuffer(chunk) || offset + chunk.length > 64) throw Error('recovery_bounds');
        chunk.copy(key, offset);
        offset += chunk.length;
        memory();
      } finally {
        if (Buffer.isBuffer(chunk)) chunk.fill(0);
      }
    }
    memory();
    if (offset !== 64) throw Error('recovery_truncated');
    return key;
  } catch {
    key?.fill(0);
    // eslint-disable-next-line preserve-caught-error -- Transport errors must not disclose key or pipe diagnostics.
    throw Error('vault_recovery_transport_unavailable');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
