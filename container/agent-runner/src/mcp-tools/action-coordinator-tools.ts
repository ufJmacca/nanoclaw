import { randomUUID } from 'node:crypto';
import { COS_PROTOCOL, validRequest, type CosRequest, type CosResponse } from './generated/cos-protocol.js';
import { calendarActionRequestSchema } from './generated/action-protocol.js';
import type { McpToolDefinition } from './types.js';
const actionId = { type: 'string', pattern: '^action-[a-f0-9]{64}$' };
const definitions = {
  cos_action_propose: {
    required: ['request_id', 'request'],
    properties: { request_id: { type: 'string', format: 'uuid' }, request: calendarActionRequestSchema },
    description:
      'Propose one ordinary private focus-work block on an explicitly selected operator-owned calendar. Supply exact UTC start/end, timezone and a minimal title/description, with no guests. The host checks fresh complete availability and shows an exact owner approval card. This tool does not approve or create an event. A conflict requires a new proposal. Private visibility remains subject to existing account sharing.',
  },
  cos_action_get: {
    required: ['action_id'],
    properties: { action_id: actionId },
    description:
      'Read the private owner-scoped action status and the original event identity. Only a semantically verified provider readback proves completion. Pending or uncertain is not success. This tool cannot execute or retry an action.',
  },
  cos_action_cancel: {
    required: ['action_id'],
    properties: { action_id: actionId },
    description:
      'Cancel an unexecuted owner action, or record cancellation of a possibly started action while preserving reconciliation. Cancellation never deletes or changes an existing calendar event. Read the resulting state; a verified event remains created.',
  },
} as const;
export function actionCoordinatorRequest(tool: unknown, args: unknown): CosRequest | null {
  if (
    typeof tool !== 'string' ||
    !Object.hasOwn(definitions, tool) ||
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args)
  )
    return null;
  const definition = definitions[tool as keyof typeof definitions],
    values = args as Record<string, unknown>;
  if (
    Object.keys(values).some((k) => !Object.hasOwn(definition.properties, k)) ||
    (definition.required as readonly string[]).some((k) => !Object.hasOwn(values, k))
  )
    return null;
  const request = {
    protocol: COS_PROTOCOL,
    request_id: values.request_id ?? randomUUID(),
    method: tool,
    params: Object.fromEntries(Object.entries(values).filter(([k]) => k !== 'request_id')),
  };
  return validRequest(request) ? request : null;
}
export function actionCoordinatorTools(execute: (request: CosRequest) => Promise<CosResponse>): McpToolDefinition[] {
  return Object.entries(definitions).map(([method, definition]) => ({
    tool: {
      name: method,
      description: definition.description,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: [...definition.required],
        properties: definition.properties,
      },
    },
    async handler(args) {
      const request = actionCoordinatorRequest(method, args),
        result = request
          ? await execute(request)
          : { protocol: COS_PROTOCOL, request_id: randomUUID(), status: 'denied' };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  }));
}
