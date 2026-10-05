import { normalizeEvent, object, hasCalendarControl } from '../calendar/normalization.js';
import { validActionIntent, type ActionIntent } from './intent.js';

const emptyList = (value: unknown) => value === undefined || (Array.isArray(value) && value.length === 0);
const emptyObject = (value: unknown) => value === undefined || (object(value) && Object.keys(value).length === 0);
const falseOrMissing = (value: unknown) => value === undefined || value === false;
const zone = (value: string) => new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;

/** Compare GET from the exact calendar/event endpoint, never an insert acknowledgement or iCalUID. */
export function matchesActionEvent(
  intent: ActionIntent,
  approvedDigest: string,
  requestedCalendarId: string,
  value: unknown,
): boolean {
  if (
    !validActionIntent(intent, approvedDigest) ||
    requestedCalendarId !== intent.request.calendar_id ||
    !object(value)
  )
    return false;
  if (
    value.id !== intent.eventId ||
    value.summary !== intent.request.title ||
    (value.description === undefined ? '' : value.description) !== intent.request.description ||
    value.visibility !== 'private' ||
    (value.eventType !== undefined && value.eventType !== 'default') ||
    (value.status !== undefined && value.status !== 'confirmed') ||
    (value.transparency !== undefined && value.transparency !== 'opaque') ||
    !emptyList(value.attendees) ||
    !falseOrMissing(value.attendeesOmitted) ||
    !falseOrMissing(value.anyoneCanAddSelf) ||
    !falseOrMissing(value.endTimeUnspecified) ||
    !emptyList(value.attachments) ||
    !emptyObject(value.conferenceData) ||
    !emptyList(value.recurrence) ||
    value.recurringEventId !== undefined ||
    (value.hangoutLink !== undefined && value.hangoutLink !== '') ||
    (value.location !== undefined && value.location !== '') ||
    !object(value.reminders) ||
    value.reminders.useDefault !== false ||
    !emptyList(value.reminders.overrides) ||
    !object(value.extendedProperties) ||
    !object(value.extendedProperties.private) ||
    value.extendedProperties.private.nanoclaw_cos_action !== intent.correlation
  )
    return false;
  try {
    for (const field of ['start', 'end']) {
      const time = value[field];
      if (!object(time)) return false;
      // Google may omit a custom timezone for a one-off event. Unambiguous instants remain mandatory;
      // an included timezone must be equivalent to the exact approved display timezone.
      if (
        time.timeZone !== undefined &&
        (typeof time.timeZone !== 'string' || zone(time.timeZone) !== zone(intent.request.time_zone))
      )
        return false;
    }
    const event = normalizeEvent({ ...value, recurrence: undefined }, intent.request.time_zone);
    return (
      event.providerEventId === intent.eventId &&
      !!event.providerVersion &&
      event.start?.kind === 'instant' &&
      event.end?.kind === 'instant' &&
      Date.parse(event.start.instant) === Date.parse(intent.request.start) &&
      Date.parse(event.end.instant) === Date.parse(intent.request.end)
    );
  } catch (error) {
    if (
      error instanceof RangeError ||
      error instanceof TypeError ||
      (error instanceof Error && error.message === 'calendar_invalid_event')
    )
      return false;
    throw error;
  }
}

/** A missing/untrusted link does not negate verified event fields; publish its ID with no unsafe hyperlink. */
export function safeCalendarEventLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || /\s/u.test(value) || hasCalendarControl(value)) return null;
  try {
    const link = new URL(value);
    if (
      link.protocol !== 'https:' ||
      !['calendar.google.com', 'www.google.com'].includes(link.hostname) ||
      link.port ||
      link.username ||
      link.password ||
      link.hash ||
      link.pathname !== '/calendar/event'
    )
      return null;
    const keys = [...link.searchParams.keys()];
    if (
      !keys.includes('eid') ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => !['eid', 'ctz'].includes(key))
    )
      return null;
    const event = link.searchParams.get('eid');
    if (!event || event.length > 2048 || hasCalendarControl(event)) return null;
    if (link.searchParams.has('ctz')) {
      const timeZone = link.searchParams.get('ctz')!;
      if (!timeZone || timeZone.length > 80) return null;
      zone(timeZone);
    }
    return link.href;
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return null;
    throw error;
  }
}
