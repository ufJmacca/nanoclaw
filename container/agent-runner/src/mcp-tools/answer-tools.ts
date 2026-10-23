import { randomUUID } from 'node:crypto';
import { answerDraftSchema } from './generated/answer-protocol.js';
import { COS_PROTOCOL, type CosRequest, type CosResponse } from './generated/cos-protocol.js';
import type { McpToolDefinition } from './types.js';
import { coordinatorRequestIdSchema } from './coordinator-request-id.js';

/** Shared declarations for native tools and the fixed retained-context MCP adapter. */
export function createAnswerTools(execute: (request: CosRequest) => Promise<CosResponse>): McpToolDefinition[] {
  return (['cos_answer_prepare', 'cos_answer_get'] as const).map((method) => ({
    tool: {
      name: method,
      description:
        method === 'cos_answer_prepare'
          ? 'Prepare a checked reply with citations, then send only its returned text unchanged. For a complete zero-event calendar read, use kind answer, coverage limited, claims [], calendar coverage and calendar_window with the exact selected binding/calendar and instant bounds. The host proves the empty window and supplies freshness; never invent an uncited claim. Other facts require citations, exact quotations and labelled inferences. Missing evidence uses insufficient coverage with no claims. Clarification uses not_applicable and bounded questions. If supplying request_id, use a fresh valid UUID, not a descriptive label or all-zero UUID. An invalid-ID validation error means no operation was submitted. Retry a pending preparation with the same valid request ID and unchanged draft.'
          : 'Redisplay a checked answer after current source, calendar-window and record-version checks. Use before reusing old text; cached conversation is not publication permission.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: (method === 'cos_answer_prepare'
          ? { request_id: coordinatorRequestIdSchema, draft: answerDraftSchema }
          : { artifact_id: { type: 'string', pattern: '^[0-9a-f]{64}-[0-9a-f]{64}$' } }) as Record<string, object>,
        required: method === 'cos_answer_prepare' ? ['draft'] : ['artifact_id'],
      },
    },
    async handler(args) {
      const allowed = method === 'cos_answer_prepare' ? ['request_id', 'draft'] : ['artifact_id'];
      const requestId = typeof args.request_id === 'string' ? args.request_id : randomUUID();
      const result =
        Object.keys(args).some((key) => !allowed.includes(key)) ||
        (args.request_id !== undefined && typeof args.request_id !== 'string')
          ? { protocol: COS_PROTOCOL, request_id: requestId, status: 'denied' }
          : await execute({
              protocol: COS_PROTOCOL,
              request_id: requestId,
              method,
              params: method === 'cos_answer_prepare' ? { draft: args.draft } : args,
            });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  }));
}
