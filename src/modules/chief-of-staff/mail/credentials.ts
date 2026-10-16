import { CalendarCredentialCore } from '../calendar/credential-core.js';
import type { CalendarAccessFences } from '../calendar/access-fences.js';
import type { GoogleOAuthClient, OAuthTransport } from '../calendar/oauth-core.js';
import type { CredentialJournal } from '../ops/backup-credential-event.js';
import { digest } from '../domain/contracts.js';
import { assertCalendarActive, awaitCalendarCredential } from '../calendar/cancellation.js';
/** Separate host credential root; installed callers must provide the verified vault guard. */
export class MailCredentialOwner extends CalendarCredentialCore {
  private readonly operations = new Map<string, Promise<void>>();
  constructor(
    root: string,
    client: GoogleOAuthClient,
    fences: CalendarAccessFences,
    transport: OAuthTransport = {},
    protection?: () => void,
    journal?: CredentialJournal,
  ) {
    super(root, client, fences, 'mail_reader', transport, protection, journal);
  }
  static initialize(root: string): void {
    CalendarCredentialCore.initialize(root, 'mail_reader');
  }
  /** Message fetches run concurrently, but each credential operation journals
   * under an exclusive file lock. Serialize this owner's operations only;
   * every queued operation still checks the actual file, vault and denials. */
  private serial<T>(scope: string, binding: string, reference: string, operation: () => Promise<T>): Promise<T> {
    const key = digest({ scope, binding, reference });
    const work = (this.operations.get(key) ?? Promise.resolve()).then(operation);
    const settled = work.then(
      () => {},
      () => {},
    );
    this.operations.set(key, settled);
    void settled.then(() => {
      if (this.operations.get(key) === settled) this.operations.delete(key);
    });
    return work;
  }
  override inspect(scope: string, binding: string, reference: string) {
    return this.serial(scope, binding, reference, () => super.inspect(scope, binding, reference));
  }
  override async token(scope: string, binding: string, reference: string, signal?: AbortSignal): Promise<string> {
    assertCalendarActive(signal);
    const work = this.serial(scope, binding, reference, () => super.token(scope, binding, reference, signal));
    return signal ? awaitCalendarCredential(work, signal) : work;
  }
}
