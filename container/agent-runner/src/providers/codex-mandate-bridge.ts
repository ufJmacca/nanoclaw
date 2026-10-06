/** Fixed image-owned MCP adapter; every call crosses the existing native turn fence. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { COS_MAX_BYTES, COS_WAIT_MS } from '../mcp-tools/generated/cos-protocol.js';
import { tomlBasicString } from './codex-app-server.js';
import type { createCosToolDispatch } from './codex-cos-tools.js';
import { strategyCoordinatorToolNames } from '../mcp-tools/strategy-coordinator-tools.js';

type McpResult = { content: { type: 'text'; text: string }[]; isError: boolean };
const unavailable = (): McpResult => ({ content: [{ type: 'text', text: 'CoS tool unavailable.' }], isError: true });
const tools = new Set([
  'cos_mandate_activity',
  'cos_mandate_propose',
  'cos_action_propose',
  'cos_action_get',
  'cos_action_cancel',
  ...strategyCoordinatorToolNames,
]);

export async function createMandateToolBridge(
  dispatch: ReturnType<typeof createCosToolDispatch>,
  directory = '/run/cos',
) {
  const stat = fs.lstatSync(directory);
  if (
    !path.isAbsolute(directory) ||
    fs.realpathSync(directory) !== directory ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('cos_tool_bridge_unavailable');
  const socket = path.join(directory, 'mandate-' + randomUUID() + '.sock');
  let active: { thread: string; turn: string } | undefined,
    closed = false;
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    const reply = (result: McpResult) => {
      if (!response.destroyed) response.end(JSON.stringify(result));
    };
    if (request.method !== 'POST' || request.url !== '/tool' || closed || !active) {
      request.resume();
      reply(unavailable());
      return;
    }
    const current = active;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > COS_MAX_BYTES) {
          reply(unavailable());
          request.destroy();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        reply(unavailable());
        return;
      }
      const input = value as Record<string, unknown>;
      if (
        Object.keys(input).length !== 2 ||
        !Object.hasOwn(input, 'arguments') ||
        typeof input.tool !== 'string' ||
        !tools.has(input.tool) ||
        active !== current ||
        closed
      ) {
        reply(unavailable());
        return;
      }
      const id = randomUUID();
      const result = await dispatch.handle({
        id: 0,
        method: 'item/tool/call',
        params: {
          threadId: current.thread,
          turnId: current.turn,
          callId: 'mandate-mcp-' + id,
          tool: input.tool,
          arguments: input.arguments,
        },
      });
      if (active !== current || closed || !result.success) {
        reply(unavailable());
        return;
      }
      const content = result.contentItems.map((item) => ({ type: 'text' as const, text: item.text }));
      const converted: McpResult = { content, isError: false };
      reply(Buffer.byteLength(JSON.stringify(converted)) <= COS_MAX_BYTES ? converted : unavailable());
    } catch {
      reply(unavailable());
    }
  });
  server.requestTimeout = COS_WAIT_MS + 2000;
  server.headersTimeout = 5000;
  server.maxConnections = 4;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  fs.chmodSync(socket, 0o600);
  const configuration = [
    '[mcp_servers.nanoclaw_cos_mandates]',
    'command = "/usr/local/bin/bun"',
    'args = ["/app/src/mcp-tools/native-mandate-server.ts"]',
    'required = true',
    'env_vars = []',
    `enabled_tools = ${JSON.stringify([...tools])}`,
    'default_tools_approval_mode = "prompt"',
    '[mcp_servers.nanoclaw_cos_mandates.env]',
    `NANOCLAW_COS_TOOL_SOCKET = ${tomlBasicString(socket)}`,
    // Keep the existing server key so retained native threads gain tools without a new context.
    // These internal RPCs cannot grant owner approval or perform an external action.
    // The dispatcher and trusted host still enforce all actual authority checks.
    ...[...tools].flatMap((tool) => [`[mcp_servers.nanoclaw_cos_mandates.tools.${tool}]`, 'approval_mode = "approve"']),
    '',
  ].join('\n');
  return {
    socket,
    configuration,
    beginTurn(thread: string, turn: string) {
      active = closed ? undefined : { thread, turn };
      dispatch.beginTurn(thread, turn);
    },
    endTurn() {
      active = undefined;
      dispatch.endTurn();
    },
    async close() {
      if (closed) return;
      closed = true;
      active = undefined;
      dispatch.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Node removes its own listening socket. Never unlink a replacement path.
    },
  };
}

/** Used only by the image's fixed coordinator MCP entry point. No URL or command input. */
export async function callNativeMandateTool(socket: string, tool: string, args: unknown): Promise<McpResult> {
  try {
    const stat = fs.lstatSync(socket);
    if (
      !path.isAbsolute(socket) ||
      !stat.isSocket() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      !tools.has(tool)
    )
      return unavailable();
    const body = JSON.stringify({ tool, arguments: args });
    if (Buffer.byteLength(body) > COS_MAX_BYTES) return unavailable();
    return await new Promise<McpResult>((resolve) => {
      const request = http.request(
        {
          socketPath: socket,
          path: '/tool',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > COS_MAX_BYTES) {
              response.destroy();
              resolve(unavailable());
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', () => resolve(unavailable()));
          response.on('end', () => {
            clearTimeout(timer);
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as McpResult;
              if (
                response.statusCode !== 200 ||
                typeof value.isError !== 'boolean' ||
                !Array.isArray(value.content) ||
                value.content.length !== 1 ||
                value.content[0].type !== 'text' ||
                typeof value.content[0].text !== 'string'
              )
                resolve(unavailable());
              else resolve(value);
            } catch {
              resolve(unavailable());
            }
          });
        },
      );
      const timer = setTimeout(() => {
        request.destroy();
        resolve(unavailable());
      }, COS_WAIT_MS + 2000);
      request.on('error', () => {
        clearTimeout(timer);
        resolve(unavailable());
      });
      request.end(body);
    });
  } catch {
    return unavailable();
  }
}
