/** Canonical CoS wire contract; copied verbatim into the runner and checked for drift. */
import { createHash } from 'node:crypto';
import { validScheduleChange, type ScheduleChange } from './schedule-protocol.js';
import { validMissionRequest } from './mission-protocol.js';
import { validMandateChange, type MandateChange } from './mandate-protocol.js';
import { validMissionReview } from './mission-review.js';
import { validTeamRequest } from './team-protocol.js';
import {
  validProactivePolicyChange,
  validProactiveDisposition,
  validProactiveDraft,
  type ProactivePolicyChange,
  type ProactiveDispositionRequest,
} from './proactive-protocol.js';
import { answerDraftSchema, validAnswerDraft, validAnswerCitation, type AnswerCitation } from './answer-protocol.js';
/** Provider guidance; the wire validator additionally checks real dates and state transitions. */
export const workChangeSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'title',
    'description',
    'reason',
    'state',
    'project_id',
    'due',
    'defer_until',
    'evidence',
    'expected_version',
  ],
  properties: {
    kind: { type: 'string', enum: ['commitment', 'decision'] },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 8000 },
    reason: { type: 'string', minLength: 1, maxLength: 2000 },
    state: {
      type: 'string',
      enum: ['confirmed', 'completed', 'needed', 'decided', 'deferred', 'dismissed'],
      description:
        'New commitments use confirmed and new decisions use needed. Every change still requires owner approval.',
    },
    project_id: { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' }] },
    due: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'date', 'time_zone'],
          properties: {
            kind: { type: 'string', enum: ['date'] },
            date: { type: 'string', format: 'date' },
            time_zone: { type: 'string', description: 'IANA timezone, for example Australia/Sydney.' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'at', 'time_zone'],
          properties: {
            kind: { type: 'string', enum: ['instant'] },
            at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$' },
            time_zone: { type: 'string' },
          },
        },
      ],
    },
    defer_until: {
      anyOf: [{ type: 'null' }, { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$' }],
      description: 'Future UTC instant only for deferred state; null otherwise.',
    },
    evidence: {
      type: 'array',
      maxItems: 10,
      items: answerDraftSchema.properties.claims.items.properties.citations.items,
    },
    record_id: {
      type: 'string',
      pattern: '^[a-zA-Z0-9_-]{1,100}$',
      description: 'Exact existing work ID for an update; omit when creating.',
    },
    expected_version: {
      type: 'integer',
      minimum: 0,
      description: 'Zero when creating; exact current positive version when updating.',
    },
  },
};
export const COS_PROTOCOL = 'cos-rpc/v1';
export const COS_MAX_BYTES = 65536;
export const COS_WAIT_MS = 15000;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}
export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export type CosMethod =
  | 'cos_context_get'
  | 'cos_change_propose'
  | 'cos_work_change_propose'
  | 'cos_work_read'
  | 'cos_mission_request'
  | 'cos_mission_get'
  | 'cos_mission_cancel'
  | 'cos_mission_result_get'
  | 'cos_mission_review'
  | 'cos_team_request'
  | 'cos_team_get'
  | 'cos_team_cancel'
  | 'cos_brief_schedule_propose'
  | 'cos_brief_request'
  | 'cos_proactive_policy_propose'
  | 'cos_proactive_batch'
  | 'cos_proactive_submit'
  | 'cos_proactive_disposition_propose'
  | 'cos_proactive_history'
  | 'cos_mandate_propose'
  | 'cos_request_status'
  | 'cos_knowledge_search'
  | 'cos_source_get'
  | 'cos_source_change_propose'
  | 'cos_answer_prepare'
  | 'cos_answer_get'
  | 'cos_calendar_read';
export type CosRequest = {
  protocol: typeof COS_PROTOCOL;
  request_id: string;
  method: CosMethod;
  params: Record<string, unknown>;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));
export type CalendarReadInput = {
  binding_id: string;
  calendar_id: string;
  time_min: string;
  time_max: string;
  limit?: number;
  offset?: number;
};
export function validCalendarReadInput(value: unknown): value is CalendarReadInput {
  const instant = (v: unknown) =>
    typeof v === 'string' &&
    v.length <= 80 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(v);
  return (
    object(value) &&
    keys(value, ['binding_id', 'calendar_id', 'time_min', 'time_max', 'limit', 'offset']) &&
    typeof value.binding_id === 'string' &&
    uuid.test(value.binding_id) &&
    typeof value.calendar_id === 'string' &&
    value.calendar_id.length > 0 &&
    value.calendar_id.length <= 1024 &&
    !/[\s\u007f-\u009f]/u.test(value.calendar_id) &&
    !['.', '..'].includes(value.calendar_id) &&
    instant(value.time_min) &&
    instant(value.time_max) &&
    (value.limit === undefined ||
      (Number.isInteger(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 5)) &&
    (value.offset === undefined ||
      (Number.isInteger(value.offset) && Number(value.offset) >= 0 && Number(value.offset) <= 5000))
  );
}

export function validRequest(value: unknown): value is CosRequest {
  if (!object(value) || !keys(value, ['protocol', 'request_id', 'method', 'params'])) return false;
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return false;
  }
  if (
    new TextEncoder().encode(encoded).length > COS_MAX_BYTES ||
    value.protocol !== COS_PROTOCOL ||
    typeof value.request_id !== 'string' ||
    !uuid.test(value.request_id) ||
    !object(value.params)
  )
    return false;
  if (value.method === 'cos_brief_request') {
    if ('artifact_id' in value.params)
      return (
        keys(value.params, ['artifact_id']) &&
        typeof value.params.artifact_id === 'string' &&
        /^[a-f0-9]{64}-[a-f0-9]{64}$/.test(value.params.artifact_id)
      );
    if (
      !keys(value.params, ['time_zone']) ||
      typeof value.params.time_zone !== 'string' ||
      value.params.time_zone.length > 100 ||
      /^[+-]/.test(value.params.time_zone)
    )
      return false;
    try {
      new Intl.DateTimeFormat('en', { timeZone: value.params.time_zone });
      return true;
    } catch (error) {
      if (error instanceof RangeError) return false;
      throw error;
    }
  }
  if (value.method === 'cos_context_get')
    return (
      keys(value.params, ['view', 'calendar_offset']) &&
      value.params.view === 'today' &&
      (value.params.calendar_offset === undefined ||
        (Number.isInteger(value.params.calendar_offset) &&
          Number(value.params.calendar_offset) >= 0 &&
          Number(value.params.calendar_offset) <= 10000))
    );
  if (value.method === 'cos_calendar_read') return validCalendarReadInput(value.params);
  if (value.method === 'cos_request_status')
    return (
      keys(value.params, ['request_id']) &&
      typeof value.params.request_id === 'string' &&
      uuid.test(value.params.request_id)
    );
  if (value.method === 'cos_change_propose') return keys(value.params, ['change']) && validChange(value.params.change);
  if (value.method === 'cos_work_change_propose')
    return keys(value.params, ['change']) && validWorkChange(value.params.change);
  if (value.method === 'cos_work_read') return validWorkRead(value.params);
  if (value.method === 'cos_mandate_propose')
    return keys(value.params, ['change']) && validMandateChange(value.params.change);
  if (value.method === 'cos_proactive_policy_propose')
    return keys(value.params, ['change']) && validProactivePolicyChange(value.params.change);
  if (value.method === 'cos_proactive_batch') return Object.keys(value.params).length === 0;
  if (value.method === 'cos_proactive_submit')
    return (
      keys(value.params, ['batch_id', 'draft']) &&
      typeof value.params.batch_id === 'string' &&
      /^batch-[a-f0-9]{64}$/.test(value.params.batch_id) &&
      validProactiveDraft(value.params.draft)
    );
  if (value.method === 'cos_proactive_disposition_propose')
    return keys(value.params, ['request']) && validProactiveDisposition(value.params.request);
  if (value.method === 'cos_proactive_history')
    return (
      keys(value.params, ['offset']) &&
      (value.params.offset === undefined ||
        (Number.isSafeInteger(value.params.offset) &&
          Number(value.params.offset) >= 0 &&
          Number(value.params.offset) <= 10000))
    );
  if (value.method === 'cos_mission_request')
    return keys(value.params, ['request']) && validMissionRequest(value.params.request);
  if (value.method === 'cos_team_request')
    return keys(value.params, ['request']) && validTeamRequest(value.params.request);
  if (value.method === 'cos_team_get' || value.method === 'cos_team_cancel')
    return (
      keys(value.params, ['team_id']) &&
      typeof value.params.team_id === 'string' &&
      /^team-[a-f0-9]{64}$/.test(value.params.team_id)
    );
  if (value.method === 'cos_mission_review')
    return keys(value.params, ['review']) && validMissionReview(value.params.review);
  if (value.method === 'cos_mission_result_get')
    return (
      keys(value.params, ['mission_id', 'submission_id']) &&
      typeof value.params.mission_id === 'string' &&
      /^[a-zA-Z0-9_-]{1,100}$/.test(value.params.mission_id) &&
      typeof value.params.submission_id === 'string' &&
      uuid.test(value.params.submission_id)
    );
  if (value.method === 'cos_mission_get' || value.method === 'cos_mission_cancel')
    return (
      keys(value.params, ['mission_id']) &&
      typeof value.params.mission_id === 'string' &&
      /^[a-zA-Z0-9_-]{1,100}$/.test(value.params.mission_id)
    );
  if (value.method === 'cos_brief_schedule_propose')
    return keys(value.params, ['change']) && validScheduleChange(value.params.change);
  if (value.method === 'cos_source_change_propose')
    return keys(value.params, ['change']) && validSourceChange(value.params.change);
  if (value.method === 'cos_answer_prepare')
    return keys(value.params, ['draft']) && validAnswerDraft(value.params.draft);
  if (value.method === 'cos_answer_get')
    return (
      keys(value.params, ['artifact_id']) &&
      typeof value.params.artifact_id === 'string' &&
      /^[0-9a-f]{64}-[0-9a-f]{64}$/.test(value.params.artifact_id)
    );
  const identifier = (id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
  if (value.method === 'cos_knowledge_search')
    return (
      keys(value.params, ['query', 'limit', 'offset', 'source_id', 'project_id']) &&
      typeof value.params.query === 'string' &&
      value.params.query.length <= 400 &&
      (value.params.limit === undefined ||
        (Number.isInteger(value.params.limit) && Number(value.params.limit) >= 1 && Number(value.params.limit) <= 5)) &&
      (value.params.offset === undefined ||
        (Number.isInteger(value.params.offset) &&
          Number(value.params.offset) >= 0 &&
          Number(value.params.offset) <= 10000)) &&
      (value.params.source_id === undefined || identifier(value.params.source_id)) &&
      (value.params.project_id === undefined || identifier(value.params.project_id))
    );
  if (value.method === 'cos_source_get')
    return (
      keys(value.params, ['source_id', 'revision_id', 'ordinal']) &&
      identifier(value.params.source_id) &&
      typeof value.params.revision_id === 'string' &&
      uuid.test(value.params.revision_id) &&
      Number.isInteger(value.params.ordinal) &&
      Number(value.params.ordinal) >= 0 &&
      Number(value.params.ordinal) <= 1000000
    );
  return false;
}

export type SourceChange = {
  kind: 'source_revoke' | 'source_delete';
  source_id: string;
  expected_version: number;
  reason: string;
};
export function validSourceChange(value: unknown): value is SourceChange {
  return (
    object(value) &&
    keys(value, ['kind', 'source_id', 'expected_version', 'reason']) &&
    ['source_revoke', 'source_delete'].includes(String(value.kind)) &&
    typeof value.source_id === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(value.source_id) &&
    Number.isSafeInteger(value.expected_version) &&
    Number(value.expected_version) > 0 &&
    typeof value.reason === 'string' &&
    value.reason.trim().length > 0 &&
    value.reason.length <= 2000
  );
}
export type WorkDue =
  | { kind: 'date'; date: string; time_zone: string }
  | { kind: 'instant'; at: string; time_zone: string };
export type WorkChange = {
  kind: 'commitment' | 'decision';
  title: string;
  description: string;
  reason: string;
  state: 'confirmed' | 'completed' | 'needed' | 'decided' | 'deferred' | 'dismissed';
  project_id: string | null;
  due: WorkDue | null;
  defer_until: string | null;
  evidence: AnswerCitation[];
  record_id?: string;
  expected_version: number;
};
const workId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
export type WorkRead = { view: 'open' | 'all'; offset?: number } | { record_id: string; version?: number };
export function validWorkRead(v: unknown): v is WorkRead {
  return (
    object(v) &&
    ('record_id' in v
      ? keys(v, ['record_id', 'version']) &&
        workId(v.record_id) &&
        (v.version === undefined || (Number.isSafeInteger(v.version) && Number(v.version) > 0))
      : keys(v, ['view', 'offset']) &&
        ['open', 'all'].includes(String(v.view)) &&
        (v.offset === undefined || (Number.isInteger(v.offset) && Number(v.offset) >= 0 && Number(v.offset) <= 10000)))
  );
}
const workText = (v: unknown, max: number): v is string =>
  typeof v === 'string' &&
  v.length <= max &&
  Buffer.from(v).toString('utf8') === v &&
  [...v].every((character) => {
    const code = character.codePointAt(0)!;
    return code === 9 || code === 10 || code === 13 || (code >= 32 && (code < 127 || code > 159));
  });
const calendarDate = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const at = Date.parse(v + 'T00:00:00Z');
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === v;
};
export function validWorkInstant(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v) &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString() === v.slice(0, -1) + '.000Z'
  );
}
function workZone(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 100 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(v)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: v }).format(0);
    return true;
  } catch {
    return false;
  }
}
export function validWorkDue(v: unknown): v is WorkDue {
  return (
    object(v) &&
    workZone(v.time_zone) &&
    ((v.kind === 'date' && keys(v, ['kind', 'date', 'time_zone']) && calendarDate(v.date)) ||
      (v.kind === 'instant' && keys(v, ['kind', 'at', 'time_zone']) && validWorkInstant(v.at)))
  );
}
/** A valid proposal is still unapproved; only the host's durable owner decision may apply it. */
export function validWorkChange(v: unknown): v is WorkChange {
  if (
    !object(v) ||
    !keys(v, [
      'kind',
      'title',
      'description',
      'reason',
      'state',
      'project_id',
      'due',
      'defer_until',
      'evidence',
      'record_id',
      'expected_version',
    ])
  )
    return false;
  if (!['commitment', 'decision'].includes(String(v.kind))) return false;
  const states =
    v.kind === 'commitment'
      ? ['confirmed', 'completed', 'deferred', 'dismissed']
      : ['needed', 'decided', 'deferred', 'dismissed'];
  if (!states.includes(String(v.state)) || !Number.isSafeInteger(v.expected_version)) return false;
  if (v.record_id === undefined) {
    if (v.expected_version !== 0 || v.state !== (v.kind === 'commitment' ? 'confirmed' : 'needed')) return false;
  } else if (!workId(v.record_id) || Number(v.expected_version) < 1) return false;
  if (v.state === 'deferred' ? !validWorkInstant(v.defer_until) : v.defer_until !== null) return false;
  return (
    workText(v.title, 200) &&
    v.title.trim().length > 0 &&
    v.title.length <= 200 &&
    workText(v.description, 8000) &&
    v.description.length <= 8000 &&
    workText(v.reason, 2000) &&
    v.reason.trim().length > 0 &&
    v.reason.length <= 2000 &&
    (v.project_id === null || workId(v.project_id)) &&
    (v.due === null || validWorkDue(v.due)) &&
    Array.isArray(v.evidence) &&
    v.evidence.length <= 10 &&
    v.evidence.every(validAnswerCitation) &&
    new Set(v.evidence.map(canonical)).size === v.evidence.length
  );
}
/** Host-created approval envelope. Admission verifies the entire body against immutable storage. */
export type MissionChange = {
  kind: 'research_mission';
  mission_id: string;
  work_order_digest: string;
  work_order: Record<string, unknown>;
};
export function validMissionChange(value: unknown): value is MissionChange {
  return (
    object(value) &&
    keys(value, ['kind', 'mission_id', 'work_order_digest', 'work_order']) &&
    Object.keys(value).length === 4 &&
    value.kind === 'research_mission' &&
    typeof value.mission_id === 'string' &&
    /^mission-[a-f0-9]{64}$/.test(value.mission_id) &&
    typeof value.work_order_digest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.work_order_digest) &&
    object(value.work_order) &&
    Buffer.byteLength(JSON.stringify(value.work_order)) <= 24576 &&
    digest(value.work_order) === value.work_order_digest
  );
}
/** One owner approval covers this immutable graph, never a worker-created extension. */
export type TeamChange = {
  kind: 'specialist_team';
  team_id: string;
  work_order_digest: string;
  work_order: Record<string, unknown>;
};
export function validTeamChange(value: unknown): value is TeamChange {
  return (
    object(value) &&
    keys(value, ['kind', 'team_id', 'work_order_digest', 'work_order']) &&
    Object.keys(value).length === 4 &&
    value.kind === 'specialist_team' &&
    typeof value.team_id === 'string' &&
    /^team-[a-f0-9]{64}$/.test(value.team_id) &&
    typeof value.work_order_digest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.work_order_digest) &&
    object(value.work_order) &&
    Buffer.byteLength(JSON.stringify(value.work_order)) <= 49152 &&
    digest(value.work_order) === value.work_order_digest
  );
}
export type ProactiveDispositionChange = {
  kind: 'proactive_disposition';
  request: ProactiveDispositionRequest;
  mission: MissionChange | null;
};
export function validProactiveDispositionChange(value: unknown): value is ProactiveDispositionChange {
  return (
    object(value) &&
    Object.keys(value).length === 3 &&
    keys(value, ['kind', 'request', 'mission']) &&
    value.kind === 'proactive_disposition' &&
    validProactiveDisposition(value.request) &&
    (value.mission === null || (value.request.decision === 'accept' && validMissionChange(value.mission)))
  );
}
export type ProposalChange =
  | Change
  | SourceChange
  | WorkChange
  | ScheduleChange
  | MissionChange
  | TeamChange
  | ProactivePolicyChange
  | ProactiveDispositionChange
  | MandateChange;
export function validProposalChange(value: unknown): value is ProposalChange {
  return (
    validChange(value) ||
    validSourceChange(value) ||
    validWorkChange(value) ||
    validScheduleChange(value) ||
    validProactivePolicyChange(value) ||
    validProactiveDispositionChange(value) ||
    validMandateChange(value) ||
    validMissionChange(value) ||
    validTeamChange(value)
  );
}

export type CosResponse = {
  protocol: typeof COS_PROTOCOL;
  request_id: string;
  status: 'ok' | 'pending' | 'denied' | 'conflict' | 'unavailable';
  result?: unknown;
};
export function validResponse(value: unknown, requestId: string): value is CosResponse {
  if (!object(value) || !keys(value, ['protocol', 'request_id', 'status', 'result'])) return false;
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > COS_MAX_BYTES) return false;
  } catch {
    return false;
  }
  return (
    value.protocol === COS_PROTOCOL &&
    value.request_id === requestId &&
    ['ok', 'pending', 'denied', 'conflict', 'unavailable'].includes(String(value.status))
  );
}

export type Change = {
  kind: 'charter' | 'goal' | 'project';
  title: string;
  description: string;
  lifecycle: 'active' | 'inactive';
  reason: string;
  record_id?: string;
  expected_version: number;
};
export function validChange(value: unknown): value is Change {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some(
      (key) => !['kind', 'title', 'description', 'lifecycle', 'reason', 'record_id', 'expected_version'].includes(key),
    )
  )
    return false;
  return (
    ['charter', 'goal', 'project'].includes(String(row.kind)) &&
    typeof row.title === 'string' &&
    row.title.trim().length > 0 &&
    row.title.length <= 200 &&
    typeof row.description === 'string' &&
    row.description.length <= 8000 &&
    typeof row.reason === 'string' &&
    row.reason.length > 0 &&
    row.reason.length <= 2000 &&
    ['active', 'inactive'].includes(String(row.lifecycle)) &&
    Number.isSafeInteger(row.expected_version) &&
    Number(row.expected_version) >= 0 &&
    (row.record_id === undefined
      ? row.expected_version === 0
      : typeof row.record_id === 'string' &&
        /^[a-zA-Z0-9_-]{1,100}$/.test(row.record_id) &&
        Number(row.expected_version) > 0)
  );
}
