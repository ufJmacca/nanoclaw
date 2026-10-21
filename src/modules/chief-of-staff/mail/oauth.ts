import {
  CalendarAuthorization,
  validCalendarTokens,
  refreshCalendarToken,
  type GoogleOAuthClient,
  type GoogleCalendarTokens,
  type OAuthTransport,
} from '../calendar/oauth-core.js';
export { GOOGLE_MAIL_READ_SCOPE } from '../calendar/oauth-core.js';
/** Host-only mail consent. The public Calendar wrapper keeps its original profile. */
export class GoogleMailAuthorization extends CalendarAuthorization {
  constructor(client: GoogleOAuthClient, callback: string, transport: OAuthTransport = {}) {
    super(client, callback, 'mail_reader', transport);
  }
}
export function validGoogleMailTokens(value: unknown): value is GoogleCalendarTokens {
  return validCalendarTokens(value, 'mail_reader');
}
export function refreshGoogleMailToken(
  client: GoogleOAuthClient,
  tokens: GoogleCalendarTokens,
  transport: OAuthTransport = {},
): Promise<GoogleCalendarTokens> {
  return refreshCalendarToken(client, tokens, 'mail_reader', transport);
}
