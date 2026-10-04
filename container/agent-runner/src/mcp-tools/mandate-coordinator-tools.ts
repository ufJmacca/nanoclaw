import { randomUUID } from 'node:crypto';
import { COS_PROTOCOL, validRequest, type CosRequest, type CosResponse } from './generated/cos-protocol.js';
import { mandateChangeSchema } from './generated/mandate-protocol.js';
import type { McpToolDefinition } from './types.js';
const definitions = {
  cos_mandate_propose: {
    required: ['request_id', 'change'],
    properties: { request_id: { type: 'string', format: 'uuid' }, change: mandateChangeSchema },
    description:
      'Propose a narrow standing meeting-preparation responsibility, or an exact-version renewal, replacement, pause, resume or revocation. Read standing_mandates in cos_context_get first. Show the complete selected sources/events, trigger, immutable template, budget, expiry, quiet hours and notification/escalation rules. Only the private owner confirmation grants authority. Model text cannot approve, trigger work, expand a revision or permit external messages/calendar writes.',
  },
  cos_mandate_activity: {
    required: ['mandate_id'],
    properties: {
      mandate_id: { type: 'string', pattern: '^mandate-[a-f0-9]{64}$' },
      offset: { type: 'integer', minimum: 0, maximum: 10000 },
    },
    description:
      'Read the private scoped activity digest: mandate, triggers, work/result references, conservative context exposures, reserved structural limits, usage uncertainty and decisions needed. Follow next_offset. A no-op is not work performed. Model turns are host reservations, not provider request counts; an unknown currency estimate is not zero cost. Source-derived result prose uses the checked mission-result reader.',
  },
} as const;
export function mandateCoordinatorRequest(tool: unknown, args: unknown): CosRequest | null {
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
export function mandateCoordinatorTools(execute: (request: CosRequest) => Promise<CosResponse>): McpToolDefinition[] {
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
      const request = mandateCoordinatorRequest(method, args),
        result = request
          ? await execute(request)
          : { protocol: COS_PROTOCOL, request_id: randomUUID(), status: 'denied' };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  }));
}
