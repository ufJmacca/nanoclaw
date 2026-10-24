import { CalendarCredentialCore } from '../calendar/credential-core.js';
import type { CalendarAccessFences } from '../calendar/access-fences.js';
import type { GoogleOAuthClient, OAuthTransport } from '../calendar/oauth-core.js';
import type { CredentialJournal } from '../ops/backup-credential-event.js';
import { SerializedMailCredentials } from './serialized-credentials.js';
/** Separate host credential root; installed callers must provide the verified vault guard. */
export class MailCredentialOwner extends SerializedMailCredentials {
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
}
