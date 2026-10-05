import type { CalendarActionRequest } from '../contracts/action-protocol.js';
import type { CalendarTime } from '../calendar/normalization.js';
import type { ActionIntent } from './intent.js';

export const GOOGLE_OWNED_EVENT_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned';
export const GOOGLE_CALENDAR_METADATA_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
export type CalendarWriterAccess = {
  generation: string;
  accountFingerprint: string;
  calendarId: string;
  auth: 'ready' | 'expired' | 'revoked' | 'disconnected';
  scopes: string[];
  writeEnabled: boolean;
};
export type CalendarWriterInspection = {
  complete: true;
  calendarId: string;
  calendarTimeZone: string;
  accountFingerprint: string;
  generation: string;
  ownershipDigest: string;
  availabilityDigest: string;
  busy: Array<{ start: CalendarTime; end: CalendarTime; eventDigest: string }>;
  observedAt: string;
};
/** Supplied only after a confirmed durable request-start transaction; it is never a wire parameter. */
export type CalendarWritePermit = {
  valid(): boolean;
  inspection: CalendarWriterInspection;
};
export interface CalendarActionWriter {
  access(): Promise<CalendarWriterAccess>;
  inspect(request: CalendarActionRequest): Promise<CalendarWriterInspection>;
  create(intent: ActionIntent, approvedDigest: string, permit: CalendarWritePermit): Promise<unknown>;
  get(intent: ActionIntent, approvedDigest: string): Promise<unknown | null>;
}
export class CalendarWriteError extends Error {
  constructor(
    readonly code: string,
    readonly outcome: 'not_sent' | 'uncertain' | 'read_unavailable',
  ) {
    super(code);
  }
}
