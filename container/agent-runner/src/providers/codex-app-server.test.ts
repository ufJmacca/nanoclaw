import { describe, it, expect } from 'bun:test';

import {
  STALE_THREAD_RE,
  attachCodexAutoApproval,
  buildNanoclawWorkflowDynamicTools,
  decodeCodexContinuation,
  encodeCodexContinuation,
  loadNanoclawWorkflowDynamicTools,
  startOrResumeCodexThread,
  tomlBasicString,
  type AppServer,
  type DynamicToolSpec,
  type JsonRpcResponse,
  type JsonRpcServerRequest,
} from './codex-app-server.js';

interface WrittenRpc {
  id: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

function fakeAppServer(): { server: AppServer; writes: WrittenRpc[] } {
  const writes: WrittenRpc[] = [];
  const server = {
    process: {
      stdin: {
        write(line: string) {
          writes.push(JSON.parse(line) as WrittenRpc);
          return true;
        },
      },
      kill() {
        return true;
      },
    },
    readline: {
      close() {},
    },
    pending: new Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>(),
    notificationHandlers: [],
    serverRequestHandlers: [],
  } as unknown as AppServer;

  return { server, writes };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
}

function resolveOutgoingRequest(server: AppServer, request: WrittenRpc, result: unknown): void {
  const pending = server.pending.get(request.id);
  if (!pending) throw new Error(`No pending request for id ${request.id}`);
  pending.resolve({ id: request.id, result });
}

describe('tomlBasicString', () => {
  it('leaves safe strings unchanged inside quotes', () => {
    expect(tomlBasicString('hello')).toBe('"hello"');
    expect(tomlBasicString('bun')).toBe('"bun"');
    expect(tomlBasicString('/usr/local/bin/node')).toBe('"/usr/local/bin/node"');
  });

  it('escapes double-quotes', () => {
    expect(tomlBasicString('a"b')).toBe('"a\\"b"');
    expect(tomlBasicString('"quoted"')).toBe('"\\"quoted\\""');
  });

  it('escapes backslashes', () => {
    expect(tomlBasicString('a\\b')).toBe('"a\\\\b"');
    expect(tomlBasicString('C:\\path\\to\\bin')).toBe('"C:\\\\path\\\\to\\\\bin"');
  });

  it('escapes backslash before quote (order matters)', () => {
    expect(tomlBasicString('\\"')).toBe('"\\\\\\""');
  });

  it('rejects strings containing newlines', () => {
    expect(() => tomlBasicString('line1\nline2')).toThrow(/newline/);
    expect(() => tomlBasicString('trailing\n')).toThrow(/newline/);
    expect(() => tomlBasicString('crlf\r\nhere')).toThrow(/newline/);
  });
});

describe('STALE_THREAD_RE', () => {
  it('matches stale-thread error messages', () => {
    expect(STALE_THREAD_RE.test('thread not found')).toBe(true);
    expect(STALE_THREAD_RE.test('unknown thread xyz')).toBe(true);
    expect(STALE_THREAD_RE.test('No such thread: abc')).toBe(true);
    expect(STALE_THREAD_RE.test('invalid thread_id')).toBe(true);
  });

  it('does not match transient or unrelated errors', () => {
    expect(STALE_THREAD_RE.test('rate limit exceeded')).toBe(false);
    expect(STALE_THREAD_RE.test('authentication failed')).toBe(false);
    expect(STALE_THREAD_RE.test('connection reset by peer')).toBe(false);
    expect(STALE_THREAD_RE.test('internal server error')).toBe(false);
  });
});

describe('Codex dynamic MCP bridge', () => {
  it('encodes continuations and refreshes pre-bridge thread IDs', () => {
    const encoded = encodeCodexContinuation('thread-123');

    expect(decodeCodexContinuation(encoded)).toEqual({
      threadId: 'thread-123',
      refreshRequired: false,
    });
    expect(decodeCodexContinuation('thread-before-bridge')).toEqual({
      threadId: undefined,
      refreshRequired: true,
    });
    expect(decodeCodexContinuation(undefined)).toEqual({
      threadId: undefined,
      refreshRequired: false,
    });
  });

  it('converts only NanoClaw deep-research MCP tools into dynamic tools', () => {
    const dynamicTools = buildNanoclawWorkflowDynamicTools({
      data: [
        {
          name: 'other',
          tools: {
            initialize_run: {
              description: 'wrong server',
              inputSchema: { type: 'object' },
            },
          },
        },
        {
          name: 'nanoclaw',
          tools: {
            send_message: {
              description: 'not part of the workflow',
              inputSchema: { type: 'object' },
            },
            initialize_run: {
              description: 'Initialize workflow run',
              inputSchema: { type: 'object', properties: { root: { type: 'string' } } },
            },
            final_audit: {
              description: 'Audit final answer',
              inputSchema: 'invalid schema',
            },
          },
        },
      ],
    });

    expect(dynamicTools).toHaveLength(1);
    const namespace = dynamicTools[0];
    expect(namespace.type).toBe('namespace');
    if (namespace.type !== 'namespace') throw new Error('Expected a dynamic tool namespace');
    expect(namespace.name).toBe('nanoclaw');
    expect(namespace.tools.map((tool) => tool.name).sort()).toEqual(['final_audit', 'initialize_run']);
    expect(namespace.tools.find((tool) => tool.name === 'initialize_run')?.inputSchema).toEqual({
      type: 'object',
      properties: { root: { type: 'string' } },
    });
    expect(namespace.tools.find((tool) => tool.name === 'final_audit')?.inputSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('omits params for MCP reload and returns the discovered namespace', async () => {
    const { server, writes } = fakeAppServer();
    const loading = loadNanoclawWorkflowDynamicTools(server, { attempts: 1, delayMs: 0 });

    await waitFor(() => writes.some((write) => write.method === 'config/mcpServer/reload'));
    const reload = writes.find((write) => write.method === 'config/mcpServer/reload')!;
    expect(reload.params).toBeUndefined();
    resolveOutgoingRequest(server, reload, {});

    await waitFor(() => writes.some((write) => write.method === 'mcpServerStatus/list'));
    const list = writes.find((write) => write.method === 'mcpServerStatus/list')!;
    resolveOutgoingRequest(server, list, {
      data: [
        {
          name: 'nanoclaw',
          tools: {
            initialize_run: {
              description: 'Initialize workflow run',
              inputSchema: { type: 'object', properties: {} },
            },
          },
        },
      ],
      nextCursor: null,
    });

    const dynamicTools = await loading;
    expect(dynamicTools).toHaveLength(1);
    expect(dynamicTools[0]).toMatchObject({
      type: 'namespace',
      name: 'nanoclaw',
    });
  });

  it('routes namespaced NanoClaw dynamic calls through mcpServer/tool/call', async () => {
    const { server, writes } = fakeAppServer();
    attachCodexAutoApproval(server);

    const request: JsonRpcServerRequest = {
      id: 77,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-abc',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: 'nanoclaw',
        tool: 'initialize_run',
        arguments: { root: '/workspace/agent/research/demo' },
      },
    };

    server.serverRequestHandlers[0](request);

    await waitFor(() => writes.some((write) => write.method === 'mcpServer/tool/call'));
    const mcpCall = writes.find((write) => write.method === 'mcpServer/tool/call')!;
    expect(mcpCall.params).toEqual({
      threadId: 'thread-abc',
      server: 'nanoclaw',
      tool: 'initialize_run',
      arguments: { root: '/workspace/agent/research/demo' },
    });

    resolveOutgoingRequest(server, mcpCall, {
      content: [{ type: 'text', text: '{"ok":true}' }],
      isError: false,
    });

    await waitFor(() => writes.some((write) => write.id === 77 && write.result !== undefined));
    const response = writes.find((write) => write.id === 77 && write.result !== undefined)!;
    expect(response.result).toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: '{"ok":true}' }],
    });
  });

  it('maps MCP tool errors to failed dynamic tool responses', async () => {
    const { server, writes } = fakeAppServer();
    attachCodexAutoApproval(server);

    server.serverRequestHandlers[0]({
      id: 78,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-abc',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: 'nanoclaw',
        tool: 'final_audit',
        arguments: {},
      },
    });

    await waitFor(() => writes.some((write) => write.method === 'mcpServer/tool/call'));
    const mcpCall = writes.find((write) => write.method === 'mcpServer/tool/call')!;
    resolveOutgoingRequest(server, mcpCall, {
      content: [{ type: 'text', text: 'not allowed yet' }],
      isError: true,
    });

    await waitFor(() => writes.some((write) => write.id === 78 && write.result !== undefined));
    const response = writes.find((write) => write.id === 78 && write.result !== undefined)!;
    expect(response.result).toEqual({
      success: false,
      contentItems: [{ type: 'inputText', text: 'not allowed yet' }],
    });
  });

  it('keeps dynamicTools on thread/start but omits them from thread/resume', async () => {
    const dynamicTools: DynamicToolSpec[] = [
      {
        type: 'namespace',
        name: 'nanoclaw',
        description: 'NanoClaw deep-research workflow tools.',
        tools: [
          {
            type: 'function',
            name: 'initialize_run',
            description: 'Initialize workflow run',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    ];

    {
      const { server, writes } = fakeAppServer();
      const start = startOrResumeCodexThread(server, undefined, {
        model: 'gpt-test',
        cwd: '/workspace/agent',
        dynamicTools,
      });

      await waitFor(() => writes.some((write) => write.method === 'thread/start'));
      const request = writes.find((write) => write.method === 'thread/start')!;
      expect(request.params?.dynamicTools).toEqual(dynamicTools);
      resolveOutgoingRequest(server, request, { thread: { id: 'new-thread' } });
      expect(await start).toBe('new-thread');
    }

    {
      const { server, writes } = fakeAppServer();
      const resume = startOrResumeCodexThread(server, 'existing-thread', {
        model: 'gpt-test',
        cwd: '/workspace/agent',
        dynamicTools,
      });

      await waitFor(() => writes.some((write) => write.method === 'thread/resume'));
      const request = writes.find((write) => write.method === 'thread/resume')!;
      expect(request.params?.dynamicTools).toBeUndefined();
      resolveOutgoingRequest(server, request, { thread: { id: 'existing-thread' } });
      expect(await resume).toBe('existing-thread');
    }
  });
});
