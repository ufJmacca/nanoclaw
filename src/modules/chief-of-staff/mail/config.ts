import { DatabaseConfigurationError } from '../store/config.js';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { verifyVaultMemory } from '../ops/vault-memory.js';
import { CalendarAccessFences } from '../calendar/access-fences.js';
import { MailCredentialOwner } from './credentials.js';
import { checkedClient, type GoogleOAuthClient } from '../calendar/oauth-core.js';
import type { CredentialJournal } from '../ops/backup-credential-event.js';
import { withVaultCredentialJournal } from '../ops/backup-credential-journal.js';
import { withMailProfileStorage, type PinnedMailStorage } from './storage.js';
import type { MailCredentialProfile } from './profile.js';
export function mailSettings(env: NodeJS.ProcessEnv): { enabled: boolean } {
  const enabled = env.COS_MAIL_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabled)) throw new DatabaseConfigurationError('COS_MAIL_ENABLED');
  return { enabled: enabled === 'true' };
}
export type MailHostFences = {
  fences: CalendarAccessFences;
  verifyStorage(): void;
  close(): Promise<void>;
  /** Terminal lifetime settlement, including a lost-proof close diagnostic. */
  closed(): boolean;
};
export type MailHostCredentials = MailHostFences & { readonly clientId: string; credentials: MailCredentialOwner };
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
export async function openMailProfile<T extends object>(
  profile: MailCredentialProfile,
  roots: CalendarStorageRoots,
  construct: (storage: PinnedMailStorage, fences: CalendarAccessFences, journal?: CredentialJournal) => T,
  inspect?: StorageInspection,
  memory: () => void = verifyVaultMemory,
  journal?: CredentialJournal | 'vault',
): Promise<T & MailHostFences> {
  let settled = false;
  let accept!: (host: T & MailHostFences) => void, reject!: (error: Error) => void;
  const ready = new Promise<T & MailHostFences>((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });
  const lifetime = withMailProfileStorage(
    profile,
    roots,
    async (storage) => {
      const fences = new ProtectedMailFences(storage.root + '/access-denials', storage.assertCurrent);
      const hold = async (activeJournal?: CredentialJournal) => {
        const value = construct(storage, fences, activeJournal);
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        storage.assertCurrent();
        accept({
          ...value,
          fences,
          verifyStorage: storage.assertCurrent,
          closed: () => settled,
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
      };
      if (journal === 'vault') return withVaultCredentialJournal(roots, hold, inspect, memory);
      return hold(journal);
    },
    inspect,
    memory,
  );
  void lifetime.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
      reject(Error('mail_configuration_unavailable'));
    },
  );
  return ready;
}
/** No token files or OAuth client parsing are needed to enforce existing denial
 * journals while ingestion is disabled. The complete storage proof still applies. */
export function openMailFences(
  roots: CalendarStorageRoots,
  inspect?: StorageInspection,
  memory: () => void = verifyVaultMemory,
): Promise<MailHostFences> {
  return openMailProfile('mail_reader', roots, () => ({}), inspect, memory);
}
export function openMailCredentials(
  roots: CalendarStorageRoots,
  inspect?: StorageInspection,
  memory: () => void = verifyVaultMemory,
  journal?: CredentialJournal,
): Promise<MailHostCredentials> {
  if (journal !== undefined && typeof journal !== 'function')
    return Promise.reject(Error('mail_configuration_unavailable'));
  return openMailProfile(
    'mail_reader',
    roots,
    (storage, fences, activeJournal) => ({
      clientId: checkedClient(storage.readClient() as GoogleOAuthClient).clientId,
      credentials: new MailCredentialOwner(
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
