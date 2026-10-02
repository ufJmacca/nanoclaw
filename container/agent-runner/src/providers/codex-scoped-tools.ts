/** Shared turn/cancellation fence; each trusted profile supplies its own closed request validator. */
import { COS_WAIT_MS } from '../mcp-tools/generated/cos-protocol.js';
import type { JsonRpcServerRequest } from './codex-app-server.js';

const denied = () => ({
  success: false,
  contentItems: [{ type: 'inputText' as const, text: 'CoS tool unavailable.' }],
});

export function createScopedToolDispatch<
  Request extends { request_id: string },
  Response extends { status: string },
>(options: {
  requestFor(tool: unknown, args: unknown): Request | null;
  execute(request: Request, signal: AbortSignal): Promise<Response>;
  validResponse(value: unknown, requestId: string): value is Response;
  maxBytes: number;
}) {
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
      let request: Request | null;
      try {
        if (Buffer.byteLength(JSON.stringify(params)) > options.maxBytes) return denied();
        request = options.requestFor(params.tool, params.arguments);
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
        const result = await Promise.race([options.execute(request, operation.signal), cancelled]);
        if (active !== current || operation.signal.aborted || !options.validResponse(result, request.request_id))
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
