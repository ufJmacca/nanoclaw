import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import { BackupQueue, createVaultBackupQueue } from './backup-queue.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { digest } from '../domain/contracts.js';
import { verifyVaultMemory } from './vault-memory.js';
import { verifyVaultStorage, withVaultDirectory } from './vault-storage.js';
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

/** Hold the actual encrypted journal directory for a credential owner's lifetime.
 * Every record still takes the actual queue writer and checks the current vault,
 * memory policy and primary credential state. Nothing here caches admission. */
export function withVaultCredentialJournal<T>(
  roots: CalendarStorageRoots,
  operation: (journal: CredentialJournal) => Promise<T>,
  inspect?: StorageInspection,
  memory: () => void = verifyVaultMemory,
): Promise<T> {
  const captured = Object.freeze({ ...roots });
  return withVaultDirectory(
    captured,
    'journals',
    async (directory, current) => {
      const policy = verifyVaultStorage(captured, inspect);
      current();
      const queue = new BackupQueue(
        digest({ targetDigest: policy.targetDigest, filesystemUuid: policy.volume.filesystemUuid }),
        async (kind, access) => {
          current();
          if (kind !== 'credentials') throw Error('credential_queue_required');
          const result = await access(directory);
          current();
          return result;
        },
      );
      return operation(async (change, assertState) => {
        let publishing = true;
        const assertCurrent = () => {
          if (!publishing) throw Error('credential_publication_released');
          current();
          assertState();
          current();
        };
        try {
          assertCurrent();
          await queue.recordCredential(change, assertCurrent);
          assertCurrent();
        } catch {
          // eslint-disable-next-line preserve-caught-error -- Vault and credential diagnostics remain private.
          throw Error('backup_credential_journal_unavailable');
        } finally {
          publishing = false;
        }
      });
    },
    inspect,
    memory,
  );
}
