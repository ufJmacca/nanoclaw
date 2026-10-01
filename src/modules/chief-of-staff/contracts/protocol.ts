/** Canonical CoS wire contract; copied verbatim into the runner and checked for drift. */
import { createHash } from 'node:crypto';
import { validAnswerDraft } from './answer-protocol.js';
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
export type ProposalChange = Change | SourceChange;
export function validProposalChange(value: unknown): value is ProposalChange {
  return validChange(value) || validSourceChange(value);
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
