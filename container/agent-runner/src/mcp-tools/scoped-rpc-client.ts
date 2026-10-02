/** Native SQLite request/reply transport. Only trusted fixed profiles select validators and actions. */
import { randomUUID } from 'node:crypto';
import { COS_WAIT_MS, digest } from './generated/cos-protocol.js';
import { openInboundDb } from '../db/connection.js';
import { writeMessageOut } from '../db/messages-out.js';

export async function executeScopedRequest<Request extends { request_id: string }, Response>(
  request: Request,
  options: {
    protocol: string;
    action: 'cos_rpc' | 'cos_mission_rpc';
    prefix: string;
    validRequest(value: unknown): value is Request;
    validResponse(value: unknown, requestId: string): value is Response;
    response(status: 'pending' | 'denied' | 'unavailable'): Response;
  },
  waitMs = COS_WAIT_MS,
  signal?: AbortSignal,
): Promise<Response> {
  const response = options.response;
  if (signal?.aborted || process.env.NANOCLAW_COS_PROTOCOL !== options.protocol) return response('unavailable');
  if (!options.validRequest(request)) return response('denied');
  const hash = digest(request);
  const deliveryId = randomUUID();
  const read = (): Response | null => {
    const db = openInboundDb();
    try {
      const row = db
        .query('SELECT response FROM cos_rpc_responses WHERE request_id=? AND payload_hash=? AND delivery_id=?')
        .get(request.request_id, hash, deliveryId) as { response: string } | null;
      if (!row) return null;
      const value: unknown = JSON.parse(row.response);
      return options.validResponse(value, request.request_id) ? value : response('unavailable');
    } finally {
      db.close();
    }
  };
  try {
    read();
  } catch {
    return response('unavailable');
  }
  writeMessageOut({
    id: options.prefix + deliveryId,
    kind: 'system',
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify({ action: options.action, request, delivery_id: deliveryId }),
  });
  const end = Date.now() + Math.max(1, Math.min(waitMs, COS_WAIT_MS));
  do {
    if (signal?.aborted) return response('unavailable');
    try {
      const value = read();
      if (value) return value;
    } catch {
      return response('unavailable');
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, end - Date.now()))));
  } while (Date.now() < end);
  return response(signal?.aborted ? 'unavailable' : 'pending');
}
