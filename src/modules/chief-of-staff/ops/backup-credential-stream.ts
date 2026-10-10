import type { Readable } from 'node:stream';
import { consumeBackupCredentials, type BackupCredentialBytes } from './backup-credential-wire.js';
import { verifyVaultMemory } from './vault-memory.js';

/** Private pipe only. EOF and the complete bounded frame precede any credential write.
 * The producer must be the scoped helper, and its exit status is checked by the caller.
 */
export async function consumeBackupCredentialStream(
  stream: Readable,
  operation: (credentials: BackupCredentialBytes) => Promise<void>,
  controls: { deadlineMs?: number } = {},
): Promise<void> {
  let bytes: Buffer | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    verifyVaultMemory();
    const deadline = controls.deadlineMs ?? 15000;
    if (
      (stream as Readable & { isTTY?: boolean }).isTTY ||
      stream.readableEncoding !== null ||
      !Number.isSafeInteger(deadline) ||
      deadline < 1 ||
      deadline > 15000
    )
      throw Error('invalid_credential_pipe');
    bytes = Buffer.alloc(135);
    let offset = 0;
    timer = setTimeout(() => stream.destroy(Error('backup_credentials_unavailable')), deadline);
    for await (const chunk of stream) {
      try {
        verifyVaultMemory();
        if (!Buffer.isBuffer(chunk) || chunk.length > bytes.length - offset) throw Error('credential_pipe_bounds');
        chunk.copy(bytes, offset);
        offset += chunk.length;
        verifyVaultMemory();
      } finally {
        if (Buffer.isBuffer(chunk)) chunk.fill(0);
      }
    }
    clearTimeout(timer);
    timer = undefined;
    verifyVaultMemory();
    await consumeBackupCredentials(bytes.subarray(0, offset), operation);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Pipe and callback errors may include private transport or password data.
    throw Error('backup_credentials_unavailable');
  } finally {
    if (timer) clearTimeout(timer);
    bytes?.fill(0);
    stream.destroy();
  }
}
