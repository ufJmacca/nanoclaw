import {
  CalendarAuthorization,
  validCalendarTokens,
  refreshCalendarToken,
  type GoogleOAuthClient,
  type GoogleCalendarTokens,
  type OAuthTransport,
} from '../calendar/oauth-core.js';
export { GOOGLE_MAIL_DRAFT_SCOPE } from '../calendar/oauth-core.js';
/** A separate host-only client. The trusted transport must still prohibit Google's send endpoints. */
export class GoogleMailDraftAuthorization extends CalendarAuthorization {
  constructor(client: GoogleOAuthClient, callback: string, transport: OAuthTransport = {}) {
    super(client, callback, 'mail_draft_writer', transport);
  }
}
export function validGoogleMailDraftTokens(value: unknown): value is GoogleCalendarTokens {
  return validCalendarTokens(value, 'mail_draft_writer');
}
export function refreshGoogleMailDraftToken(
  client: GoogleOAuthClient,
  tokens: GoogleCalendarTokens,
  transport: OAuthTransport = {},
): Promise<GoogleCalendarTokens> {
  return refreshCalendarToken(client, tokens, 'mail_draft_writer', transport);
}
