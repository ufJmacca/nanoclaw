import type { CosRequest, CosResponse } from './generated/cos-protocol.js';
import { COS_PROTOCOL, COS_WAIT_MS, digest, validRequest, validResponse } from './generated/cos-protocol.js';
import { openInboundDb } from '../db/connection.js';
import { writeMessageOut } from '../db/messages-out.js';
import { randomUUID } from 'node:crypto';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

export async function executeCosRequest(request: CosRequest, waitMs = COS_WAIT_MS): Promise<CosResponse> {
  const response = (status: CosResponse['status']): CosResponse => ({
    protocol: COS_PROTOCOL,
    request_id: request.request_id,
    status,
  });
  if (process.env.NANOCLAW_COS_PROTOCOL !== COS_PROTOCOL) return response('unavailable');
  if (!validRequest(request)) return response('denied');
  const hash = digest(request);
  const deliveryId = randomUUID();
  const read = (): CosResponse | null => {
    const db = openInboundDb();
    try {
      const row = db
        .query('SELECT response FROM cos_rpc_responses WHERE request_id=? AND payload_hash=? AND delivery_id=?')
        .get(request.request_id, hash, deliveryId) as { response: string } | null;
      if (!row) return null;
      const value: unknown = JSON.parse(row.response);
      return validResponse(value, request.request_id) ? value : response('unavailable');
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
    id: 'cos-' + deliveryId,
    kind: 'system',
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify({ action: 'cos_rpc', request, delivery_id: deliveryId }),
  });
  const end = Date.now() + Math.max(1, Math.min(waitMs, COS_WAIT_MS));
  do {
    try {
      const value = read();
      if (value) return value;
    } catch {
      return response('unavailable');
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, end - Date.now()))));
  } while (Date.now() < end);
  return response('pending');
}

export const cosTools: McpToolDefinition[] = (
  ['cos_context_get', 'cos_change_propose', 'cos_request_status'] as const
).map<McpToolDefinition>((method) => ({
  tool: {
    name: method,
    description:
      method === 'cos_context_get'
        ? 'Read approved priorities with record provenance. Rankings are advice.'
        : method === 'cos_change_propose'
          ? 'Propose an exact internal change for owner approval. This never approves or applies it.'
          : 'Reconcile a pending request using its original request ID.',
    inputSchema: {
      type: 'object',
      properties: (method === 'cos_change_propose'
        ? {
            request_id: { type: 'string', format: 'uuid' },
            change: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: ['charter', 'goal', 'project'] },
                title: { type: 'string', minLength: 1, maxLength: 200 },
                description: { type: 'string', maxLength: 8000 },
                lifecycle: { type: 'string', enum: ['active', 'inactive'] },
                reason: { type: 'string', minLength: 1, maxLength: 2000 },
                record_id: {
                  type: 'string',
                  pattern: '^[a-zA-Z0-9_-]{1,100}$',
                  description: 'Existing record ID for an update; omit when creating.',
                },
                expected_version: {
                  type: 'integer',
                  minimum: 0,
                  description: 'Zero when creating; the current positive version when updating.',
                },
              },
              required: ['kind', 'title', 'description', 'lifecycle', 'reason', 'expected_version'],
            },
          }
        : method === 'cos_request_status'
          ? { request_id: { type: 'string' } }
          : { view: { type: 'string', enum: ['today'] } }) as Record<string, object>,
      required: method === 'cos_change_propose' ? ['change'] : method === 'cos_request_status' ? ['request_id'] : [],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const id = method === 'cos_change_propose' && typeof args.request_id === 'string' ? args.request_id : randomUUID();
    const params =
      method === 'cos_context_get'
        ? { view: args.view ?? 'today' }
        : method === 'cos_change_propose'
          ? { change: args.change }
          : { request_id: args.request_id };
    const value = await executeCosRequest({ protocol: COS_PROTOCOL, request_id: id, method, params });
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
  },
}));
if (process.env.NANOCLAW_COS_PROTOCOL === COS_PROTOCOL) registerTools(cosTools);
