import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { checkedClient, type GoogleOAuthClient } from '../calendar/oauth-core.js';
import { DatabaseConfigurationError } from '../store/config.js';
import { verifyVaultMemory } from '../ops/vault-memory.js';
import type { CredentialJournal } from '../ops/backup-credential-event.js';
import { openMailProfile, type MailHostFences } from '../mail/config.js';
import { MailDraftCredentialOwner } from './credentials.js';
export function mailDraftSettings(env: NodeJS.ProcessEnv): { enabled: boolean } {
  const enabled = env.COS_MAIL_DRAFTS_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabled) || (enabled === 'true' && env.COS_MAIL_ENABLED !== 'true'))
    throw new DatabaseConfigurationError('COS_MAIL_DRAFTS_ENABLED');
  return { enabled: enabled === 'true' };
}
export type MailDraftHostCredentials = MailHostFences & {
  readonly clientId: string;
  credentials: MailDraftCredentialOwner;
};
/** Opening an installed profile never creates directories, installs a token or enables draft authority. */
export function openMailDraftCredentials(
  roots: CalendarStorageRoots,
  inspect?: StorageInspection,
  memory: () => void = verifyVaultMemory,
  journal?: CredentialJournal,
): Promise<MailDraftHostCredentials> {
  if (journal !== undefined && typeof journal !== 'function')
    return Promise.reject(Error('mail_configuration_unavailable'));
  return openMailProfile(
    'mail_draft_writer',
    roots,
    (storage, fences, activeJournal) => ({
      clientId: checkedClient(storage.readClient() as GoogleOAuthClient).clientId,
      credentials: new MailDraftCredentialOwner(
        storage.root + '/credentials',
        storage.readClient() as GoogleOAuthClient,
        fences,
        {},
        storage.assertCurrent,
        activeJournal,
      ),
    }),
    inspect,
    memory,
    journal ?? 'vault',
  );
}
