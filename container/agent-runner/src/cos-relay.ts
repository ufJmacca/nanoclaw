import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Loopback adapter inside a network-none worker. The host socket is the only destination. */
export async function startCosRelay(socketPath = '/run/cos/model.sock', port = 8787) {
  const pending = new Set<http.ClientRequest>();
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 5000 }, (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404);
      response.end();
      request.resume();
      return;
    }
    const upstream = http.request(
      {
        socketPath,
        path: '/v1/responses',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        timeout: 65000,
      },
      (result) => {
        response.writeHead(result.statusCode ?? 503, {
          'content-type':
            result.headers['content-type'] === 'application/json' ? 'application/json' : 'text/event-stream',
          'cache-control': 'no-store',
        });
        result.on('error', () => response.destroy());
        result.pipe(response);
      },
    );
    pending.add(upstream);
    upstream.on('close', () => pending.delete(upstream));
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => {
      if (!response.headersSent) {
        response.writeHead(503);
        response.end();
      } else response.destroy();
    });
    response.on('close', () => upstream.destroy());
    request.on('error', () => upstream.destroy());
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        request.unpipe(upstream);
        upstream.destroy();
        request.resume();
      }
    });
    request.pipe(upstream);
  });
  server.maxConnections = 4;
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    async close() {
      for (const request of pending) request.destroy();
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await closed;
    },
  };
}
