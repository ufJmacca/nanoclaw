import type { CalendarEvent, CalendarWindow } from './normalization.js';

export type CalendarAccess = {
  generation: string;
  calendarIds: string[];
  auth: 'ready' | 'expired' | 'revoked' | 'disconnected';
  scopes: string[];
};
export type CalendarPage = { events: CalendarEvent[]; nextPageToken: string | null; accessRole: string };
export interface CalendarReader {
  access(): Promise<CalendarAccess>;
  list(calendarId: string, window: CalendarWindow, pageToken?: string): Promise<CalendarPage>;
  get(calendarId: string, eventId: string, timeZone: string): Promise<CalendarEvent>;
}
export const GOOGLE_EVENT_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
const readScopes = new Set([
  GOOGLE_EVENT_READ_SCOPE,
  'https://www.googleapis.com/auth/calendar.events.owned.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.events.owned',
]);
export const hasCalendarReadScope = (scopes: string[]): boolean => scopes.some((scope) => readScopes.has(scope));

export class CalendarReadError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
