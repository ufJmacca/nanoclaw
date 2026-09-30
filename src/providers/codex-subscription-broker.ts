import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type net from 'node:net';
import type { SubscriptionCredentialSnapshot } from './codex-subscription-auth.js';

type Store = {
  cached(): SubscriptionCredentialSnapshot;
  refresh(generation: string): Promise<SubscriptionCredentialSnapshot>;
};

function safeSnapshot(snapshot: SubscriptionCredentialSnapshot): boolean {
  if (!/^[a-f0-9]{64}$/.test(snapshot.generation) || snapshot.authJson.length > 262144) return false;
  const auth = JSON.parse(snapshot.authJson),
    tokens = auth?.tokens;
  return (
    auth?.auth_mode === 'chatgpt' &&
    auth.OPENAI_API_KEY == null &&
    tokens?.refresh_token === '' &&
    ['access_token', 'id_token', 'account_id'].every(
      (key) => typeof tokens[key] === 'string' && tokens[key].length > 0 && tokens[key].length <= 65536,
    ) &&
    Object.keys(tokens).every((key) => ['access_token', 'id_token', 'account_id', 'refresh_token'].includes(key)) &&
    Object.keys(auth).every((key) => ['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh'].includes(key))
  );
}

/** One socket belongs to one admitted session. No account/scope/path can be selected by its client. */
export async function startSubscriptionBroker(options: {
  socket: string;
  store: Store;
  authorize(): Promise<boolean>;
}) {
  const parent = path.dirname(options.socket),
    stat = fs.lstatSync(parent);
  if (
    !path.isAbsolute(options.socket) ||
    fs.realpathSync(parent) !== parent ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    fs.existsSync(options.socket)
  )
    throw new Error('unsafe_subscription_broker');
  let closed = false,
    busy = false;
  const clients = new Set<net.Socket>();
  const server = http.createServer(
    { maxHeaderSize: 4096, headersTimeout: 5000, requestTimeout: 30000, keepAliveTimeout: 1000 },
    (request, response) => {
      const reply = (status: number, value: unknown) => {
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(status, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          connection: 'close',
        });
        response.end(JSON.stringify(value));
      };
      if (request.method !== 'POST') {
        reply(405, { error: 'method_refused' });
        request.resume();
        return;
      }
      if (!['/cached', '/refresh'].includes(request.url ?? '')) {
        reply(404, { error: 'operation_refused' });
        request.resume();
        return;
      }
      let body = '',
        bytes = 0;
      request.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024) reply(413, { error: 'request_too_large' });
        else body += chunk.toString();
      });
      request.on('error', () => response.destroy());
      request.on('end', () => {
        if (bytes > 1024) return;
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(body);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          reply(400, { error: 'invalid_request' });
          return;
        }
        if (
          !input ||
          Array.isArray(input) ||
          typeof input !== 'object' ||
          (request.url === '/cached'
            ? Object.keys(input).length !== 0
            : Object.keys(input).length !== 1 ||
              typeof input.generation !== 'string' ||
              !/^[a-f0-9]{64}$/.test(input.generation))
        ) {
          reply(400, { error: 'invalid_request' });
          return;
        }
        if (closed || busy) {
          reply(503, { error: 'subscription_unavailable' });
          return;
        }
        busy = true;
        void (async () => {
          try {
            if (!(await options.authorize()) || closed) {
              reply(403, { error: 'authorization_revoked' });
              return;
            }
            const snapshot =
              request.url === '/cached'
                ? options.store.cached()
                : await options.store.refresh(input.generation as string);
            if (!(await options.authorize()) || closed) {
              reply(403, { error: 'authorization_revoked' });
              return;
            }
            if (!safeSnapshot(snapshot)) throw new Error('unsafe_subscription_snapshot');
            reply(200, { version: 1, ...snapshot });
            // eslint-disable-next-line no-catch-all/no-catch-all -- Credential errors must not cross the session boundary or be logged with raw causes.
          } catch (error) {
            reply(error instanceof Error && error.message === 'subscription_refresh_limited' ? 429 : 503, {
              error: 'subscription_unavailable',
            });
          } finally {
            busy = false;
          }
        })();
      });
    },
  );
  server.maxConnections = 4;
  server.on('connection', (socket) => {
    clients.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => clients.delete(socket));
    socket.setTimeout(35000, () => socket.destroy());
  });
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
      for (const socket of clients) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
