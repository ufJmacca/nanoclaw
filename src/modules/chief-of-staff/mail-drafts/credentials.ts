import { CalendarCredentialCore } from '../calendar/credential-core.js';
import type { CalendarAccessFences } from '../calendar/access-fences.js';
import type { GoogleOAuthClient, OAuthTransport } from '../calendar/oauth-core.js';
import type { CredentialJournal } from '../ops/backup-credential-event.js';
import { SerializedMailCredentials } from '../mail/serialized-credentials.js';
/** Independent compose-profile credentials, never the Mail reader's root or token records. */
export class MailDraftCredentialOwner extends SerializedMailCredentials {
  constructor(
    root: string,
    client: GoogleOAuthClient,
    fences: CalendarAccessFences,
    transport: OAuthTransport = {},
    protection?: () => void,
    journal?: CredentialJournal,
  ) {
    super(root, client, fences, 'mail_draft_writer', transport, protection, journal);
  }
  static initialize(root: string): void {
    CalendarCredentialCore.initialize(root, 'mail_draft_writer');
  }
}
