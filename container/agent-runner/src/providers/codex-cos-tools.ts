/** Fixed native dispatch. No MCP discovery, generic tools or model-supplied authority. */
import { randomUUID } from 'node:crypto';
import { cosTools, executeCosRequest } from '../mcp-tools/chief-of-staff.js';
import {
  COS_MAX_BYTES,
  COS_PROTOCOL,
  COS_WAIT_MS,
  validRequest,
  validResponse,
  type CosRequest,
  type CosResponse,
} from '../mcp-tools/generated/cos-protocol.js';
import { createScopedToolDispatch } from './codex-scoped-tools.js';
import type { DynamicToolFunctionSpec } from './codex-app-server.js';

export const cosDynamicTools: DynamicToolFunctionSpec[] = cosTools.map(({ tool }) => ({
  type: 'function',
  name: tool.name,
  description: tool.description!,
  inputSchema: tool.inputSchema as DynamicToolFunctionSpec['inputSchema'],
}));

function requestFor(tool: unknown, args: unknown): CosRequest | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const values = args as Record<string, unknown>;
  const proposal =
    tool === 'cos_change_propose' ||
    tool === 'cos_source_change_propose' ||
    tool === 'cos_work_change_propose' ||
    tool === 'cos_brief_schedule_propose';
  const prepare = tool === 'cos_answer_prepare',
    brief = tool === 'cos_brief_request',
    mission = tool === 'cos_mission_request';
  const allowed = mission
    ? ['request_id', 'request']
    : tool === 'cos_mission_get' || tool === 'cos_mission_cancel'
      ? ['mission_id']
      : brief
        ? ['request_id', 'time_zone', 'artifact_id']
        : tool === 'cos_context_get'
          ? ['view', 'calendar_offset']
          : proposal
            ? ['request_id', 'change']
            : tool === 'cos_request_status'
              ? ['request_id']
              : tool === 'cos_knowledge_search'
                ? ['query', 'limit', 'offset', 'source_id', 'project_id']
                : tool === 'cos_source_get'
                  ? ['source_id', 'revision_id', 'ordinal']
                  : prepare
                    ? ['request_id', 'draft']
                    : tool === 'cos_answer_get'
                      ? ['artifact_id']
                      : tool === 'cos_calendar_read'
                        ? ['binding_id', 'calendar_id', 'time_min', 'time_max', 'limit', 'offset']
                        : tool === 'cos_work_read'
                          ? ['view', 'offset', 'record_id', 'version']
                          : null;
  if (!allowed || Object.keys(values).some((key) => !allowed.includes(key))) return null;
  const request = {
    protocol: COS_PROTOCOL,
    request_id:
      mission || ((proposal || prepare || brief) && values.request_id !== undefined) ? values.request_id : randomUUID(),
    method: tool,
    params: mission
      ? { request: values.request }
      : brief
        ? Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'request_id'))
        : tool === 'cos_context_get'
          ? { ...values, view: values.view ?? 'today' }
          : proposal
            ? { change: values.change }
            : tool === 'cos_request_status'
              ? { request_id: values.request_id }
              : prepare
                ? { draft: values.draft }
                : values,
  };
  return validRequest(request) ? request : null;
}

export function createCosToolDispatch(
  execute: (request: CosRequest, signal: AbortSignal) => Promise<CosResponse> = (request, signal) =>
    executeCosRequest(request, COS_WAIT_MS, signal),
) {
  return createScopedToolDispatch({ requestFor, execute, validResponse, maxBytes: COS_MAX_BYTES });
}
