import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import { digest } from '../domain/contracts.js';
import { createVaultBackupQueue } from './backup-queue.js';
import { verifyVaultMemory } from './vault-memory.js';
import { verifyVaultStorage } from './vault-storage.js';
import type { CredentialJournal } from './backup-credential-event.js';
/** Trusted production construction. All writes use the actual encrypted vault, scoped
 * memory protections and the credential owner's fresh state guard. Never contacts the NAS.
 * Opening/status alone does not initialize a journal or read credential material. */
export function createVaultCredentialJournal(
  roots: CalendarStorageRoots,
  memory: () => void = verifyVaultMemory,
): CredentialJournal {
  return async (change, assertState) => {
    try {
      memory();
      assertState();
      const policy = verifyVaultStorage(roots),
        identity = digest(policy);
      const assertCurrent = () => {
        memory();
        assertState();
        if (digest(verifyVaultStorage(roots)) !== identity) throw Error('credential_vault_changed');
      };
      assertCurrent();
      await createVaultBackupQueue(roots).recordCredential(change, assertCurrent);
      assertCurrent();
    } catch {
      // eslint-disable-next-line preserve-caught-error -- Credential and vault diagnostics remain behind a fixed private category.
      throw Error('backup_credential_journal_unavailable');
    }
  };
}
