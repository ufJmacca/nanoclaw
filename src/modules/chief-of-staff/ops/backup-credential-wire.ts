import { isUtf8 } from 'node:buffer';
import { verifyVaultMemory } from './vault-memory.js';

export type BackupCredentialBytes = Readonly<{ smbPassword: Buffer; resticPassword: Buffer }>;

/** Consume the scoped Mac Keychain helper's binary frame. The caller transfers ownership
 * of the input buffer; the trusted callback borrows views and must not retain copies.
 * Neither password is decoded into a string, and all owned bytes are cleared on exit.
 */
export async function consumeBackupCredentials(
  input: Buffer,
  operation: (credentials: BackupCredentialBytes) => Promise<void>,
): Promise<void> {
  try {
    verifyVaultMemory();
    if (
      !Buffer.isBuffer(input) ||
      input.length < 7 ||
      input.length > 135 ||
      input[0] !== 0x43 ||
      input[1] !== 0x4f ||
      input[2] !== 0x53 ||
      input[3] !== 0x42 ||
      input[4] !== 1 ||
      input[5] < 16 ||
      input[5] > 64 ||
      input[6] !== 64 ||
      input.length !== 7 + input[5] + input[6]
    )
      throw Error('invalid_credential_frame');
    const smbPassword = input.subarray(7, 7 + input[5]);
    const resticPassword = input.subarray(7 + input[5]);
    if (
      !isUtf8(smbPassword) ||
      smbPassword.some((byte) => byte === 0 || byte === 10 || byte === 13) ||
      !resticPassword.every((byte) => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66))
    )
      throw Error('invalid_credential_bytes');
    await operation(Object.freeze({ smbPassword, resticPassword }));
    verifyVaultMemory();
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Callback and transport diagnostics may contain passwords.
    throw Error('backup_credentials_unavailable');
  } finally {
    if (Buffer.isBuffer(input)) input.fill(0);
  }
}
