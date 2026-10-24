import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { checkedClient, type GoogleOAuthClient } from '../calendar/oauth-core.js';
import { verifyVaultMemory } from '../ops/vault-memory.js';
import { withMailReaderStorage } from '../mail/storage.js';
import { initializeMailProfileFor } from '../mail/setup.js';
/** Trusted setup pins the existing reader and requires a separate client. It never grants OAuth consent. */
export function initializeMailDraftProfile(
  roots: CalendarStorageRoots,
  client: GoogleOAuthClient,
  authority: { operationId: string; assertAuthority(): void },
  inspect?: StorageInspection,
  memory: () => void = verifyVaultMemory,
  hooks: { afterStep?(step: 'intent' | 'directories' | 'client' | 'markers' | 'proof'): Promise<void> } = {},
): Promise<{ status: 'ready' }> {
  return withMailReaderStorage(
    roots,
    async (reader) => {
      if (checkedClient(reader.readClient() as GoogleOAuthClient).clientId === checkedClient(client).clientId)
        throw Error('separate_mail_draft_client_required');
      return initializeMailProfileFor(
        'mail_draft_writer',
        roots,
        client,
        {
          operationId: authority.operationId,
          assertAuthority: () => {
            reader.assertCurrent();
            authority.assertAuthority();
          },
        },
        inspect,
        memory,
        hooks,
      );
    },
    inspect,
    memory,
  );
}
