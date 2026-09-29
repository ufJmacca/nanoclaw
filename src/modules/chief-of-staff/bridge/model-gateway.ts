/** A model-only Unix socket, never a general network proxy. API credentials stay in this host process. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
export type ModelUpstream = (
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<{ status: number; body: AsyncIterable<Uint8Array> }>;
function textOnly(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.every(textOnly);
  const object = value as Record<string, unknown>;
  if (
    typeof object.type === 'string' &&
    [
      'input_image',
      'input_file',
      'image_url',
      'file',
      'computer_call',
      'computer_call_output',
      'item_reference',
    ].includes(object.type)
  )
    return false;
  if (Object.keys(object).some((key) => ['image_url', 'file_id', 'file_url', 'container_id'].includes(key)))
    return false;
  return Object.values(object).every(textOnly);
}
function localTool(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const tool = value as Record<string, unknown>;
  if (tool.type === 'namespace') return Array.isArray(tool.tools) && tool.tools.every(localTool);
  return ['function', 'custom'].includes(String(tool.type));
}
export function modelRequest(value: unknown, model: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const allowed = [
    'model',
    'instructions',
    'input',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'reasoning',
    'stream',
    'store',
    'background',
    'metadata',
    'text',
    'temperature',
    'top_p',
    'max_output_tokens',
    'service_tier',
    'include',
    'truncation',
    'prompt_cache_key',
    'safety_identifier',
  ];
  if (
    body.model !== model ||
    Object.keys(body).some((key) => !allowed.includes(key)) ||
    !textOnly(body.input) ||
    (typeof body.input !== 'string' && !Array.isArray(body.input)) ||
    (body.tools !== undefined && (!Array.isArray(body.tools) || !body.tools.every(localTool)))
  )
    return null;
  // Both fields are host-controlled even if the worker supplies other values.
  return { ...body, model, store: false, background: false, max_output_tokens: 4096, service_tier: 'default' };
}
export async function startModelGateway(options: {
  socket: string;
  model: string;
  apiKey: string;
  authorize(): Promise<boolean>;
  upstream?: ModelUpstream;
}): Promise<{ close(): Promise<void> }> {
  if (
    !path.isAbsolute(options.socket) ||
    fs.realpathSync(path.dirname(options.socket)) !== path.dirname(options.socket) ||
    fs.lstatSync(options.socket, { throwIfNoEntry: false }) ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(options.model) ||
    !options.apiKey
  )
    throw new Error('invalid_model_gateway');
  const parent = fs.statSync(path.dirname(options.socket));
  if (parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) throw new Error('unsafe_model_gateway');
  const upstream: ModelUpstream =
    options.upstream ??
    (async (body, signal) => {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + options.apiKey },
        body: JSON.stringify(body),
      });
      if (!response.body) throw new Error('model_unavailable');
      return { status: response.status, body: response.body };
    });
  let active: symbol | null = null,
    closed = false;
  const aborts = new Set<AbortController>();
  const server = http.createServer(
    { maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 },
    (request, response) => {
      const deny = (status: number) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'model_gateway_denied' }));
      };
      if (closed || request.method !== 'POST' || request.url !== '/v1/responses') {
        deny(404);
        request.resume();
        return;
      }
      if (active) {
        deny(429);
        request.resume();
        return;
      }
      const owner = Symbol('request');
      active = owner;
      const release = () => {
        if (active === owner) active = null;
      };
      let size = 0,
        tooLarge = false;
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 131072) {
          if (!tooLarge) {
            tooLarge = true;
            chunks.length = 0;
            deny(413);
          }
        } else if (!tooLarge) chunks.push(chunk);
      });
      request.on('error', () => {
        release();
        if (!response.writableEnded) response.destroy();
      });
      request.on('end', () => {
        void (async () => {
          let abort: AbortController | undefined;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            if (tooLarge) return;
            let value: unknown;
            try {
              value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              deny(400);
              return;
            }
            const body = modelRequest(value, options.model);
            if (!body) {
              deny(400);
              return;
            }
            abort = new AbortController();
            aborts.add(abort);
            timer = setTimeout(() => abort?.abort(), 60000);
            response.once('close', () => abort?.abort());
            const stopped = new Promise<never>((_resolve, reject) => {
              abort!.signal.addEventListener('abort', () => reject(new Error('model_unavailable')), { once: true });
            });
            if (!(await Promise.race([options.authorize(), stopped]))) {
              deny(403);
              return;
            }
            if (closed || response.destroyed) return;
            const result = await Promise.race([upstream(body, abort.signal), stopped]);
            if (result.status !== 200) {
              deny(502);
              abort.abort();
              return;
            }
            response.writeHead(200, {
              'content-type': body.stream === false ? 'application/json' : 'text/event-stream',
              'cache-control': 'no-store',
            });
            let bytes = 0;
            for await (const chunk of result.body) {
              bytes += chunk.length;
              if (bytes > 8 * 1024 * 1024 || response.destroyed) {
                abort.abort();
                response.destroy();
                return;
              }
              response.write(chunk);
            }
            response.end();
          } catch {
            if (!response.headersSent) deny(503);
            else response.destroy();
          } finally {
            clearTimeout(timer);
            if (abort) aborts.delete(abort);
            release();
          }
        })();
      });
    },
  );
  server.maxConnections = 4;
  server.maxRequestsPerSocket = 4;
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socket, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  fs.chmodSync(options.socket, 0o600);
  return {
    async close() {
      if (closed) return;
      closed = true;
      for (const abort of aborts) abort.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
