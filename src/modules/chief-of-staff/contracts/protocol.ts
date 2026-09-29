/** Canonical CoS wire contract; copied verbatim into the runner and checked for drift. */
import { createHash } from 'node:crypto';
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
export type CosMethod = 'cos_context_get' | 'cos_change_propose' | 'cos_request_status';
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
  if (value.method === 'cos_context_get') return keys(value.params, ['view']) && value.params.view === 'today';
  if (value.method === 'cos_request_status')
    return (
      keys(value.params, ['request_id']) &&
      typeof value.params.request_id === 'string' &&
      uuid.test(value.params.request_id)
    );
  if (value.method === 'cos_change_propose') return keys(value.params, ['change']) && validChange(value.params.change);
  return false;
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
