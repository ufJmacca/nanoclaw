import { describe, expect, it } from 'vitest';
import { digest } from '../domain/contracts.js';
import { createActionIntent } from './intent.js';
import { matchesActionEvent, safeCalendarEventLink } from './event.js';

const now = Date.parse('2026-10-05T21:00:00Z');
const binding = '11111111-1111-4111-8111-111111111111';
const intent = createActionIntent({
  request: {
    kind: 'calendar_block',
    binding_id: binding,
    calendar_id: 'owner@example.test',
    start: '2026-10-05T22:00:00Z',
    end: '2026-10-05T23:00:00Z',
    time_zone: 'Australia/Sydney',
    title: 'Focus work',
    description: '',
    project_id: null,
    mission_id: null,
    attendees: [],
  },
  context: { scopeId: 'scope', ownerId: 'owner', agentGroupId: 'group', sessionId: 'session', ingressId: 'ingress' },
  destination: { instanceId: 'fixture', channelId: 'private-channel' },
  requestId: binding,
  now,
  resources: [
    { kind: 'writer_binding', id: binding, version: 1, digest: 'a'.repeat(64), observed_at: '2026-10-05T21:00:00Z' },
    {
      kind: 'availability',
      id: 'availability-' + 'b'.repeat(64),
      version: 1,
      digest: 'c'.repeat(64),
      observed_at: '2026-10-05T21:00:00Z',
    },
  ],
});
const approved = digest(intent);
const event = {
  ...structuredClone(intent.payload),
  etag: '"fixture-version"',
  status: 'confirmed',
  start: { dateTime: '2026-10-06T09:00:00+11:00', timeZone: 'Australia/Sydney' },
  end: { dateTime: '2026-10-06T10:00:00+11:00', timeZone: 'Australia/Sydney' },
  htmlLink: 'https://calendar.google.com/calendar/event?eid=fixture',
};
const matches = (value: unknown) => matchesActionEvent(intent, approved, intent.request.calendar_id, value);

describe('S09 semantic provider read-back verification', () => {
  it.each([
    { eventType: null },
    { transparency: null },
    { attendeesOmitted: 'unknown' },
    { anyoneCanAddSelf: 'true' },
    { endTimeUnspecified: 'unknown' },
  ])('refuses malformed defaults and unknown coverage flags: %o', (patch) => {
    expect(matches({ ...event, ...patch })).toBe(false);
  });
  it('verifies equivalent explicit instants and exact approved private fields', () => {
    expect(matches(event)).toBe(true);
    expect(matches({ ...event, start: intent.payload.start, end: intent.payload.end })).toBe(true);
  });
  it('normalises omitted empty fields and documented defaults without loosening approval', () => {
    const {
      description: _description,
      attendees: _attendees,
      transparency: _transparency,
      status: _status,
      eventType: _eventType,
      ...defaults
    } = event;
    expect(
      matches({ ...defaults, start: { dateTime: event.start.dateTime }, end: { dateTime: event.end.dateTime } }),
    ).toBe(true);
    expect(
      matches({ ...defaults, attachments: [], conferenceData: {}, reminders: { useDefault: false, overrides: [] } }),
    ).toBe(true);
  });
  it('S09-T06 blocks wrong provider identity, calendar, correlation, dates, timezone or event content', () => {
    expect(matchesActionEvent(intent, approved, 'other@example.test', event)).toBe(false);
    expect(
      matchesActionEvent(
        { ...intent, context: { ...intent.context, ownerId: 'other' } },
        approved,
        intent.request.calendar_id,
        event,
      ),
    ).toBe(false);
    for (const patch of [
      { id: 'd'.repeat(64) },
      { etag: undefined },
      { summary: 'Different title' },
      { description: 'Different text' },
      { visibility: 'default' },
      { visibility: 'public' },
      { visibility: undefined },
      { transparency: 'transparent' },
      { status: 'cancelled' },
      { status: 'tentative' },
      { eventType: 'focusTime' },
      { endTimeUnspecified: true },
      { start: { date: '2026-10-06' } },
      { end: { date: '2026-10-07' } },
      { start: { ...event.start, dateTime: '2026-10-06T09:30:00+11:00' } },
      { end: { ...event.end, dateTime: '2026-10-06T11:00:00+11:00' } },
      { start: { dateTime: intent.request.start, timeZone: 'Europe/London' } },
      { start: { dateTime: '2026-04-05T02:30:00', timeZone: 'Australia/Sydney' } },
      { start: { dateTime: '2026-10-04T02:30:00', timeZone: 'Australia/Sydney' } },
      { extendedProperties: { private: { nanoclaw_cos_action: 'other' } } },
      { extendedProperties: { shared: { nanoclaw_cos_action: intent.correlation } } },
    ])
      expect(matches({ ...event, ...patch })).toBe(false);
  });
  it('S09-T03/T06 rejects attendees, hidden attendee coverage, meetings, attachments and recurrence', () => {
    for (const patch of [
      { attendees: [{ email: 'guest@example.test' }] },
      { attendeesOmitted: true },
      { anyoneCanAddSelf: true },
      { attachments: [{ fileUrl: 'https://drive.google.com/private' }] },
      { conferenceData: { conferenceId: 'meeting' } },
      { hangoutLink: 'https://meet.google.com/meeting' },
      { recurrence: ['RRULE:FREQ=DAILY'] },
      { recurringEventId: 'parent' },
      { reminders: { useDefault: true } },
      { reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 10 }] } },
      { location: 'Different location' },
    ])
      expect(matches({ ...event, ...patch })).toBe(false);
  });
  it('does not convert malformed provider data into a verified outcome or expose its text', () => {
    for (const value of [
      null,
      [],
      'private-provider-error',
      { ...event, start: {} },
      { ...event, etag: '\u0000private-error' },
    ])
      expect(matches(value)).toBe(false);
  });
  it('permits only Google Calendar event links with no credentials or arbitrary redirects', () => {
    expect(safeCalendarEventLink(event.htmlLink)).toBe(event.htmlLink);
    expect(safeCalendarEventLink('https://www.google.com/calendar/event?eid=fixture')).toBe(
      'https://www.google.com/calendar/event?eid=fixture',
    );
    for (const value of [
      undefined,
      'javascript:alert(1)',
      'https://calendar.google.com.evil.test/calendar/event?eid=x',
      'https://evil.test/calendar/event?eid=x',
      'https://calendar.google.com/calendar/event?next=https://evil.test',
      'https://secret@calendar.google.com/calendar/event?eid=x',
      'https://calendar.google.com:8443/calendar/event?eid=x',
      'https://www.google.com/url?q=https://evil.test',
      'https://calendar.google.com/calendar/event?eid=x#secret',
    ])
      expect(safeCalendarEventLink(value)).toBeNull();
  });
});
