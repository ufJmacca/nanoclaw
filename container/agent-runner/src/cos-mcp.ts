/** Restricted CoS MCP entry point: no native scheduling, A2A or self-mod tools. */
import './mcp-tools/chief-of-staff.js';
import { startMcpServer } from './mcp-tools/server.js';
await startMcpServer();
