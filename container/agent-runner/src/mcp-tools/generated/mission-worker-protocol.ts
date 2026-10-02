/** Canonical specialist-only wire contract; copied verbatim into the worker. */
import { validMissionResult, type MissionResult } from './mission-result.js';
import { validTeamReview, type TeamReview } from './team-review.js';
export type MissionWorkerResult = MissionResult | TeamReview;
/** The wire carries both bounded shapes; only the current host-pinned template can select one. */
export const validMissionWorkerResult = (v: unknown): v is MissionWorkerResult =>
  validMissionResult(v) || validTeamReview(v);
export const MISSION_WORKER_PROTOCOL = 'cos-mission-rpc/v1' as const;
export const MISSION_WORKER_REQUEST_BYTES = 24576;
export const MISSION_WORKER_RESPONSE_BYTES = 98304;
export type MissionWorkerRequest = {
  protocol: typeof MISSION_WORKER_PROTOCOL;
  request_id: string;
} & (
  | { method: 'cos_mission_context_get'; params: Record<string, never> }
  | { method: 'cos_result_submit'; params: { result: MissionWorkerResult } }
);
export type MissionWorkerResponse = {
  protocol: typeof MISSION_WORKER_PROTOCOL;
  request_id: string;
  status: 'ok' | 'pending' | 'denied' | 'conflict' | 'unavailable';
  result?: unknown;
};
export type MissionRpcEnvelope = {
  action: 'cos_mission_rpc';
  request: MissionWorkerRequest;
  delivery_id: string;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const bytes = (v: unknown, max: number) => {
  try {
    return Buffer.byteLength(JSON.stringify(v)) <= max;
  } catch {
    return false;
  }
};
export function validMissionWorkerRequest(v: unknown): v is MissionWorkerRequest {
  if (
    !object(v) ||
    Object.keys(v).length !== 4 ||
    Object.keys(v).some((key) => !['protocol', 'request_id', 'method', 'params'].includes(key)) ||
    v.protocol !== MISSION_WORKER_PROTOCOL ||
    !uuid(v.request_id) ||
    !object(v.params) ||
    !bytes(v, MISSION_WORKER_REQUEST_BYTES)
  )
    return false;
  if (v.method === 'cos_mission_context_get') return Object.keys(v.params).length === 0;
  return (
    v.method === 'cos_result_submit' &&
    Object.keys(v.params).length === 1 &&
    Object.hasOwn(v.params, 'result') &&
    validMissionWorkerResult(v.params.result)
  );
}
export function validMissionRpcEnvelope(v: unknown): v is MissionRpcEnvelope {
  return (
    object(v) &&
    Object.keys(v).length === 3 &&
    Object.keys(v).every((key) => ['action', 'request', 'delivery_id'].includes(key)) &&
    v.action === 'cos_mission_rpc' &&
    uuid(v.delivery_id) &&
    validMissionWorkerRequest(v.request)
  );
}
export function validMissionWorkerResponse(v: unknown, requestId: string): v is MissionWorkerResponse {
  return (
    object(v) &&
    Object.keys(v).every((key) => ['protocol', 'request_id', 'status', 'result'].includes(key)) &&
    v.protocol === MISSION_WORKER_PROTOCOL &&
    uuid(v.request_id) &&
    v.request_id === requestId &&
    ['ok', 'pending', 'denied', 'conflict', 'unavailable'].includes(String(v.status)) &&
    bytes(v, MISSION_WORKER_RESPONSE_BYTES)
  );
}
