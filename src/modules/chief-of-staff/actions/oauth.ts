import {
  CalendarAuthorization,
  validCalendarTokens,
  refreshCalendarToken,
  type GoogleCalendarTokens,
  type GoogleOAuthClient,
  type OAuthTransport,
} from '../calendar/oauth-core.js';
/** Separate explicit operator consent. It never expands the S03 reader profile. */
export class GoogleCalendarWriterAuthorization extends CalendarAuthorization {
  constructor(client: GoogleOAuthClient, callback: string, transport: OAuthTransport = {}) {
    super(client, callback, 'owned_event_writer', transport);
  }
}
export function validGoogleCalendarWriterTokens(value: unknown): value is GoogleCalendarTokens {
  return validCalendarTokens(value, 'owned_event_writer');
}
/** The separately owned writer vault must serialize and durably commit token rotation. */
export function refreshGoogleCalendarWriterToken(
  client: GoogleOAuthClient,
  tokens: GoogleCalendarTokens,
  transport: OAuthTransport = {},
): Promise<GoogleCalendarTokens> {
  return refreshCalendarToken(client, tokens, 'owned_event_writer', transport);
}
