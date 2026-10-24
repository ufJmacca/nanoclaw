import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { verifyVaultMemory } from '../ops/vault-memory.js';
import { withMailProfileStorage, type PinnedMailStorage } from '../mail/storage.js';
export const MAIL_DRAFT_WRITER_ROOT_MARKER = '.cos-mail-draft-writer';
export function withMailDraftWriterStorage<T>(
  roots: CalendarStorageRoots,
  operation: (storage: PinnedMailStorage) => Promise<T>,
  inspect?: StorageInspection,
  memory: () => void = verifyVaultMemory,
): Promise<T> {
  return withMailProfileStorage('mail_draft_writer', roots, operation, inspect, memory);
}
