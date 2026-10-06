import { randomUUID } from 'node:crypto';
import { COS_PROTOCOL, validRequest, type CosRequest, type CosResponse } from './generated/cos-protocol.js';
import {
  reviewCharterChangeSchema,
  strategyObservationChangeSchema,
  directionRequestSchema,
  reviewRequestSchema,
  reviewDraftSchema,
} from './generated/strategy-protocol.js';
import type { McpToolDefinition } from './types.js';

const requestId = { type: 'string', format: 'uuid' };
const reviewId = { type: 'string', pattern: '^review-[a-f0-9]{64}$' };
const revision = { type: 'integer', minimum: 1, maximum: 2147483646 };
const definitions = {
  cos_review_charter_propose: {
    required: ['request_id', 'change'],
    properties: { request_id: requestId, change: reviewCharterChangeSchema },
    description:
      'Propose a versioned owner-approved strategic review charter with selected initiatives, admitted sources, outcome measures, assumptions, resource limits, exploration allowance and dates. Cadence is manual. This grants no schedule or execution authority. Only use for an owner request in the main conversation.',
  },
  cos_strategy_observation_propose: {
    required: ['request_id', 'change'],
    properties: { request_id: requestId, change: strategyObservationChangeSchema },
    description:
      'Propose one exact outcome, assumption, attention-cost or actual-effort observation for owner approval. Distinguish evidence-backed, self-reported and unknown; cite exact admitted evidence. Tasks, missions and calendar allocation do not prove success or actual effort. Never invent owner feedback.',
  },
  cos_strategy_direction_propose: {
    required: ['request_id', 'request'],
    properties: { request_id: requestId, request: directionRequestSchema },
    description:
      'Propose one exact option from a verified review with current approved record and applied direction versions, and a rationale. The host derives the option and shows an owner approval preview. Approval is not success. This never cancels commitments, missions, mandates or calendar events; each consequence needs separate exact authority.',
  },
  cos_review_request: {
    required: ['request_id', 'request'],
    properties: { request_id: requestId, request: reviewRequestSchema },
    description:
      'Capture a bounded private strategic snapshot under the exact approved manual charter. Read selected initiatives, obligations, mission claims, decisions, applied directions and observations with coverage limits. Set previous_review_id to compare later evidence with immutable earlier advice using the same review identity. No analysis runs while the host holds its database connection.',
  },
  cos_review_submit: {
    required: ['request_id', 'review_id', 'revision', 'draft'],
    properties: { request_id: requestId, review_id: reviewId, revision, draft: reviewDraftSchema },
    description:
      'Submit an advisory draft against the exact captured snapshot. Preserve contradictory evidence, missing outcomes, uncertainty and forecasts. Include continue unchanged for each initiative; state trade-offs and opportunity cost. The host validates evidence and returns checked text. Publish that text unchanged; advice grants no execution or outcome status.',
  },
  cos_review_get: {
    required: ['review_id', 'revision'],
    properties: { review_id: reviewId, revision, historical: { type: 'boolean' } },
    description:
      'Read a checked private strategic review revision with fresh source and native-context permission. Use historical true for original advice after priorities change; it is labelled historical. Publish returned text unchanged. Denied or unavailable means do not reconstruct cached material. Only use in an owner-requested manual main turn.',
  },
} as const;
export const strategyCoordinatorToolNames = Object.keys(definitions);
export function strategyCoordinatorRequest(tool: unknown, args: unknown): CosRequest | null {
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
    Object.keys(values).some((key) => !Object.hasOwn(definition.properties, key)) ||
    (definition.required as readonly string[]).some((key) => !Object.hasOwn(values, key))
  )
    return null;
  const request = {
    protocol: COS_PROTOCOL,
    request_id: values.request_id ?? randomUUID(),
    method: tool,
    params: Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'request_id')),
  };
  return validRequest(request) ? request : null;
}
export function strategyCoordinatorTools(execute: (request: CosRequest) => Promise<CosResponse>): McpToolDefinition[] {
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
      const request = strategyCoordinatorRequest(method, args),
        result = request
          ? await execute(request)
          : { protocol: COS_PROTOCOL, request_id: randomUUID(), status: 'denied' };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  }));
}
