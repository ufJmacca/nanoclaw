import { randomBytes } from 'node:crypto';
import { hasCalendarControl } from '../calendar/normalization.js';
import { digest, type Context } from '../domain/contracts.js';
import {
  validActionId,
  validActionInstant,
  validCalendarActionRequest,
  type CalendarActionRequest,
} from '../contracts/action-protocol.js';

export type ActionResourceObservation = {
  kind: 'writer_binding' | 'availability' | 'project' | 'mission' | 'source';
  id: string;
  version: number;
  digest: string;
  observed_at: string;
};
export type CalendarEventPayload = {
  id: string;
  summary: string;
  description: string;
  eventType: 'default';
  visibility: 'private';
  transparency: 'opaque';
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees: [];
  reminders: { useDefault: false };
  extendedProperties: { private: { nanoclaw_cos_action: string } };
};
export type ActionIntent = {
  format: 'cos-calendar-action/v1';
  actionId: string;
  requestId: string;
  revision: 1;
  context: Context;
  destination: { instanceId: string; channelId: string };
  request: CalendarActionRequest;
  resources: ActionResourceObservation[];
  eventId: string;
  correlation: string;
  payload: CalendarEventPayload;
  payloadHash: string;
  expiresAt: string;
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  !/\s/u.test(value) &&
  !hasCalendarControl(value) &&
  Buffer.from(value).toString('utf8') === value;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/** Construct only from a host-validated scope and fresh observations. This pure function grants no authority. */
function providerPayload(request: CalendarActionRequest, eventId: string, correlation: string): CalendarEventPayload {
  return {
    id: eventId,
    summary: request.title,
    description: request.description,
    eventType: 'default',
    visibility: 'private',
    transparency: 'opaque',
    attendees: [],
    reminders: { useDefault: false },
    start: { dateTime: request.start, timeZone: request.time_zone },
    end: { dateTime: request.end, timeZone: request.time_zone },
    extendedProperties: { private: { nanoclaw_cos_action: correlation } },
  };
}
function validResources(resources: unknown, request: CalendarActionRequest): resources is ActionResourceObservation[] {
  if (
    !Array.isArray(resources) ||
    resources.length < 2 ||
    resources.length > 12 ||
    !resources.every(
      (resource) =>
        object(resource) &&
        exact(resource, ['kind', 'id', 'version', 'digest', 'observed_at']) &&
        ['writer_binding', 'availability', 'project', 'mission', 'source'].includes(String(resource.kind)) &&
        id(resource.id) &&
        Number.isSafeInteger(resource.version) &&
        Number(resource.version) > 0 &&
        Number(resource.version) <= 2147483647 &&
        hash(resource.digest) &&
        validActionInstant(resource.observed_at),
    )
  )
    return false;
  if (new Set(resources.map((resource) => resource.kind + ':' + resource.id)).size !== resources.length) return false;
  const writers = resources.filter((resource) => resource.kind === 'writer_binding'),
    availability = resources.filter((resource) => resource.kind === 'availability');
  return (
    writers.length === 1 &&
    writers[0].id === request.binding_id &&
    availability.length === 1 &&
    /^availability-[a-f0-9]{64}$/.test(availability[0].id) &&
    (request.project_id === null ||
      resources.some((resource) => resource.kind === 'project' && resource.id === request.project_id)) &&
    (request.mission_id === null ||
      resources.some((resource) => resource.kind === 'mission' && resource.id === request.mission_id))
  );
}

/** The retained approval digest is mandatory; a recomputed payload hash alone cannot preserve an approval. */
export function validActionIntent(value: unknown, approvedDigest: string): value is ActionIntent {
  if (
    !hash(approvedDigest) ||
    !object(value) ||
    !exact(value, [
      'format',
      'actionId',
      'requestId',
      'revision',
      'context',
      'destination',
      'request',
      'resources',
      'eventId',
      'correlation',
      'payload',
      'payloadHash',
      'expiresAt',
    ]) ||
    value.format !== 'cos-calendar-action/v1' ||
    value.revision !== 1 ||
    !uuid(value.requestId) ||
    !validActionId(value.actionId) ||
    !validCalendarActionRequest(value.request) ||
    !object(value.context) ||
    !exact(value.context, ['scopeId', 'ownerId', 'agentGroupId', 'sessionId', 'ingressId']) ||
    !Object.values(value.context).every(id) ||
    !object(value.destination) ||
    !exact(value.destination, ['instanceId', 'channelId']) ||
    !Object.values(value.destination).every(id) ||
    !validResources(value.resources, value.request) ||
    !hash(value.eventId) ||
    !hash(value.correlation) ||
    value.eventId === value.correlation ||
    !hash(value.payloadHash) ||
    !validActionInstant(value.expiresAt) ||
    Date.parse(value.expiresAt) > Date.parse(value.request.start)
  )
    return false;
  const actionId =
    'action-' +
    digest({
      format: 'cos-calendar-action/v1',
      scopeId: value.context.scopeId,
      sessionId: value.context.sessionId,
      requestId: value.requestId,
    });
  if (value.actionId !== actionId) return false;
  try {
    const expected = providerPayload(value.request, value.eventId, value.correlation);
    return (
      digest(value.payload) === digest(expected) &&
      value.payloadHash === digest(expected) &&
      digest(value) === approvedDigest
    );
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return false;
    throw error;
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function createActionIntent(options: {
  request: CalendarActionRequest;
  context: Context;
  requestId: string;
  destination: ActionIntent['destination'];
  resources: ActionResourceObservation[];
  now: number;
  entropy?: () => Buffer;
}): ActionIntent {
  const fail = () => {
    throw new Error('invalid_action_intent');
  };
  if (
    !validCalendarActionRequest(options.request) ||
    !Number.isSafeInteger(options.now) ||
    options.context.origin ||
    !validResources(options.resources, options.request) ||
    Date.parse(options.request.start) <= options.now ||
    Date.parse(options.request.start) - options.now > 90 * 86400000 ||
    options.resources.some(
      (resource) =>
        Date.parse(resource.observed_at) < options.now - 30000 || Date.parse(resource.observed_at) > options.now + 2000,
    )
  )
    return fail();
  const allocate = () => {
    const bytes = options.entropy ? options.entropy() : randomBytes(32);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 32) return fail();
    return bytes.toString('hex');
  };
  const request = structuredClone(options.request),
    context = structuredClone(options.context),
    eventId = allocate(),
    correlation = allocate(),
    payload = providerPayload(request, eventId, correlation);
  const intent: ActionIntent = {
    format: 'cos-calendar-action/v1',
    revision: 1,
    requestId: options.requestId,
    actionId:
      'action-' +
      digest({
        format: 'cos-calendar-action/v1',
        scopeId: context.scopeId,
        sessionId: context.sessionId,
        requestId: options.requestId,
      }),
    context,
    destination: structuredClone(options.destination),
    request,
    resources: structuredClone(options.resources),
    eventId,
    correlation,
    payload,
    payloadHash: digest(payload),
    expiresAt: new Date(Math.floor(Math.min(options.now + 15 * 60000, Date.parse(request.start)) / 1000) * 1000)
      .toISOString()
      .replace('.000Z', 'Z'),
  };
  if (!validActionIntent(intent, digest(intent))) return fail();
  return freeze(intent);
}
