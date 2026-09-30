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
import type { DynamicToolFunctionSpec, JsonRpcServerRequest } from './codex-app-server.js';

export const cosDynamicTools: DynamicToolFunctionSpec[] = cosTools.map(({ tool }) => ({
  type: 'function',
  name: tool.name,
  description: tool.description!,
  inputSchema: tool.inputSchema as DynamicToolFunctionSpec['inputSchema'],
}));
const denied = () => ({
  success: false,
  contentItems: [{ type: 'inputText' as const, text: 'CoS tool unavailable.' }],
});

function requestFor(tool: unknown, args: unknown): CosRequest | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const values = args as Record<string, unknown>;
  const proposal = tool === 'cos_change_propose' || tool === 'cos_source_change_propose';
  const allowed =
    tool === 'cos_context_get'
      ? ['view']
      : proposal
        ? ['request_id', 'change']
        : tool === 'cos_request_status'
          ? ['request_id']
          : tool === 'cos_knowledge_search'
            ? ['query', 'limit', 'offset', 'source_id', 'project_id']
            : tool === 'cos_source_get'
              ? ['source_id', 'revision_id', 'ordinal']
              : null;
  if (!allowed || Object.keys(values).some((key) => !allowed.includes(key))) return null;
  const request = {
    protocol: COS_PROTOCOL,
    request_id: proposal && values.request_id !== undefined ? values.request_id : randomUUID(),
    method: tool,
    params:
      tool === 'cos_context_get'
        ? { view: values.view ?? 'today' }
        : proposal
          ? { change: values.change }
          : tool === 'cos_request_status'
            ? { request_id: values.request_id }
            : values,
  };
  return validRequest(request) ? request : null;
}

export function createCosToolDispatch(
  execute: (request: CosRequest, signal: AbortSignal) => Promise<CosResponse> = (request, signal) =>
    executeCosRequest(request, COS_WAIT_MS, signal),
) {
  let closed = false;
  let active:
    | { thread: string; turn: string; controller: AbortController; calls: Set<string>; busy: boolean }
    | undefined;
  const endTurn = () => {
    active?.controller.abort();
    active = undefined;
  };
  return {
    beginTurn(thread: string, turn: string) {
      endTurn();
      if (closed || !thread || !turn) return;
      active = { thread, turn, controller: new AbortController(), calls: new Set(), busy: false };
    },
    endTurn,
    close() {
      closed = true;
      endTurn();
    },
    async handle(call: JsonRpcServerRequest) {
      const current = active,
        params = call.params;
      if (
        !current ||
        closed ||
        current.busy ||
        current.calls.size >= 32 ||
        call.method !== 'item/tool/call' ||
        params.threadId !== current.thread ||
        params.turnId !== current.turn ||
        (params.namespace !== undefined && params.namespace !== null) ||
        typeof params.callId !== 'string' ||
        !params.callId ||
        params.callId.length > 128 ||
        current.calls.has(params.callId)
      )
        return denied();
      let request: CosRequest | null;
      try {
        if (Buffer.byteLength(JSON.stringify(params)) > COS_MAX_BYTES) return denied();
        request = requestFor(params.tool, params.arguments);
      } catch {
        return denied();
      }
      if (!request) return denied();
      current.calls.add(params.callId);
      current.busy = true;
      const operation = new AbortController();
      const abort = () => operation.abort();
      current.controller.signal.addEventListener('abort', abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectCancelled!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        rejectCancelled = () => reject(new Error('cos_tool_cancelled'));
        operation.signal.addEventListener('abort', rejectCancelled, { once: true });
        timer = setTimeout(abort, COS_WAIT_MS + 1000);
      });
      try {
        const result = await Promise.race([execute(request, operation.signal), cancelled]);
        if (active !== current || operation.signal.aborted || !validResponse(result, request.request_id))
          return denied();
        return {
          success: result.status === 'ok' || result.status === 'pending',
          contentItems: [{ type: 'inputText' as const, text: JSON.stringify(result) }],
        };
      } catch {
        return denied();
      } finally {
        clearTimeout(timer);
        current.controller.signal.removeEventListener('abort', abort);
        operation.signal.removeEventListener('abort', rejectCancelled);
        current.busy = false;
      }
    },
  };
}
