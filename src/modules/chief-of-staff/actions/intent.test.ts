import { describe, expect, it } from 'vitest';
import { digest } from '../domain/contracts.js';
import { createActionIntent, validActionIntent, type ActionResourceObservation } from './intent.js';
import type { CalendarActionRequest } from '../contracts/action-protocol.js';

const now = Date.parse('2026-10-05T21:00:00Z');
const request: CalendarActionRequest = {
  kind: 'calendar_block',
  binding_id: '11111111-1111-4111-8111-111111111111',
  calendar_id: 'owner@example.test',
  start: '2026-10-05T22:00:00Z',
  end: '2026-10-05T23:00:00Z',
  time_zone: 'Australia/Sydney',
  title: 'Focus work',
  description: '',
  project_id: null,
  mission_id: null,
  attendees: [],
};
const context = {
  scopeId: 'fixture-scope',
  ownerId: 'fixture-owner',
  agentGroupId: 'fixture-group',
  sessionId: 'fixture-session',
  ingressId: 'fixture-ingress',
};
const resources: ActionResourceObservation[] = [
  {
    kind: 'writer_binding',
    id: request.binding_id,
    version: 1,
    digest: 'a'.repeat(64),
    observed_at: '2026-10-05T21:00:00Z',
  },
  {
    kind: 'availability',
    id: 'availability-' + 'b'.repeat(64),
    version: 1,
    digest: 'c'.repeat(64),
    observed_at: '2026-10-05T21:00:00Z',
  },
];
const create = (changes: Partial<Parameters<typeof createActionIntent>[0]> = {}) => {
  let calls = 0;
  return createActionIntent({
    request: structuredClone(request),
    context,
    requestId: request.binding_id,
    destination: { instanceId: 'fixture', channelId: 'private-channel' },
    resources: structuredClone(resources),
    now,
    entropy: () => Buffer.alloc(32, ++calls),
    ...changes,
  });
};

describe('S09 immutable host-owned calendar intent', () => {
  it('seals exact authority, expiry, observations and a minimal private provider payload', () => {
    const intent = create();
    expect(validActionIntent(intent, digest(intent))).toBe(true);
    expect(intent.expiresAt).toBe('2026-10-05T21:15:00Z');
    expect(intent.actionId).toMatch(/^action-[a-f0-9]{64}$/);
    expect(intent.eventId).toMatch(/^[0-9a-v]{64}$/);
    expect(intent.correlation).not.toBe(intent.eventId);
    expect(intent.payload).toEqual({
      id: intent.eventId,
      summary: 'Focus work',
      description: '',
      eventType: 'default',
      visibility: 'private',
      transparency: 'opaque',
      attendees: [],
      reminders: { useDefault: false },
      start: { dateTime: request.start, timeZone: request.time_zone },
      end: { dateTime: request.end, timeZone: request.time_zone },
      extendedProperties: { private: { nanoclaw_cos_action: intent.correlation } },
    });
    expect(intent.payloadHash).toBe(digest(intent.payload));
    expect(intent.context).toEqual(context);
    expect(intent.destination).toEqual({ instanceId: 'fixture', channelId: 'private-channel' });
  });
  it('copies inputs and freezes nested intent fields before approval', () => {
    const input = structuredClone(request),
      observations = structuredClone(resources);
    const intent = create({ request: input, resources: observations });
    input.title = 'Changed later';
    observations[0].version = 2;
    expect(intent.request.title).toBe('Focus work');
    expect(intent.resources[0].version).toBe(1);
    expect(() => {
      intent.payload.summary = 'Changed later';
    }).toThrow();
    expect(() => {
      intent.resources.push(resources[0]);
    }).toThrow();
    expect(() => {
      intent.request.attendees.push('guest' as never);
    }).toThrow();
  });
  it('S09-T02 changing time, calendar, owner, destination or observations invalidates the retained approval digest', () => {
    const intent = create(),
      approved = digest(intent);
    for (const changed of [
      { ...intent, request: { ...intent.request, start: '2026-10-05T22:30:00Z' } },
      { ...intent, request: { ...intent.request, calendar_id: 'other@example.test' } },
      { ...intent, context: { ...intent.context, ownerId: 'other-owner' } },
      { ...intent, destination: { ...intent.destination, channelId: 'other-channel' } },
      { ...intent, resources: [{ ...intent.resources[0], version: 2 }, intent.resources[1]] },
      { ...intent, eventId: 'd'.repeat(64) },
      { ...intent, payload: { ...intent.payload, attendees: [{ email: 'guest@example.test' }] } },
      { ...intent, expiresAt: '2099-01-01T00:00:00Z' },
    ])
      expect(validActionIntent(changed, approved)).toBe(false);
  });
  it('S09-T01/T03 refuses implicit automation authority, stale/missing observations and invalid identity input', () => {
    for (const patch of [
      { context: { ...context, origin: { kind: 'schedule' as const, runId: 'run', generation: 1 } } },
      { context: { ...context, ingressId: '' } },
      { requestId: 'not-a-uuid' },
      { resources: [] },
      { resources: [resources[0]] },
      { resources: [resources[0], resources[0], resources[1]] },
      { resources: [{ ...resources[0], id: 'other-binding' }, resources[1]] },
      { resources: [resources[0], { ...resources[1], observed_at: '2026-10-05T20:00:00Z' }] },
      { resources: [resources[0], { ...resources[1], observed_at: '2026-10-05T22:00:00Z' }] },
      { request: { ...request, project_id: 'unobserved-project' } },
      { request: { ...request, start: '2026-10-05T20:00:00Z', end: '2026-10-05T21:00:00Z' } },
      { request: { ...request, attendees: ['guest'] } },
      { entropy: () => Buffer.alloc(1) },
      { entropy: () => Buffer.alloc(32) },
    ])
      expect(() => create(patch as Parameters<typeof create>[0])).toThrow();
  });
  it('keeps action identity stable for request reconciliation, while provider identity is allocated only by the host', () => {
    const first = create(),
      second = create({
        entropy: (() => {
          let calls = 10;
          return () => Buffer.alloc(32, ++calls);
        })(),
      });
    expect(first.actionId).toBe(second.actionId);
    expect(first.eventId).not.toBe(second.eventId);
    expect(first.requestId).toBe(request.binding_id);
    // The durable request transaction must retain the first complete intent, including these random IDs.
    expect(validActionIntent({ ...first, eventId: second.eventId }, digest(first))).toBe(false);
  });
});
