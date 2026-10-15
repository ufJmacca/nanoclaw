import { DatabaseConfigurationError } from '../store/config.js';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { verifyVaultMemory } from '../ops/vault-memory.js';
import { CalendarAccessFences } from '../calendar/access-fences.js';
import { MailCredentialOwner } from './credentials.js';
import type { GoogleOAuthClient } from '../calendar/oauth-core.js';
import type { CredentialJournal } from '../ops/backup-credential-event.js';
import { createVaultCredentialJournal } from '../ops/backup-credential-journal.js';
import { withMailReaderStorage } from './storage.js';
export function mailSettings(env: NodeJS.ProcessEnv): { enabled: boolean } {
  const enabled = env.COS_MAIL_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabled)) throw new DatabaseConfigurationError('COS_MAIL_ENABLED');
  return { enabled: enabled === 'true' };
}
export type MailHostCredentials = {
  credentials: MailCredentialOwner;
  fences: CalendarAccessFences;
  verifyStorage(): void;
  close(): Promise<void>;
};
/** The credential core can persist denial after an awaited token exchange, so
 * its fence object must enforce the same held vault proof on every operation. */
class ProtectedMailFences extends CalendarAccessFences {
  constructor(
    root: string,
    private readonly current: () => void,
  ) {
    super(root);
    current();
  }
  override assertOpen(scope: string, binding: string): void {
    this.current();
    super.assertOpen(scope, binding);
    this.current();
  }
  override deny(scope: string, binding: string, auth: 'expired' | 'revoked' | 'disconnected'): void {
    this.current();
    super.deny(scope, binding, auth);
    this.current();
  }
  override async runCheck<T>(scope: string, binding: string, operation: () => Promise<T>): Promise<T> {
    this.current();
    return super.runCheck(scope, binding, async () => {
      this.current();
      const result = await operation();
      this.current();
      return result;
    });
  }
}
/** Runtime opens an already configured profile. Held vault/child descriptors and
 * the cheap kernel guard stay live until explicit close, including awaited token
 * refreshes. Startup never initializes directories or grants account access.
 * Inspection, memory and journal arguments are code-only fixture seams. */
export async function openMailCredentials(
  roots: CalendarStorageRoots,
  inspect?: StorageInspection,
  memory: () => void = verifyVaultMemory,
  journal?: CredentialJournal,
): Promise<MailHostCredentials> {
  if (journal !== undefined && typeof journal !== 'function') throw Error('mail_configuration_unavailable');
  let accept!: (host: MailHostCredentials) => void, reject!: (error: Error) => void;
  const ready = new Promise<MailHostCredentials>((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });
  const lifetime = withMailReaderStorage(
    roots,
    async (storage) => {
      const client = storage.readClient() as GoogleOAuthClient;
      storage.assertCurrent();
      const fences = new ProtectedMailFences(storage.root + '/access-denials', storage.assertCurrent);
      const credentials = new MailCredentialOwner(
        storage.root + '/credentials',
        client,
        fences,
        {},
        storage.assertCurrent,
        journal ?? createVaultCredentialJournal(roots, memory),
      );
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      storage.assertCurrent();
      accept({
        credentials,
        fences,
        verifyStorage: storage.assertCurrent,
        close: async () => {
          release();
          try {
            await lifetime;
          } catch {
            // eslint-disable-next-line preserve-caught-error -- Close cannot disclose private paths, client material or nested diagnostics.
            throw Error('mail_configuration_unavailable');
          }
        },
      });
      await released;
    },
    inspect,
    memory,
  );
  void lifetime.catch(() => reject(Error('mail_configuration_unavailable')));
  return ready;
}
