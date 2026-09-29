import { createHash } from 'node:crypto';

export type Change = {
  kind: 'charter' | 'goal' | 'project';
  title: string;
  description: string;
  lifecycle: 'active' | 'inactive';
  reason: string;
  record_id?: string;
  expected_version: number;
};
export type Context = { scopeId: string; ownerId: string; sessionId: string; agentGroupId: string; ingressId: string };
export type Result = { status: 'ok' | 'pending' | 'denied' | 'conflict' | 'unavailable'; [key: string]: unknown };

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
