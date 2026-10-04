/** Fixed CoS mandate tools only; never import the ordinary tool barrel or database transport. */
import { mandateCoordinatorTools } from './mandate-coordinator-tools.js';
import { registerTools, startMcpServer } from './server.js';
import { callNativeMandateTool } from '../providers/codex-mandate-bridge.js';

const socket = process.env.NANOCLAW_COS_TOOL_SOCKET;
if (!socket) throw new Error('cos_tool_bridge_unavailable');
registerTools(
  mandateCoordinatorTools(async (request) => ({
    protocol: 'cos-rpc/v1',
    request_id: request.request_id,
    status: 'unavailable',
  })).map(({ tool }) => ({ tool, handler: (args) => callNativeMandateTool(socket, tool.name, args) })),
);
await startMcpServer();
