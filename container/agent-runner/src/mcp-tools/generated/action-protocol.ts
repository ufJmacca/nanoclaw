/** Canonical proposal boundary. Provider identity, observations and approval are host-owned. */
export type CalendarActionRequest = {
  kind: 'calendar_block';
  binding_id: string;
  calendar_id: string;
  start: string;
  end: string;
  time_zone: string;
  title: string;
  description: string;
  project_id: string | null;
  mission_id: string | null;
  attendees: [];
};

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const text = (value: unknown, maximum: number, empty = false): value is string =>
  typeof value === 'string' &&
  (empty || value.trim().length > 0) &&
  value.length <= maximum &&
  Buffer.from(value).toString('utf8') === value &&
  [...value].every((character) => {
    const code = character.codePointAt(0)!;
    return code >= 32 && (code < 127 || code > 159);
  });
export const validActionId = (value: unknown): value is string =>
  typeof value === 'string' && /^action-[a-f0-9]{64}$/.test(value);
export const validActionInstant = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().replace('.000Z', 'Z') === value;

export function validCalendarActionRequest(value: unknown): value is CalendarActionRequest {
  if (
    !object(value) ||
    !exact(value, [
      'kind',
      'binding_id',
      'calendar_id',
      'start',
      'end',
      'time_zone',
      'title',
      'description',
      'project_id',
      'mission_id',
      'attendees',
    ]) ||
    value.kind !== 'calendar_block' ||
    !uuid(value.binding_id) ||
    !text(value.calendar_id, 1024) ||
    /\s/u.test(value.calendar_id) ||
    ['.', '..', 'primary'].includes(value.calendar_id.toLowerCase()) ||
    !validActionInstant(value.start) ||
    !validActionInstant(value.end) ||
    Date.parse(value.end) - Date.parse(value.start) < 60000 ||
    Date.parse(value.end) - Date.parse(value.start) > 8 * 3600000 ||
    !text(value.time_zone, 80) ||
    /^[+-]/.test(value.time_zone) ||
    !text(value.title, 120) ||
    !text(value.description, 500, true) ||
    (value.project_id !== null &&
      (typeof value.project_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.project_id))) ||
    (value.mission_id !== null &&
      (typeof value.mission_id !== 'string' || !/^mission-[a-f0-9]{64}$/.test(value.mission_id))) ||
    !Array.isArray(value.attendees) ||
    value.attendees.length !== 0
  )
    return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value.time_zone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/** Host-sealed preview only. Models submit CalendarActionRequest and cannot mint this approval envelope. */
export type CalendarActionChange = {
  kind: 'calendar_action';
  action_id: string;
  intent_digest: string;
  request: CalendarActionRequest;
  event_id: string;
  expires_at: string;
};
export function validCalendarActionChange(value: unknown): value is CalendarActionChange {
  return (
    object(value) &&
    exact(value, ['kind', 'action_id', 'intent_digest', 'request', 'event_id', 'expires_at']) &&
    value.kind === 'calendar_action' &&
    validActionId(value.action_id) &&
    typeof value.intent_digest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.intent_digest) &&
    validCalendarActionRequest(value.request) &&
    typeof value.event_id === 'string' &&
    /^[a-f0-9]{64}$/.test(value.event_id) &&
    validActionInstant(value.expires_at) &&
    Date.parse(value.expires_at) <= Date.parse(value.request.start)
  );
}

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [{ type: 'null' }, schema] });
const string = (maximum: number) => ({ type: 'string', minLength: 1, maxLength: maximum });
const moment = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$' };
export const calendarActionRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'binding_id',
    'calendar_id',
    'start',
    'end',
    'time_zone',
    'title',
    'description',
    'project_id',
    'mission_id',
    'attendees',
  ],
  properties: {
    kind: { type: 'string', enum: ['calendar_block'] },
    binding_id: { type: 'string', format: 'uuid' },
    calendar_id: { ...string(1024), description: 'Exact selected calendar ID; the primary alias is forbidden.' },
    start: {
      ...moment,
      description: 'Exact UTC instant. Implicit local times, including ambiguous DST times, are rejected.',
    },
    end: { ...moment, description: 'Exact UTC instant, one minute to eight hours after start.' },
    time_zone: { ...string(80), description: 'IANA timezone used in the exact owner preview and provider payload.' },
    title: { ...string(120), description: 'Minimal owner-approved title; default to Focus work without source text.' },
    description: { type: 'string', maxLength: 500, description: 'Empty by default; include only exact approved text.' },
    project_id: nullable({ type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' }),
    mission_id: nullable({ type: 'string', pattern: '^mission-[a-f0-9]{64}$' }),
    attendees: {
      type: 'array',
      maxItems: 0,
      items: { type: 'string' },
      description: 'Must be empty; no guests are admitted.',
    },
  },
} as const;
