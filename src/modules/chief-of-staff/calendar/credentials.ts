import { CalendarCredentialCore } from './credential-core.js';
import type { CalendarAccessFences } from './access-fences.js';
import type { GoogleOAuthClient, OAuthTransport } from './oauth.js';
import type { CredentialJournal } from '../ops/backup-credential-event.js';
/** Existing reader vault ownership and on-disk identity remain unchanged. */
export class CalendarCredentialOwner extends CalendarCredentialCore {
  constructor(
    root: string,
    client: GoogleOAuthClient,
    fences: CalendarAccessFences,
    transport: OAuthTransport = {},
    protection?: () => void,
    journal?: CredentialJournal,
  ) {
    super(root, client, fences, 'reader', transport, protection, journal);
  }
  static initialize(root: string): void {
    CalendarCredentialCore.initialize(root, 'reader');
  }
}
