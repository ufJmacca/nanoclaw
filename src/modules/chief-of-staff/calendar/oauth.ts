import {
  CalendarAuthorization,
  validCalendarTokens,
  refreshCalendarToken,
  type GoogleCalendarTokens,
  type GoogleOAuthClient,
  type OAuthTransport,
} from './oauth-core.js';
export { checkedClient, type GoogleOAuthClient, type GoogleCalendarTokens, type OAuthTransport } from './oauth-core.js';
/** S03's public host API always requests the original read-only profile. */
export class GoogleCalendarAuthorization extends CalendarAuthorization {
  constructor(client: GoogleOAuthClient, callback: string, transport: OAuthTransport = {}) {
    super(client, callback, 'reader', transport);
  }
}
export function validGoogleCalendarTokens(value: unknown): value is GoogleCalendarTokens {
  return validCalendarTokens(value, 'reader');
}
export function refreshGoogleCalendarToken(
  client: GoogleOAuthClient,
  tokens: GoogleCalendarTokens,
  transport: OAuthTransport = {},
): Promise<GoogleCalendarTokens> {
  return refreshCalendarToken(client, tokens, 'reader', transport);
}
