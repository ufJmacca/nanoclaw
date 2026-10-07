import { CalendarCredentialCore } from '../calendar/credential-core.js';
import type { CalendarAccessFences } from '../calendar/access-fences.js';
import type { GoogleOAuthClient, OAuthTransport } from '../calendar/oauth.js';
/** Separate writer vault. A reader-owned directory cannot supply writer authority or tokens. */
export class CalendarWriterCredentialOwner extends CalendarCredentialCore {
  constructor(
    root: string,
    client: GoogleOAuthClient,
    fences: CalendarAccessFences,
    transport: OAuthTransport = {},
    protection?: () => void,
  ) {
    super(root, client, fences, 'owned_event_writer', transport, protection);
  }
  static initialize(root: string): void {
    CalendarCredentialCore.initialize(root, 'owned_event_writer');
  }
}
