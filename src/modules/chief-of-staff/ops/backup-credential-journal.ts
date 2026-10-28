import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import { createVaultBackupQueue } from './backup-queue.js';
import { verifyVaultMemory } from './vault-memory.js';
import { withVaultDirectory } from './vault-storage.js';
import type { CredentialJournal } from './backup-credential-event.js';
/** Trusted production construction. All writes use the actual encrypted vault, scoped
 * memory protections and the credential owner's fresh state guard. Never contacts the NAS.
 * Opening/status alone does not initialize a journal or read credential material. */
export function createVaultCredentialJournal(
  roots: CalendarStorageRoots,
  memory: () => void = verifyVaultMemory,
): CredentialJournal {
  const captured = Object.freeze({ ...roots });
  return async (change, assertState) => {
    try {
      memory();
      assertState();
      await withVaultDirectory(
        captured,
        'journals',
        async (_directory, current) => {
          const assertCurrent = () => {
            current();
            assertState();
            current();
          };
          assertCurrent();
          await createVaultBackupQueue(captured).recordCredential(change, assertCurrent);
          assertCurrent();
        },
        undefined,
        memory,
      );
    } catch {
      // eslint-disable-next-line preserve-caught-error -- Credential and vault diagnostics remain behind a fixed private category.
      throw Error('backup_credential_journal_unavailable');
    }
  };
}
