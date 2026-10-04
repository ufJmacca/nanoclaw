import { Temporal } from '@js-temporal/polyfill';
import { digest } from '../domain/contracts.js';
import { validMandateDefinition, type MandateDefinition } from '../contracts/mandate-protocol.js';
import type { CalendarEvent } from '../calendar/normalization.js';
import { validWorkDue } from '../contracts/protocol.js';

export type MandateEvent = { calendar_id: string; source_id: string; revision_id: string; event: CalendarEvent };
export type MandateWake = { mandateId: string; revision: number; wakeAt: string };
export type MandateFacts = {
  scopeCurrent: boolean;
  ownerCurrent: boolean;
  subscriptionCurrent: boolean;
  sourcesCurrent: boolean;
  state: string;
  now: string;
  activatedAt: string;
  changedProject: string | null;
  dueCommitments: string[];
  scheduledOccurrence: string | null;
  events: MandateEvent[];
};
export function mandateDueAt(due: unknown): number | null {
  if (!validWorkDue(due)) return null;
  return due.kind === 'instant'
    ? Date.parse(due.at)
    : Number(Temporal.PlainDate.from(due.date).toZonedDateTime(due.time_zone).epochMilliseconds);
}
export function mandateEventStart(event: CalendarEvent, zone: string): number | null {
  if (!event.start) return null;
  return event.start.kind === 'instant'
    ? Date.parse(event.start.instant)
    : Number(Temporal.PlainDate.from(event.start.date).toZonedDateTime(zone).epochMilliseconds);
}
/** Typed facts come only from the trusted host. Provider prose is never parsed as trigger code. */
export function evaluateMandate(
  definition: MandateDefinition,
  facts: MandateFacts,
): { decision: string; matches: Array<{ event: MandateEvent; triggerKey: string }> } {
  if (!validMandateDefinition(definition)) return { decision: 'invalid_definition', matches: [] };
  const at = Date.parse(facts.now);
  if (
    !Number.isFinite(at) ||
    facts.state !== 'active' ||
    !facts.scopeCurrent ||
    !facts.ownerCurrent ||
    !facts.subscriptionCurrent ||
    !facts.sourcesCurrent
  )
    return { decision: 'authority_unavailable', matches: [] };
  if (at < Date.parse(definition.starts_at)) return { decision: 'not_started', matches: [] };
  if (at >= Date.parse(definition.expires_at) || at >= Date.parse(definition.review_at))
    return { decision: 'review_or_expiry_due', matches: [] };
  let triggerKey: string | null = null;
  if (definition.trigger.kind === 'project_changed') triggerKey = facts.changedProject;
  else if (definition.trigger.kind === 'commitment_due')
    triggerKey = facts.dueCommitments.length ? digest(facts.dueCommitments) : null;
  else if (definition.trigger.kind === 'scheduled_review') triggerKey = facts.scheduledOccurrence;
  else triggerKey = 'event_approaching';
  if (!triggerKey) return { decision: 'no_matching_trigger', matches: [] };
  const end = at + definition.trigger.look_ahead_minutes * 60000;
  const selected = facts.events
    .filter((row) => {
      const start = mandateEventStart(row.event, definition.schedule.time_zone);
      return (
        definition.calendar.calendar_ids.includes(row.calendar_id) &&
        definition.calendar.event_ids.includes(row.event.providerEventId) &&
        row.event.status !== 'cancelled' &&
        !!row.source_id &&
        !!row.revision_id &&
        start !== null &&
        start >= at &&
        start <= end
      );
    })
    .sort(
      (a, b) =>
        mandateEventStart(a.event, definition.schedule.time_zone)! -
          mandateEventStart(b.event, definition.schedule.time_zone)! ||
        a.event.providerEventId.localeCompare(b.event.providerEventId, 'en'),
    );
  return {
    decision: selected.length ? 'matching_trigger' : 'no_matching_meeting',
    matches: selected.slice(0, definition.trigger.max_matches).map((event) => ({
      event,
      triggerKey: digest({
        triggerKey,
        binding: definition.calendar.binding_id,
        calendar: event.calendar_id,
        event: event.event.providerEventId,
        start: event.event.start,
      }),
    })),
  };
}
