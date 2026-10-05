/** Fixed CoS coordinator tools only; the historical entry point preserves retained native contexts. */
import { mandateCoordinatorTools } from './mandate-coordinator-tools.js';
import { actionCoordinatorTools } from './action-coordinator-tools.js';
import { registerTools, startMcpServer } from './server.js';
import { callNativeMandateTool } from '../providers/codex-mandate-bridge.js';

const socket = process.env.NANOCLAW_COS_TOOL_SOCKET;
if (!socket) throw new Error('cos_tool_bridge_unavailable');
const unavailable = async (request: { request_id: string }) => ({
  protocol: 'cos-rpc/v1' as const,
  request_id: request.request_id,
  status: 'unavailable' as const,
});
registerTools(
  [...mandateCoordinatorTools(unavailable), ...actionCoordinatorTools(unavailable)].map(({ tool }) => ({
    tool,
    handler: (args) => callNativeMandateTool(socket, tool.name, args),
  })),
);
await startMcpServer();
