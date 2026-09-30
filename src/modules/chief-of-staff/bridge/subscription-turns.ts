/** Native query egress is enabled only inside a host-reserved, bounded turn attempt. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type net from 'node:net';
async function bounded(operation: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 2500);
      }),
    ]);
    // eslint-disable-next-line no-catch-all/no-catch-all -- Authorization errors must close egress without exposing private host details.
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
export async function startSubscriptionTurns(options: {
  socket: string;
  authorize(): Promise<boolean>;
  reserve(attemptId: string): boolean | Promise<boolean>;
}) {
  const parent = path.dirname(options.socket),
    stat = fs.lstatSync(parent);
  if (
    !path.isAbsolute(options.socket) ||
    fs.realpathSync(parent) !== parent ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077 ||
    fs.lstatSync(options.socket, { throwIfNoEntry: false })
  )
    throw new Error('unsafe_subscription_turns');
  let closed = false,
    busy = false;
  let active: { id: string; expires: number } | undefined;
  const clients = new Set<net.Socket>();
  const allowed = async () => {
    const current = active;
    if (closed || !current || current.expires <= Date.now()) {
      active = undefined;
      return false;
    }
    const permitted = await bounded(options.authorize());
    if (closed || active !== current || current.expires <= Date.now() || !permitted) {
      if (active === current) active = undefined;
      return false;
    }
    return true;
  };
  const server = http.createServer(
    { maxHeaderSize: 4096, headersTimeout: 5000, requestTimeout: 10000, keepAliveTimeout: 1000 },
    (request, response) => {
      const reply = (code: number, attemptId?: string) => {
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(code, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          connection: 'close',
        });
        response.end(JSON.stringify(code === 200 ? { version: 1, attemptId } : { error: 'subscription_turn_denied' }));
      };
      if (request.method !== 'POST' || !['/begin', '/end'].includes(request.url ?? '')) {
        reply(404);
        request.resume();
        return;
      }
      let body = '',
        bytes = 0;
      request.on('error', () => response.destroy());
      request.on('data', (data: Buffer) => {
        bytes += data.length;
        if (bytes > 1024) reply(413);
        else body += data.toString();
      });
      request.on('end', () => {
        if (bytes > 1024) return;
        let id: string;
        try {
          const value = JSON.parse(body);
          if (
            !value ||
            Object.keys(value).length !== 1 ||
            typeof value.attemptId !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.attemptId)
          )
            throw new Error('invalid');
          id = value.attemptId;
          // eslint-disable-next-line no-catch-all/no-catch-all -- All malformed socket input is denied at this protocol boundary.
        } catch {
          reply(400);
          return;
        }
        if (request.url === '/end') {
          if (closed || active?.id !== id) {
            reply(409);
            return;
          }
          active = undefined;
          reply(200, id);
          return;
        }
        if (active && active.expires <= Date.now()) active = undefined;
        if (closed || busy || active) {
          reply(409);
          return;
        }
        busy = true;
        void (async () => {
          try {
            if (!(await bounded(options.authorize())) || closed || response.destroyed) {
              reply(403);
              return;
            }
            if (!(await bounded(Promise.resolve(options.reserve(id)))) || closed || response.destroyed) {
              reply(403);
              return;
            }
            // Unknown reservations stay charged. No model egress is opened until
            // authorization is revalidated after the durable reservation.
            if (!(await bounded(options.authorize())) || closed || response.destroyed) {
              reply(403);
              return;
            }
            active = { id, expires: Date.now() + 300000 };
            reply(200, id);
            // eslint-disable-next-line no-catch-all/no-catch-all -- A failed host reservation must never open egress or return private error text.
          } catch {
            reply(403);
          } finally {
            busy = false;
          }
        })();
      });
    },
  );
  server.maxConnections = 4;
  server.on('connection', (client) => {
    clients.add(client);
    client.setTimeout(10000, () => client.destroy());
    client.on('error', () => client.destroy());
    client.once('close', () => clients.delete(client));
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
    allowed,
    async close() {
      if (closed) return;
      closed = true;
      active = undefined;
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
